package funnel

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

const (
	resetCreditURL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
	codexUsageURL  = "https://chatgpt.com/backend-api/wham/usage"
	hubClaudeURL   = "https://api.anthropic.com/api/oauth/usage"
	// The OAuth usage endpoint can answer 429 without a Claude Code user agent.
	claudeUserAgent = "claude-code/2.1.273"
	// Snapshots refresh every two minutes; anything much older means refresh stalled.
	hubMaxAge = 10 * time.Minute
	hubBudget = 13 * time.Second
)

// hubAccess is what one hub bearer may see and do. The global hub key and the
// dashboard key have no key: they see every account with live provider reads.
// A per-key hub sees only its key's assigned accounts, under opaque IDs, and
// reads the cached usage snapshots instead of calling providers.
type hubAccess struct {
	key *Key
	d   diskState
}

func (a *App) hubAccess(value string) (hubAccess, bool) {
	if value == "" {
		return hubAccess{}, false
	}
	d := a.store.read()
	hash := digest(value)
	if hash == d.Settings.HubTokenHash || hash == digest(a.store.Admin) {
		return hubAccess{d: d}, true
	}
	for _, k := range d.Keys {
		if k.HubHash != "" && k.HubHash == hash && k.ArchivedAt == nil && (k.ExpiresAt == nil || k.ExpiresAt.After(now())) {
			return hubAccess{key: &k, d: d}, true
		}
	}
	return hubAccess{}, false
}

// visible follows the key's grants, not live routing eligibility, so quota stays
// visible while an account is exhausted or the key is paused.
func (h hubAccess) visible(auth *core.Auth) bool {
	if auth.Provider != "codex" && auth.Provider != "claude" {
		return false
	}
	if h.key == nil {
		return true
	}
	if auth.Disabled {
		return false
	}
	for _, g := range h.key.Grants {
		conn, ok := h.d.Connections[g.ConnectionID]
		if ok && conn.Provider == auth.Provider && (g.AccountIDs == nil || contains(g.AccountIDs, auth.ID)) {
			return true
		}
	}
	return false
}

// redeem matches dashboard redemption: the connection must be running, and a
// per-key hub additionally needs an active key with reset redemption allowed.
func (h hubAccess) redeem(auth *core.Auth) bool {
	if auth.Provider != "codex" || auth.Disabled || !h.visible(auth) || !h.d.Connections[auth.Provider].Enabled {
		return false
	}
	return h.key == nil || (h.key.Enabled && h.key.HubResets)
}

func (h hubAccess) index(auth *core.Auth) string {
	if h.key == nil {
		return auth.ID
	}
	return "acct-" + digest(h.key.ID + "|" + auth.ID)[:16]
}

func (h hubAccess) file(auth *core.Auth) gin.H {
	plan := h.d.Snapshots[auth.ID].Plan
	if plan == "" {
		plan = str(auth.Metadata["plan_type"])
	}
	id := h.index(auth)
	if h.key == nil {
		return gin.H{"id": id, "auth_index": id, "provider": auth.Provider, "email": str(auth.Metadata["email"]), "disabled": auth.Disabled, "id_token": gin.H{"chatgpt_account_id": str(auth.Metadata["account_id"]), "plan_type": plan}}
	}
	email := map[string]string{"codex": "Codex", "claude": "Claude"}[auth.Provider] + " account " + id[5:11]
	if h.key.HubEmails && str(auth.Metadata["email"]) != "" {
		email = str(auth.Metadata["email"])
	}
	return gin.H{"id": id, "auth_index": id, "provider": auth.Provider, "email": email, "disabled": false, "id_token": gin.H{"plan_type": plan}}
}

func (a *App) hubAccount(h hubAccess, index string) (*core.Auth, bool) {
	for _, auth := range a.core.List() {
		if h.visible(auth) && h.index(auth) == index {
			return auth, true
		}
	}
	return nil, false
}

