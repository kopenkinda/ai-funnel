package funnel

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type ResetCredit struct {
	Attempt   *ResetAttempt `json:"attempt,omitempty"`
	ID        string        `json:"id"`
	Status    string        `json:"status"`
	ResetType string        `json:"reset_type"`
	ExpiresAt time.Time     `json:"expires_at"`
}
type ResetAttempt struct {
	At     time.Time `json:"at"`
	Result string    `json:"result"`
	Error  string    `json:"error,omitempty"`
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
		if credit.Status == "available" && credit.ResetType == "codex_rate_limits" && credit.ExpiresAt.After(at) {
			result = append(result, credit)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ExpiresAt.Before(result[j].ExpiresAt) })
	return result
}
func (a *App) fetchCredits(ctx context.Context, auth *core.Auth, previous *ResetCredits) *ResetCredits {
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
		conn := d.Connections["codex"]
		if auth.Provider != "codex" || auth.Disabled || !conn.Enabled {
			continue
		}
		old := d.Snapshots[auth.ID].ResetCredits
		due := old == nil || old.CheckedAt == nil
		if old != nil {
			for _, c := range activeCredits(old.Items, now()) {
				if !c.ExpiresAt.After(now().Add(5 * time.Minute)) {
					due = true
					break
				}
			}
		}
		if !due {
			continue
		}
		credits := a.fetchCredits(ctx, auth, old)
		_ = a.store.change(func(d *diskState) error {
			s := d.Snapshots[auth.ID]
			s.ResetCredits = credits
			d.Snapshots[auth.ID] = s
			return nil
		})
		if credits.Error != "" {
			continue
		}
		for _, credit := range credits.Items {
			current := a.store.read()
			attempt := current.ResetAttempts[auth.ID+"|"+credit.ID]
			if !current.Settings.AutoUseResets || ctx.Err() != nil {
				return
			}
			if !credit.ExpiresAt.After(now()) || credit.ExpiresAt.After(now().Add(5*time.Minute)) || terminalReset(attempt.Result) || (!attempt.At.IsZero() && now().Sub(attempt.At) < 30*time.Second) {
				continue
			}
			latest, ok := a.core.GetByID(auth.ID)
			if !current.Connections["codex"].Enabled || !ok || latest.Disabled {
				break
			}
			_, _, _ = a.consumeResetLocked(ctx, latest, credit.ID)
			// A reset affects all current limits. Only try one credit per account per tick.
			break
		}
	}
}
