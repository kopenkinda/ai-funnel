package funnel

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"

	"github.com/gin-gonic/gin"
	sdkaccess "github.com/router-for-me/CLIProxyAPI/v8/sdk/access"
)

type websocketPolicyKey struct{}
type websocketPolicy struct {
	connection Connection
	grant      Grant
	principal  string
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
	if status != 200 {
		if keyID != "" {
			p.app.logRequest(RequestLog{ID: token()[:24], At: now(), ConnectionID: policy.connection.ID, Provider: policy.connection.Provider, KeyID: keyID, Model: payload.Model, Transport: "WS", Status: status, ErrorCode: "access_denied"})
		}
		return nil, sdkaccess.NewDeniedError(message, status)
	}
	return &sdkaccess.Result{Provider: p.Identifier(), Principal: policy.principal}, nil
}
func (a *App) websocket(c *gin.Context, conn Connection, grant Grant, keyID string) {
	if origin := c.Request.Header.Get("Origin"); origin != "" {
		expected := a.publicURL
		if expected == "" {
			expected = "http://" + c.Request.Host
		}
		u, err := url.Parse(expected)
		if err != nil || origin != u.Scheme+"://"+u.Host {
			fail(c, 403, "WebSocket origin not allowed.")
			return
		}
	}
	principal := a.usageIdentity(keyID, conn.ID, "WS", token()[:24])
	policy := websocketPolicy{conn, grant, principal}
	ctx := context.WithValue(c.Request.Context(), scopeKey{}, scope{conn.Provider, grant.AccountIDs})
	ctx = context.WithValue(ctx, websocketPolicyKey{}, policy)
	c.Request = c.Request.WithContext(ctx)
	c.Set("userApiKey", principal)
	c.Status(http.StatusSwitchingProtocols)
	a.responses.ResponsesWebsocket(c)
}