// The T3 hub contract is deliberately narrower than SDK management. It never
// exports credentials or permits arbitrary outbound requests.
func (a *App) hub(c *gin.Context) {
	h, ok := a.hubAccess(bearer(c.Request))
	if !ok {
		fail(c, 401, "Supply a valid usage hub key.")
		return
	}
	path := strings.TrimPrefix(c.Request.URL.Path, "/v0/management/")
	if path == "auth-files" && c.Request.Method == "GET" {
		auths := a.core.List()
		sort.Slice(auths, func(i, j int) bool { return auths[i].ID < auths[j].ID })
		files := []gin.H{}
		for _, auth := range auths {
			if h.visible(auth) {
				files = append(files, h.file(auth))
			}
		}
		c.JSON(200, gin.H{"files": files})
		return
	}
	if (path != "api-call" && path != "reset-quota") || c.Request.Method != "POST" {
		fail(c, 404, "Hub route not available.")
		return
	}
	var b struct {
		AuthIndex string `json:"auth_index"`
		Method    string `json:"method"`
		URL       string `json:"url"`
		Data      string `json:"data"`
	}
	if !decode(c, &b) {
		return
	}
	// A slow body must not outlive a revoked or edited key, so resolve it again.
	if h, ok = a.hubAccess(bearer(c.Request)); !ok {
		fail(c, 401, "Supply a valid usage hub key.")
		return
	}
	auth, ok := a.hubAccount(h, b.AuthIndex)
	if !ok || auth.Disabled {
		fail(c, 404, "Account unavailable.")
		return
	}
	if path == "reset-quota" {
		a.hubResetQuota(c, auth.ID)
		return
	}
	switch {
	case b.Method == "GET" && auth.Provider == "codex" && b.URL == codexUsageURL,
		b.Method == "GET" && auth.Provider == "claude" && b.URL == hubClaudeURL:
		a.hubUsage(c, h, auth, b.URL)
	case b.Method == "GET" && auth.Provider == "codex" && b.URL == resetCreditURL:
		a.hubCredits(c, h, auth)
	case b.Method == "POST" && auth.Provider == "codex" && b.URL == resetCreditURL+"/consume":
		var payload struct {
			CreditID string `json:"credit_id"`
		}
		if json.Unmarshal([]byte(b.Data), &payload) != nil || payload.CreditID == "" || len(payload.CreditID) > 256 {
			fail(c, 400, "Supply a banked reset.")
			return
		}
		a.hubConsume(c, auth.ID, payload.CreditID)
	default:
		fail(c, 403, "Only provider usage and reset-credit operations are allowed.")
	}
}

// lockBefore waits for mu until the deadline, because T3 Code abandons hub calls
// after 15 seconds and dashboard redemption can hold the reset lock for longer.
func lockBefore(mu *sync.Mutex, deadline time.Time) bool {
	for !mu.TryLock() {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(50 * time.Millisecond)
	}
	return true
}

func hubResult(c *gin.Context, status int, body []byte) {
	c.JSON(200, gin.H{"status_code": status, "body": string(body)})
}

func (a *App) hubUsage(c *gin.Context, h hubAccess, auth *core.Auth, target string) {
	if h.key != nil {
		// A failed or stalled refresh must read as unavailable, not as frozen quota.
		snap := h.d.Snapshots[auth.ID]
		if len(snap.Hub) == 0 || snap.Error != "" || now().Sub(snap.At) > hubMaxAge {
			hubResult(c, 503, nil)
			return
		}
		hubResult(c, 200, snap.Hub)
		return
	}
	status, body, err := a.accountRequest(c.Request.Context(), auth, "GET", target, nil)
	if err != nil {
		fail(c, 502, "Provider usage request failed.")
		return
	}
	hubResult(c, status, body)
}

