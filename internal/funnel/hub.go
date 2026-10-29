package funnel

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

const resetCreditURL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"

// The T3 hub contract is deliberately narrower than SDK management. It never
// exports credentials or permits arbitrary outbound requests.
func (a *App) hub(c *gin.Context) {
	value := bearer(c.Request)
	d := a.store.read()
	if value == "" || (digest(value) != d.Settings.HubTokenHash && digest(value) != digest(a.store.Admin)) {
		fail(c, 401, "Supply a valid usage hub key.")
		return
	}
	path := strings.TrimPrefix(c.Request.URL.Path, "/v0/management/")
	if path == "auth-files" && c.Request.Method == "GET" {
		files := []gin.H{}
		for _, auth := range a.core.List() {
			if auth.Provider != "codex" && auth.Provider != "claude" {
				continue
			}
			files = append(files, gin.H{"id": auth.ID, "auth_index": auth.ID, "provider": auth.Provider, "email": str(auth.Metadata["email"]), "disabled": auth.Disabled, "id_token": gin.H{"chatgpt_account_id": str(auth.Metadata["account_id"]), "plan_type": str(auth.Metadata["plan_type"])}})
		}
		c.JSON(200, gin.H{"files": files})
		return
	}
	if path != "api-call" || c.Request.Method != "POST" {
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
	auth, ok := a.core.GetByID(b.AuthIndex)
	if !ok || auth.Disabled {
		fail(c, 404, "Account unavailable.")
		return
	}
	allowed := b.Method == "GET" && ((auth.Provider == "codex" && (b.URL == "https://chatgpt.com/backend-api/wham/usage" || b.URL == resetCreditURL)) || (auth.Provider == "claude" && b.URL == "https://api.anthropic.com/api/oauth/usage"))
	if auth.Provider == "codex" && b.Method == "POST" && b.URL == resetCreditURL+"/consume" {
		var payload struct {
			CreditID        string `json:"credit_id"`
			RedeemRequestID string `json:"redeem_request_id"`
		}
		if json.Unmarshal([]byte(b.Data), &payload) == nil && payload.CreditID != "" && payload.RedeemRequestID != "" {
			allowed = true
		}
	}
	if !allowed {
		fail(c, 403, "Only provider usage and reset-credit operations are allowed.")
		return
	}
	if b.Method == "POST" {
		var payload struct {
			CreditID string `json:"credit_id"`
		}
		_ = json.Unmarshal([]byte(b.Data), &payload)
		status, body, err := a.consumeReset(c.Request.Context(), auth, payload.CreditID)
		if err != nil {
			fail(c, 502, "Provider reset request failed.")
			return
		}
		c.JSON(200, gin.H{"status_code": status, "body": string(body)})
		return
	}
	status, body, err := a.accountRequest(c.Request.Context(), auth, b.Method, b.URL, []byte(b.Data))
	if err != nil {
		fail(c, 502, "Provider usage request failed.")
		return
	}
	c.JSON(200, gin.H{"status_code": status, "body": string(body)})
}
func (a *App) accountRequest(ctx context.Context, auth *core.Auth, method, target string, body []byte) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	r, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	r.Header.Set("Content-Type", "application/json")
	if auth.Provider == "claude" {
		r.Header.Set("anthropic-beta", "oauth-2025-04-20")
	}
	response, err := a.core.HttpRequest(ctx, auth, r)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	return response.StatusCode, data, err
}
