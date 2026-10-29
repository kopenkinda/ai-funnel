package funnel

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync/atomic"

	"github.com/gin-gonic/gin"
	sdkaccess "github.com/router-for-me/CLIProxyAPI/v8/sdk/access"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type websocketPolicyKey struct{}
type websocketPolicy struct {
	connection Connection
	grant      Grant
	principal  string
	selected   *atomic.Pointer[core.Auth]
}
type websocketAccess struct{ app *App }

func (*websocketAccess) Identifier() string { return "ai-funnel" }
func (p *websocketAccess) Authenticate(ctx context.Context, r *http.Request) (*sdkaccess.Result, *sdkaccess.AuthError) {
	policy, ok := ctx.Value(websocketPolicyKey{}).(websocketPolicy)
	if !ok {
		return nil, sdkaccess.NewDeniedError("WebSocket policy missing.", 403)
	}
	var payload struct {
		Model string `json:"model"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<20)).Decode(&payload); err != nil || payload.Model == "" {
		return nil, sdkaccess.NewDeniedError("Supply a model in the JSON request.", 400)
	}
	_, _, keyID, status, message := p.app.authorizeProvider(policy.connection.Provider, policy.connection.ID, bearer(r), payload.Model, true, &policy.grant)
	// A duplex upstream socket can forward turns without re-entering the selector.
	// Recheck the bound account here before the SDK sends each subsequent turn.
	if status == 200 && policy.selected != nil {
		if selected := policy.selected.Load(); selected != nil {
			auth, exists := p.app.core.GetByID(selected.ID)
			routing, _ := p.app.store.routingInputs(policy.connection.Provider, nil)
			switch {
			case !exists || auth.Disabled || auth.Status == core.StatusDisabled:
				status, message = 503, "The bound Codex account is unavailable. Reconnect the WebSocket."
			case routing.Strategy == "single_account" && routing.AccountID != selected.ID:
				status, message = 403, "Account routing changed. Reconnect the WebSocket."
			case policy.grant.SubscriptionOnly && !p.app.codexSubscriptionAvailable(ctx, auth):
				status, message = 429, "The bound Codex account no longer has verified subscription allowance remaining."
			}
		}
	}
	if status != 200 {
		if keyID != "" {
			p.app.logRequest(RequestLog{ID: token()[:24], At: now(), ConnectionID: policy.connection.ID, Provider: policy.connection.Provider, KeyID: keyID, Model: payload.Model, Transport: "WS", Status: status, ErrorCode: "access_denied"})
		}
		return nil, sdkaccess.NewDeniedError(message, status)
	}
	return &sdkaccess.Result{Provider: p.Identifier(), Principal: policy.principal}, nil
}
func (a *App) websocket(c *gin.Context, conn Connection, grant Grant, keyID string) {
	if !a.allowedOrigin(c.Request) {
		fail(c, 403, "WebSocket origin not allowed.")
		return
	}
	principal := a.usageIdentity(keyID, conn.ID, "WS", token()[:24])
	selected := &atomic.Pointer[core.Auth]{}
	policy := websocketPolicy{connection: conn, grant: grant, principal: principal, selected: selected}
	ctx := context.WithValue(c.Request.Context(), scopeKey{}, scope{provider: conn.Provider, keyID: keyID, ids: grant.AccountIDs, subscriptionOnly: grant.SubscriptionOnly, selected: selected})
	ctx = context.WithValue(ctx, websocketPolicyKey{}, policy)
	c.Request = c.Request.WithContext(ctx)
	c.Set("userApiKey", principal)
	c.Status(http.StatusSwitchingProtocols)
	a.responses.ResponsesWebsocket(c)
}