// Credits are listed only to bearers that may redeem them, so T3 Code never
// offers a reset button that would be refused.
func (a *App) hubCredits(c *gin.Context, h hubAccess, auth *core.Auth) {
	if !h.redeem(auth) {
		hubResult(c, 403, nil)
		return
	}
	if h.key == nil {
		status, body, err := a.accountRequest(c.Request.Context(), auth, "GET", resetCreditURL, nil)
		if err != nil {
			fail(c, 502, "Provider reset request failed.")
			return
		}
		hubResult(c, status, body)
		return
	}
	cached := h.d.Snapshots[auth.ID].ResetCredits
	if cached == nil || cached.CheckedAt == nil || cached.Error != "" {
		hubResult(c, 503, nil)
		return
	}
	type credit struct {
		ID        string `json:"id"`
		Status    string `json:"status"`
		ResetType string `json:"reset_type"`
		ExpiresAt string `json:"expires_at"`
	}
	credits := []credit{}
	for _, item := range activeCredits(cached.Items, now()) {
		if item.ExpiresAt == nil || resetAttemptBlocks(item, h.d.ResetAttempts[auth.ID+"|"+item.ID]) {
			continue
		}
		credits = append(credits, credit{item.ID, item.Status, item.ResetType, item.ExpiresAt.Format(time.RFC3339)})
	}
	body, _ := json.Marshal(gin.H{"credits": credits})
	hubResult(c, 200, body)
}

func (a *App) hubConsume(c *gin.Context, id, creditID string) {
	// T3 Code gives up after 15 seconds. Waiting, redeeming and refreshing all
	// share one budget so the verdict gets back in time.
	deadline := time.Now().Add(hubBudget)
	// Leave the provider at least five seconds to answer the redemption.
	if !lockBefore(&a.resetMu, deadline.Add(-5*time.Second)) {
		fail(c, 503, "Another reset is in progress. Try again.")
		return
	}
	defer a.resetMu.Unlock()
	// The key, connection and account can all change while waiting on the lock.
	h, ok := a.hubAccess(bearer(c.Request))
	auth, found := a.core.GetByID(id)
	if !ok || !found || !h.redeem(auth) {
		fail(c, 403, "This hub key can't redeem resets.")
		return
	}
	replay := terminalReset(h.d.ResetAttempts[auth.ID+"|"+creditID].Result)
	ctx, cancel := context.WithDeadline(c.Request.Context(), deadline)
	defer cancel()
	status, body, err := a.consumeResetLocked(ctx, auth, creditID)
	var response struct {
		Code string `json:"code"`
	}
	answered := status == 200 && json.Unmarshal(body, &response) == nil && (response.Code == "nothing_to_reset" || terminalReset(response.Code))
	if answered && response.Code == "reset" && !replay {
		// T3 Code rereads usage right after redeeming, so wait for this account's
		// refresh while the budget lasts. It runs on its own context, so a late
		// finish still lands instead of being cut short.
		done := make(chan struct{})
		go func() {
			defer close(done)
			refreshCtx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			a.refreshAccount(refreshCtx, h.d.Connections[auth.Provider], auth)
		}()
		select {
		case <-done:
		case <-time.After(time.Until(deadline)):
		}
	}
	// A provider verdict is final even if local bookkeeping failed afterwards.
	if answered {
		out, _ := json.Marshal(gin.H{"code": response.Code})
		hubResult(c, 200, out)
		return
	}
	if err != nil && status == 0 {
		fail(c, 502, "Provider reset request failed.")
		return
	}
	if status == 200 {
		// The provider accepted the call but gave no recognisable verdict.
		status = 502
	}
	hubResult(c, status, nil)
}

