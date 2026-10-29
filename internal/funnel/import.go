package funnel

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type accountImport struct {
	Provider  string          `json:"provider"`
	Name      string          `json:"name"`
	Token     string          `json:"token"`
	AccountID string          `json:"accountId"`
	Auth      json.RawMessage `json:"auth"`
}

// JWT claims identify the imported account. Only the provider validates the token.
func tokenClaims(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil
	}
	b, e := base64.RawURLEncoding.DecodeString(parts[1])
	if e != nil {
		return nil
	}
	var claims map[string]any
	_ = json.Unmarshal(b, &claims)
	return claims
}

func parseAccountImport(b accountImport) (*core.Auth, error) {
	if b.Provider != "codex" && b.Provider != "claude" {
		return nil, fmt.Errorf("Select Codex or Claude.")
	}
	if len(b.Name) > 80 {
		return nil, fmt.Errorf("Keep the provider name under 80 characters.")
	}
	if (b.Token != "") == (len(b.Auth) > 0) {
		return nil, fmt.Errorf("Supply an auth token or a JSON credential file.")
	}
	source := map[string]any{}
	if len(b.Auth) > 0 {
		if len(b.Auth) > 64<<10 || json.Unmarshal(b.Auth, &source) != nil || source == nil {
			return nil, fmt.Errorf("Choose a valid JSON credential file under 64 KB.")
		}
		provider := strings.ToLower(str(source["type"]))
		if provider == "anthropic" {
			provider = "claude"
		}
		if provider != "" && provider != b.Provider {
			return nil, fmt.Errorf("The credential file belongs to a different provider.")
		}
		if str(source["auth_mode"]) == "apikey" {
			return nil, fmt.Errorf("Use a subscription auth.json file, not an API-key login.")
		}
		if nested := object(source["tokens"]); nested != nil {
			if b.Provider != "codex" {
				return nil, fmt.Errorf("Select Codex to import this auth.json file.")
			}
			for k, v := range nested {
				source[k] = v
			}
		}
		if nested := object(source["claudeAiOauth"]); nested != nil {
			if b.Provider != "claude" {
				return nil, fmt.Errorf("Select Claude to import this credential file.")
			}
			for from, to := range map[string]string{"accessToken": "access_token", "refreshToken": "refresh_token", "subscriptionType": "plan_type", "rateLimitTier": "rate_limit_tier"} {
				source[to] = nested[from]
			}
			if ms, ok := nested["expiresAt"].(float64); ok && ms > 0 {
				source["expired"] = time.UnixMilli(int64(ms)).UTC().Format(time.RFC3339)
			}
		}
	} else {
		source["access_token"] = strings.TrimSpace(b.Token)
		source["account_id"] = strings.TrimSpace(b.AccountID)
	}
	// Never import routing overrides, arbitrary headers, paths, or runtime state.
	metadata := map[string]any{"type": b.Provider}
	for _, k := range []string{"access_token", "refresh_token", "id_token", "account_id", "email", "plan_type", "rate_limit_tier", "expired", "last_refresh", "account_uuid", "organization_uuid", "organization_name"} {
		if v := strings.TrimSpace(str(source[k])); v != "" {
			metadata[k] = v
		}
	}
	access := str(metadata["access_token"])
	if len(access) < 16 || len(access) > 32768 || strings.ContainsAny(access, " \t\r\n") {
		return nil, fmt.Errorf("Supply a subscription access token. The file must contain access_token or tokens.access_token.")
	}
	if strings.HasPrefix(access, "sk-") && !strings.HasPrefix(access, "sk-ant-oat") {
		return nil, fmt.Errorf("Use a subscription OAuth token, not a paid API key.")
	}
	for _, raw := range []string{str(metadata["id_token"]), access} {
		claims := tokenClaims(raw)
		auth := object(claims["https://api.openai.com/auth"])
		profile := object(claims["https://api.openai.com/profile"])
		for k, v := range map[string]any{"email": claims["email"], "account_id": auth["chatgpt_account_id"], "plan_type": auth["chatgpt_plan_type"]} {
			if str(metadata[k]) == "" && str(v) != "" {
				metadata[k] = v
			}
		}
		if str(metadata["email"]) == "" && str(profile["email"]) != "" {
			metadata["email"] = profile["email"]
		}
	}
	if b.Provider == "codex" && str(metadata["account_id"]) == "" {
		return nil, fmt.Errorf("The Codex account ID is missing. Import auth.json or enter the account ID with your token.")
	}
	if str(metadata["expired"]) == "" {
		if seconds, ok := tokenClaims(access)["exp"].(float64); ok && seconds > 0 {
			metadata["expired"] = time.Unix(int64(seconds), 0).UTC().Format(time.RFC3339)
		}
	}
	identity := str(metadata["account_id"])
	if b.Provider == "claude" {
		identity = str(metadata["account_uuid"])
	}
	if email := str(metadata["email"]); email != "" {
		identity += ":" + strings.ToLower(email)
	}
	if identity == "" {
		identity = access
	}
	id := b.Provider + "-" + digest(identity)[:24]
	label := str(metadata["email"])
	if label == "" {
		label = strings.ToUpper(b.Provider[:1]) + b.Provider[1:] + " account " + id[len(id)-6:]
	}
	return &core.Auth{ID: id, Provider: b.Provider, Label: label, Status: core.StatusActive, Metadata: metadata, Attributes: map[string]string{"plan_type": str(metadata["plan_type"])}, CreatedAt: now(), UpdatedAt: now()}, nil
}

