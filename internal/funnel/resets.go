package funnel

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type ResetCredit struct {
	Attempt   *ResetAttempt `json:"attempt,omitempty"`
	ID        string        `json:"id"`
	Status    string        `json:"status"`
	ResetType string        `json:"reset_type"`
	ExpiresAt *time.Time    `json:"expires_at,omitempty"`
	Remaining *int          `json:"resets_left,omitempty"`
	UsableNow bool          `json:"usable_now,omitempty"`
}
type ResetAttempt struct {
	At        time.Time `json:"at"`
	Result    string    `json:"result"`
	Error     string    `json:"error,omitempty"`
	RequestID string    `json:"requestId,omitempty"`
	Remaining int       `json:"remaining,omitempty"`
}

func (c ResetCredit) count() int {
	if c.Remaining != nil {
		return max(0, *c.Remaining)
	}
	return 1
}

func resetAttemptBlocks(credit ResetCredit, attempt ResetAttempt) bool {
	return terminalReset(attempt.Result) && (credit.ResetType != "claude_rate_limits" || credit.count() >= attempt.Remaining)
}

// Match T3 Code's idempotency key so a hub client and the scheduler can safely
// race or retry the same credit, including across process restarts.
func resetRequestID(accountID, creditID string) string {
	namespace := uuid.UUID{111, 28, 42, 158, 45, 75, 76, 30, 154, 127, 59, 141, 94, 12, 26, 66}
	return uuid.NewSHA1(namespace, []byte(accountID+":"+creditID)).String()
}
func activeCredits(items []ResetCredit, at time.Time) []ResetCredit {
	result := []ResetCredit{}
	for _, credit := range items {
		if credit.Status == "available" && credit.count() > 0 && (credit.ResetType == "codex_rate_limits" || credit.ResetType == "claude_rate_limits") && (credit.ExpiresAt == nil || credit.ExpiresAt.After(at)) {
			result = append(result, credit)
		}
	}
	sort.SliceStable(result, func(i, j int) bool {
		return result[i].ExpiresAt != nil && (result[j].ExpiresAt == nil || result[i].ExpiresAt.Before(*result[j].ExpiresAt))
	})
	return result
}
func (a *App) fetchCredits(ctx context.Context, auth *core.Auth, previous *ResetCredits) *ResetCredits {
	if auth.Provider == "claude" {
		return a.fetchClaudeCredits(ctx, auth, previous)
	}
	credits := ResetCredits{Items: []ResetCredit{}}
	if previous != nil {
		credits = *previous
	}
	status, body, err := a.accountRequest(ctx, auth, "GET", resetCreditURL, nil)
	var data struct {
		Credits []ResetCredit `json:"credits"`
	}
	if err != nil || status != 200 || json.Unmarshal(body, &data) != nil || data.Credits == nil {
		credits.Error = "Reset expiration lookup unavailable. Automatic redemption requires a successful lookup."
		return &credits
	}
	credits.Items = activeCredits(data.Credits, now())
	credits.Available = len(credits.Items)
	credits.Error = ""
	t := now()
	credits.CheckedAt = &t
	return &credits
}
func terminalReset(result string) bool {
	return result == "reset" || result == "already_redeemed" || result == "no_credit"
}

func (a *App) resetAccount(c *gin.Context, id string) {
	var b struct {
		CreditID  string `json:"creditId"`
		RequestID string `json:"requestId"`
	}
	if !decode(c, &b) {
		return
	}
	if _, err := uuid.Parse(b.RequestID); err != nil || b.CreditID == "" || len(b.CreditID) > 256 {
		fail(c, 400, "Supply a banked reset and request ID.")
		return
	}
	a.resetMu.Lock()
	defer a.resetMu.Unlock()
	auth, ok := a.core.GetByID(id)
	if !ok || auth.Disabled || (auth.Provider != "codex" && auth.Provider != "claude") {
		fail(c, 404, "Account unavailable.")
		return
	}
	d := a.store.read()
	conn := d.Connections[auth.Provider]
	if !conn.Enabled {
		fail(c, 409, "This connection is paused.")
		return
	}
	previous := d.ResetAttempts[id+"|"+b.CreditID]
	if previous.Result != "" && ((auth.Provider == "codex" && terminalReset(previous.Result)) || previous.RequestID == b.RequestID) {
		c.JSON(200, gin.H{"result": previous.Result})
		return
	}
	credits := a.fetchCredits(c.Request.Context(), auth, d.Snapshots[id].ResetCredits)
	if !a.save(c, func(d *diskState) error {
		snap := d.Snapshots[id]
		snap.ResetCredits = credits
		d.Snapshots[id] = snap
		return nil
	}) {
		return
	}
	if credits.Error != "" {
		fail(c, 502, "Banked reset lookup unavailable.")
		return
	}
	var selected *ResetCredit
	for _, credit := range activeCredits(credits.Items, now()) {
		if credit.ID == b.CreditID && !resetAttemptBlocks(credit, previous) {
			selected = &credit
			break
		}
	}
	if selected == nil {
		fail(c, 409, "This banked reset is no longer available.")
		return
	}
	var err error
	if auth.Provider == "claude" {
		if !selected.UsableNow {
			fail(c, 409, "The provider cannot use this reset right now.")
			return
		}
		err = a.consumeClaudeResetLocked(c.Request.Context(), auth, *selected, b.RequestID)
	} else {
		_, _, err = a.consumeResetLocked(c.Request.Context(), auth, selected.ID)
	}
	if err != nil {
		fail(c, 502, "Provider reset request failed.")
		return
	}
	result := a.store.read().ResetAttempts[id+"|"+b.CreditID].Result
	if result == "" {
		fail(c, 409, "The reset could not be applied. Refresh and try again.")
		return
	}
	a.refresh(c.Request.Context(), conn)
	c.JSON(200, gin.H{"result": result})
}