// Redemption already clears the SDK cooldown. This acknowledges T3 Code's
// follow-up call and clears it again in case local cleanup failed.
func (a *App) hubResetQuota(c *gin.Context, id string) {
	if !lockBefore(&a.resetMu, time.Now().Add(hubBudget)) {
		fail(c, 503, "Another reset is in progress. Try again.")
		return
	}
	defer a.resetMu.Unlock()
	h, ok := a.hubAccess(bearer(c.Request))
	auth, found := a.core.GetByID(id)
	if !ok || !found || !h.redeem(auth) {
		fail(c, 403, "This hub key can't redeem resets.")
		return
	}
	if _, _, err := a.core.ResetQuota(c.Request.Context(), auth.ID); err != nil {
		fail(c, 502, "Could not clear the account cooldown.")
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// providerHeaders adds what the providers expect from their own clients: the
// ChatGPT workspace for multi-workspace logins, and Claude Code's user agent.
func providerHeaders(r *http.Request, auth *core.Auth) {
	r.Header.Set("Content-Type", "application/json")
	if auth.Provider == "codex" {
		if workspace := str(auth.Metadata["account_id"]); workspace != "" {
			r.Header.Set("Chatgpt-Account-Id", workspace)
		}
	}
	if auth.Provider == "claude" {
		r.Header.Set("anthropic-beta", "oauth-2025-04-20")
		r.Header.Set("User-Agent", claudeUserAgent)
	}
}

func (a *App) accountRequest(ctx context.Context, auth *core.Auth, method, target string, body []byte) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	r, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	providerHeaders(r, auth)
	response, err := a.core.HttpRequest(ctx, auth, r)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	return response.StatusCode, data, err
}

// hubBody keeps only the usage fields T3 Code parses, so per-key hubs never see
// user, workspace or balance data from the provider. Relative reset times become
// absolute because the body is served from cache.
func hubBody(provider string, data map[string]any, at time.Time) json.RawMessage {
	number := func(m map[string]any, field string) (float64, bool) { n, ok := m[field].(float64); return n, ok }
	var out any
	if provider == "codex" {
		window := func(raw any) gin.H {
			w := object(raw)
			used, ok := number(w, "used_percent")
			if !ok {
				return nil
			}
			result := gin.H{"used_percent": used}
			if reset, ok := number(w, "reset_at"); ok {
				result["reset_at"] = int64(reset)
			} else if after, ok := number(w, "reset_after_seconds"); ok && after >= 0 {
				result["reset_at"] = at.Add(time.Duration(after) * time.Second).Unix()
			}
			if seconds, ok := number(w, "limit_window_seconds"); ok {
				result["limit_window_seconds"] = seconds
			}
			return result
		}
		usage := gin.H{"rate_limit": nil}
		if plan := str(data["plan_type"]); plan != "" {
			usage["plan_type"] = plan
		}
		if rate := object(data["rate_limit"]); rate != nil {
			usage["rate_limit"] = gin.H{"primary_window": window(rate["primary_window"]), "secondary_window": window(rate["secondary_window"])}
		}
		out = usage
	} else {
		window := func(raw any) gin.H {
			w := object(raw)
			utilization, ok := number(w, "utilization")
			if !ok {
				return nil
			}
			reset, _ := w["resets_at"].(string)
			if reset == "" {
				return gin.H{"utilization": utilization, "resets_at": nil}
			}
			return gin.H{"utilization": utilization, "resets_at": reset}
		}
		limits := []gin.H{}
		raw, _ := data["limits"].([]any)
		for _, item := range raw {
			limit := object(item)
			percent, ok := number(limit, "percent")
			name := str(object(object(limit["scope"])["model"])["display_name"])
			if str(limit["kind"]) != "weekly_scoped" || !ok || name == "" {
				continue
			}
			entry := gin.H{"kind": "weekly_scoped", "percent": percent, "scope": gin.H{"model": gin.H{"display_name": name}}}
			if reset, _ := limit["resets_at"].(string); reset != "" {
				entry["resets_at"] = reset
			}
			limits = append(limits, entry)
		}
		out = gin.H{"five_hour": window(data["five_hour"]), "seven_day": window(data["seven_day"]), "limits": limits}
	}
	body, _ := json.Marshal(out)
	return body
}