func (a *App) importAccount(c *gin.Context) {
	var b accountImport
	if !decode(c, &b) {
		return
	}
	auth, e := parseAccountImport(b)
	if e != nil {
		fail(c, 400, e.Error())
		return
	}
	// Re-import updates the same account and retains existing key assignments and pauses.
	for _, old := range a.core.List() {
		if old.Provider != auth.Provider {
			continue
		}
		same := old.ID == auth.ID
		identityField := "account_id"
		if auth.Provider == "claude" {
			identityField = "account_uuid"
		}
		identity := str(auth.Metadata[identityField])
		email, oldEmail := str(auth.Metadata["email"]), str(old.Metadata["email"])
		emailMatches := email == "" || oldEmail == "" || strings.EqualFold(email, oldEmail)
		if identity != "" && identity == str(old.Metadata[identityField]) && emailMatches && str(old.Metadata["organization_uuid"]) == str(auth.Metadata["organization_uuid"]) {
			same = true
		}
		if same {
			auth.ID, auth.CreatedAt, auth.Disabled = old.ID, old.CreatedAt, old.Disabled
			break
		}
	}
	var conn Connection
	if e = a.store.change(func(d *diskState) error {
		var exists bool
		conn, exists = d.Connections[auth.Provider]
		if !exists {
			name := strings.TrimSpace(b.Name)
			if name == "" {
				name = strings.ToUpper(auth.Provider[:1]) + auth.Provider[1:]
			}
			conn = Connection{ID: auth.Provider, Provider: auth.Provider, Name: name, Enabled: true, CreatedAt: now()}
			d.Connections[conn.ID] = conn
		}
		return nil
	}); e != nil {
		fail(c, 500, "Could not save the provider connection.")
		return
	}
	ctx := c.Request.Context()
	// Register tolerates store failures upstream, so persist explicitly before publishing.
	if _, e = a.store.Save(ctx, auth); e != nil {
		fail(c, 500, "Could not save the imported account.")
		return
	}
	if _, e = a.core.Register(core.WithSkipPersist(ctx), auth); e != nil {
		fail(c, 500, "Could not register the imported account.")
		return
	}
	// This SDK operation persists through our encrypted store and runs its runtime
	// registration hook, including model discovery. No plaintext auth file is needed.
	payload, _ := json.Marshal(gin.H{"name": auth.ID, "disabled": auth.Disabled})
	w := a.managementCall(context.WithoutCancel(ctx), "PATCH", "/credentials/status", string(payload))
	if w.Code >= 400 {
		fail(c, 500, "Account saved, but activation failed. Try importing it again.")
		return
	}
	c.JSON(201, a.publicConnection(conn))
}
