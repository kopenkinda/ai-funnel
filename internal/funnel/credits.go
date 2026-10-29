package funnel

import (
	"context"
	"encoding/json"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// Check live subscription windows before each execution, retry, and WebSocket
// turn. Funded accounts remain eligible until a subscription limit is reached.
// Concurrent requests and delayed usage reporting may spend some credits.
func (a *App) codexSubscriptionAvailable(ctx context.Context, auth *core.Auth) bool {
	status, body, err := a.accountRequest(ctx, auth, "GET", "https://chatgpt.com/backend-api/wham/usage", nil)
	if err != nil || status != 200 {
		return false
	}
	type window struct {
		Used *float64 `json:"used_percent"`
	}
	var usage struct {
		RateLimit *struct {
			Allowed   *bool   `json:"allowed"`
			Reached   bool    `json:"limit_reached"`
			Primary   *window `json:"primary_window"`
			Secondary *window `json:"secondary_window"`
		} `json:"rate_limit"`
	}
	if json.Unmarshal(body, &usage) != nil || usage.RateLimit == nil {
		return false
	}
	limits := usage.RateLimit
	if limits.Reached || (limits.Allowed != nil && !*limits.Allowed) {
		return false
	}
	reported := false
	for _, w := range []*window{limits.Primary, limits.Secondary} {
		if w == nil {
			continue
		}
		if w.Used == nil || *w.Used < 0 || *w.Used >= 100 {
			return false
		}
		reported = true
	}
	return reported
}