func (a *App) consumeReset(ctx context.Context, auth *core.Auth, creditID string) (int, []byte, error) {
	a.resetMu.Lock()
	defer a.resetMu.Unlock()
	return a.consumeResetLocked(ctx, auth, creditID)
}
func (a *App) consumeResetLocked(ctx context.Context, auth *core.Auth, creditID string) (int, []byte, error) {
	key := auth.ID + "|" + creditID
	previous := a.store.read().ResetAttempts[key]
	if terminalReset(previous.Result) {
		body, _ := json.Marshal(map[string]string{"code": previous.Result})
		return 200, body, nil
	}
	accountID := str(auth.Metadata["account_id"])
	if accountID == "" {
		accountID = auth.ID
	}
	payload, _ := json.Marshal(map[string]string{"credit_id": creditID, "redeem_request_id": resetRequestID(accountID, creditID)})
	// Persist before sending, so a failed save cannot cause an untracked reset.
	if err := a.store.change(func(d *diskState) error {
		if d.ResetAttempts == nil {
			d.ResetAttempts = map[string]ResetAttempt{}
		}
		d.ResetAttempts[key] = ResetAttempt{At: now()}
		return nil
	}); err != nil {
		return 0, nil, err
	}
	status, body, err := a.accountRequest(ctx, auth, "POST", resetCreditURL+"/consume", payload)
	attempt := ResetAttempt{At: now()}
	var response struct {
		Code string `json:"code"`
	}
	if err != nil || status != 200 || json.Unmarshal(body, &response) != nil || (response.Code != "nothing_to_reset" && !terminalReset(response.Code)) {
		attempt.Error = "Reset request failed. Will retry before expiry."
	} else {
		attempt.Result = response.Code
	}
	saveErr := a.store.change(func(d *diskState) error { d.ResetAttempts[key] = attempt; return nil })
	if attempt.Result == "reset" {
		// The provider reset invalidates the SDK's cached rate-limit cooldown.
		// Use its mutation API so routing and persisted cooldowns agree.
		if _, _, quotaErr := a.core.ResetQuota(ctx, auth.ID); quotaErr != nil {
			return status, body, fmt.Errorf("reset applied, but local cooldown could not be cleared: %w", quotaErr)
		}
	}
	if err != nil {
		return status, body, err
	}
	if saveErr != nil {
		return status, body, saveErr
	}
	if attempt.Error != "" {
		return status, body, fmt.Errorf("reset request unsuccessful")
	}
	return status, body, nil
}

// Tick every 15 seconds independently of quota refreshes. Nothing runs while
// disabled, and expiry is always checked again immediately before redemption.
func (a *App) CheckExpiringResets(ctx context.Context) {
	if !a.resetMu.TryLock() {
		return
	}
	defer a.resetMu.Unlock()
	d := a.store.read()
	if !d.Settings.AutoUseResets {
		return
	}
	for _, auth := range a.core.List() {
		conn := d.Connections[auth.Provider]
		if (auth.Provider != "codex" && auth.Provider != "claude") || auth.Disabled || !conn.Enabled {
			continue
		}
		old := d.Snapshots[auth.ID].ResetCredits
		due := old == nil || old.CheckedAt == nil || old.Error != ""
		if old != nil {
			for _, c := range activeCredits(old.Items, now()) {
				if c.ExpiresAt != nil && !c.ExpiresAt.After(now().Add(5*time.Minute)) {
					due = true
					break
				}
			}
		}
		if !due {
			continue
		}
		credits := a.fetchCredits(ctx, auth, old)
		if err := a.store.change(func(d *diskState) error {
			s := d.Snapshots[auth.ID]
			s.ResetCredits = credits
			d.Snapshots[auth.ID] = s
			return nil
		}); err != nil {
			continue
		}
		if credits.Error != "" {
			continue
		}
		for _, credit := range credits.Items {
			current := a.store.read()
			attempt := current.ResetAttempts[auth.ID+"|"+credit.ID]
			if !current.Settings.AutoUseResets || ctx.Err() != nil {
				return
			}
			if credit.ExpiresAt == nil || !credit.ExpiresAt.After(now()) || credit.ExpiresAt.After(now().Add(5*time.Minute)) || resetAttemptBlocks(credit, attempt) || (!attempt.At.IsZero() && now().Sub(attempt.At) < 30*time.Second) || (auth.Provider == "claude" && !credit.UsableNow) {
				continue
			}
			latest, ok := a.core.GetByID(auth.ID)
			if !current.Connections[auth.Provider].Enabled || !ok || latest.Disabled {
				break
			}
			if auth.Provider == "claude" {
				_ = a.consumeClaudeResetLocked(ctx, latest, credit, "")
			} else {
				_, _, _ = a.consumeResetLocked(ctx, latest, credit.ID)
			}
			// A reset affects all current limits. Only try one credit per account per tick.
			break
		}
	}
}
