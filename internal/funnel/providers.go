package funnel

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers/openai"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/httptransport"
)

type Quota struct {
	Label     string     `json:"label"`
	Remaining *float64   `json:"remaining"`
	ResetsAt  *time.Time `json:"resetsAt"`
}
type Account struct {
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	Email        string        `json:"email"`
	Plan         string        `json:"plan"`
	Status       string        `json:"status"`
	Quotas       []Quota       `json:"quotas"`
	QuotaError   string        `json:"quotaError,omitempty"`
	ResetCredits *ResetCredits `json:"resetCredits,omitempty"`
}
type ResetCredits struct {
	Items      []ResetCredit `json:"items,omitempty"`
	CheckedAt  *time.Time    `json:"checkedAt,omitempty"`
	Error      string        `json:"error,omitempty"`
	Available  int           `json:"available"`
	Applicable *int          `json:"applicable"`
}
type Snapshot struct {
	Quotas       []Quota       `json:"quotas"`
	At           time.Time     `json:"at"`
	Error        string        `json:"error"`
	ResetCredits *ResetCredits `json:"resetCredits,omitempty"`
}

func str(v any) string { s, _ := v.(string); return s }
func (a *App) publicConnection(conn Connection) gin.H {
	accounts := []Account{}
	models := []string{}
	d := a.store.read()
	var synced *time.Time
	for _, auth := range a.core.List() {
		if auth.Provider != conn.Provider {
			continue
		}
		email := str(auth.Metadata["email"])
		name := auth.Label
		if name == "" {
			name = email
		}
		if name == "" {
			name = auth.ID
		}
		plan := str(auth.Metadata["plan_type"])
		if plan == "" {
			plan = "Subscription"
		}
		status := "active"
		if auth.Disabled {
			status = "paused"
		} else if auth.Unavailable {
			status = "rate_limited"
		}
		snap := d.Snapshots[auth.ID]
		quotas := snap.Quotas
		if quotas == nil {
			quotas = []Quota{}
		}
		if !snap.At.IsZero() && (synced == nil || snap.At.Before(*synced)) {
			t := snap.At
			synced = &t
		}
		if snap.ResetCredits != nil && snap.ResetCredits.CheckedAt != nil {
			for i := range snap.ResetCredits.Items {
				credit := &snap.ResetCredits.Items[i]
				attempt, ok := d.ResetAttempts[auth.ID+"|"+credit.ID]
				if ok {
					credit.Attempt = &attempt
					if terminalReset(attempt.Result) {
						credit.Status = attempt.Result
					}
				}
			}
			snap.ResetCredits.Available = len(activeCredits(snap.ResetCredits.Items, now()))
		}
		accounts = append(accounts, Account{ID: auth.ID, Name: name, Email: email, Plan: plan, Status: status, Quotas: quotas, QuotaError: snap.Error, ResetCredits: snap.ResetCredits})
		// This registry lookup is local to the SDK, never an upstream request.
		if a.engine != nil {
			w := a.managementCall(context.Background(), "GET", "/credentials/models?name="+url.QueryEscape(auth.ID), "")
			var data struct {
				Models []struct {
					ID string `json:"id"`
				} `json:"models"`
			}
			if w.Code == 200 && json.Unmarshal(w.Body.Bytes(), &data) == nil {
				for _, m := range data.Models {
					if !contains(models, m.ID) {
						models = append(models, m.ID)
					}
				}
			}
		}
	}
	sort.Slice(accounts, func(i, j int) bool { return accounts[i].ID < accounts[j].ID })
	sort.Strings(models)
	return gin.H{"id": conn.ID, "provider": conn.Provider, "name": conn.Name, "enabled": conn.Enabled, "createdAt": conn.CreatedAt, "accounts": accounts, "models": models, "syncedAt": synced, "error": nil, "hasApiKey": true, "hasManagementAccess": true}
}
func parseQuota(label string, window map[string]any, percentField, resetField string, used bool) Quota {
	q := Quota{Label: label}
	if n, ok := window[percentField].(float64); ok {
		if used {
			n = 100 - n
		}
		n = max(0, min(100, n))
		q.Remaining = &n
	}
	switch v := window[resetField].(type) {
	case float64:
		t := time.Unix(int64(v), 0).UTC()
		q.ResetsAt = &t
	case string:
		if t, e := time.Parse(time.RFC3339, v); e == nil {
			q.ResetsAt = &t
		}
	}
	return q
}
func object(v any) map[string]any { m, _ := v.(map[string]any); return m }
func (a *App) refresh(ctx context.Context, conn Connection) {
	for _, auth := range a.core.List() {
		if auth.Provider != conn.Provider {
			continue
		}
		snap := Snapshot{At: now(), Quotas: []Quota{}}
		target := "https://chatgpt.com/backend-api/wham/usage"
		if conn.Provider == "claude" {
			target = "https://api.anthropic.com/api/oauth/usage"
		}
		requestCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		r, _ := http.NewRequestWithContext(requestCtx, "GET", target, nil)
		if conn.Provider == "claude" {
			r.Header.Set("anthropic-beta", "oauth-2025-04-20")
		}
		response, e := a.core.HttpRequest(requestCtx, auth, r)
		if e == nil {
			var data map[string]any
			if response.StatusCode == 200 {
				e = json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&data)
			} else {
				e = fmt.Errorf("quota lookup failed")
			}
			response.Body.Close()
			if e == nil {
				snap.Quotas, snap.ResetCredits = parseUsage(conn.Provider, data, snap.At)
			}
		}
		cancel()
		if e != nil {
			snap.Error = "Quota lookup unavailable. Retry refresh later."
			old := a.store.read().Snapshots[auth.ID]
			snap.Quotas = old.Quotas
			snap.ResetCredits = old.ResetCredits
			snap.At = old.At
		}
		if conn.Provider == "codex" && !auth.Disabled {
			snap.ResetCredits = a.fetchCredits(ctx, auth, snap.ResetCredits)
		}
		_ = a.store.change(func(d *diskState) error { d.Snapshots[auth.ID] = snap; return nil })
	}
}
func allowedPath(p, path, method string) bool {
	if p != "codex" && p != "claude" {
		return false
	}
	if method == "GET" {
		return path == "/v1/models" || (p == "codex" && path == "/backend-api/codex/models")
	}
	if method != "POST" {
		return false
	}
	if p == "codex" {
		return contains([]string{"/v1/responses", "/v1/responses/compact", "/backend-api/codex/responses", "/backend-api/codex/responses/compact"}, path)
	}
	if p == "claude" {
		return path == "/v1/messages" || path == "/v1/messages/count_tokens"
	}
	return false
}
func (a *App) provider(c *gin.Context) {
	parts := strings.SplitN(strings.TrimPrefix(c.Request.URL.Path, "/providers/"), "/", 3)
	if len(parts) != 3 {
		fail(c, 404, "Provider not found.")
		return
	}
	provider, id, path := parts[0], parts[1], "/"+parts[2]
	isWS := websocket.IsWebSocketUpgrade(c.Request) && provider == "codex" && c.Request.Method == "GET" && (path == "/v1/responses" || path == "/backend-api/codex/responses")
	if !isWS && !allowedPath(provider, path, c.Request.Method) {
		fail(c, 404, "Provider route not available.")
		return
	}
	value := bearer(c.Request)
	var body []byte
	model := ""
	if c.Request.Method == "POST" {
		var e error
		var status int
		body, status, e = readProviderBody(c)
		if e != nil {
			message := "Invalid compressed request body."
			if status == 413 {
				message = "Request body too large."
			} else if status == 415 {
				message = "Supported request encodings: gzip, zstd."
			}
			fail(c, status, message)
			return
		}
		var b struct {
			Model string `json:"model"`
		}
		if json.Unmarshal(body, &b) != nil || b.Model == "" {
			fail(c, 400, "Supply a model in the JSON request.")
			return
		}
		model = b.Model
	}
	conn, grant, keyID, status, message := a.authorizeProvider(provider, id, value, model, !isWS, nil)
	if status != 200 {
		if keyID != "" {
			a.logRequest(RequestLog{ID: token()[:24], At: now(), ConnectionID: id, Provider: provider, KeyID: keyID, Model: model, Status: status, Transport: "HTTP", ErrorCode: "access_denied"})
		}
		fail(c, status, message)
		return
	}
	if isWS {
		a.websocket(c, conn, grant, keyID)
		return
	}

	started := time.Now()
	requestID := token()[:24]
	c.Set("userApiKey", a.usageIdentity(keyID, conn.ID, "HTTP", requestID))
	defer func() {
		a.logRequest(RequestLog{ID: requestID, At: now(), ConnectionID: conn.ID, KeyID: keyID, Model: model, Provider: provider, Transport: "HTTP", Status: c.Writer.Status(), DurationMs: time.Since(started).Milliseconds()})
	}()

	// Fresh policy travels through the Gin request to the SDK selector, including retries.
	ctx := context.WithValue(c.Request.Context(), scopeKey{}, scope{provider, grant.AccountIDs})
	if provider == "claude" {
		ctx = httptransport.WithDecorator(ctx, func(next http.RoundTripper) http.RoundTripper {
			return claudeCompressionTransport{next}
		})
	}
	c.Request = c.Request.WithContext(ctx)
	c.Request.Body = io.NopCloser(bytes.NewReader(body))
	c.Request.ContentLength = int64(len(body))
	if c.Request.Method == "GET" {
		models := []gin.H{}
		seen := map[string]bool{}
		for _, auth := range a.core.List() {
			if auth.Provider != provider || (grant.AccountIDs != nil && !contains(grant.AccountIDs, auth.ID)) {
				continue
			}
			w := a.managementCall(ctx, "GET", "/credentials/models?name="+url.QueryEscape(auth.ID), "")
			var data struct {
				Models []gin.H `json:"models"`
			}
			_ = json.Unmarshal(w.Body.Bytes(), &data)
			for _, m := range data.Models {
				id := str(m["id"])
				if id != "" && !seen[id] && (grant.Models == nil || contains(grant.Models, id)) {
					seen[id] = true
					models = append(models, gin.H{"id": id, "object": "model"})
				}
			}
		}
		if provider == "claude" {
			c.JSON(200, gin.H{"data": models, "has_more": false, "first_id": nil, "last_id": nil})
		} else if strings.HasPrefix(path, "/backend-api/") {
			nativeModels := make([]map[string]any, 0, len(models))
			for _, m := range models {
				nativeModels = append(nativeModels, map[string]any(m))
			}
			c.JSON(200, openai.CodexClientModelsResponse(nativeModels))
		} else {
			c.JSON(200, gin.H{"object": "list", "data": models})
		}
		return
	}
	c.Status(http.StatusOK)
	if provider == "claude" {
		if strings.HasSuffix(path, "/count_tokens") {
			a.claude.ClaudeCountTokens(c)
		} else {
			a.claude.ClaudeMessages(c)
		}
	} else if strings.HasSuffix(path, "/compact") {
		a.responses.Compact(c)
	} else {
		a.responses.Responses(c)
	}
}

// RefreshAll serializes background quota reads instead of bursting provider endpoints.
func (a *App) RefreshAll(ctx context.Context) {
	for _, conn := range a.store.read().Connections {
		if ctx.Err() != nil {
			return
		}
		if conn.Enabled && (conn.Provider == "codex" || conn.Provider == "claude") {
			a.refresh(ctx, conn)
		}
	}
}

func (a *App) authorizeProvider(provider, id, value, model string, reserve bool, expected *Grant) (conn Connection, grant Grant, keyID string, status int, message string) {
	for _, k := range a.store.read().Keys {
		if value != "" && k.Hash == digest(value) {
			keyID = k.ID
			break
		}
	}
	if keyID == "" {
		return conn, grant, keyID, 401, "Supply a valid client key."
	}
	authProviders := map[string]string{}
	for _, auth := range a.core.List() {
		authProviders[auth.ID] = auth.Provider
	}
	err := a.store.change(func(d *diskState) error {
		k, ok := d.Keys[keyID]
		if !ok || !k.Enabled || (k.ExpiresAt != nil && !k.ExpiresAt.After(now())) {
			status = 401
			message = "This client key is paused, removed, or expired."
			return fmt.Errorf("denied")
		}
		var exists bool
		conn, exists = d.Connections[id]
		if !exists || conn.Provider != provider {
			status = 404
			message = "Provider connection not found."
			return fmt.Errorf("denied")
		}
		if !conn.Enabled {
			status = 503
			message = "This connection is paused."
			return fmt.Errorf("denied")
		}
		found := false
		for _, g := range k.Grants {
			if g.ConnectionID == id {
				grant = g
				found = true
			}
		}
		if !found || (model != "" && grant.Models != nil && !contains(grant.Models, model)) {
			status = 403
			message = "This key does not allow the provider or model."
			return fmt.Errorf("denied")
		}
		for _, account := range grant.AccountIDs {
			if authProviders[account] != provider {
				status = 503
				message = "Assigned account unavailable."
				return fmt.Errorf("denied")
			}
		}
		if k.DailyLimit != nil && d.Usage[usageID(k.ID)] >= *k.DailyLimit {
			status = 429
			message = "Daily request limit reached. Resets at midnight UTC."
			return fmt.Errorf("denied")
		}
		if expected != nil && !reflect.DeepEqual(*expected, grant) {
			status = 403
			message = "Account access changed. Reconnect the WebSocket."
			return fmt.Errorf("denied")
		}
		if !reserve {
			return nil
		}
		d.Usage[usageID(k.ID)]++
		t := now()
		k.LastUsedAt = &t
		d.Keys[k.ID] = k
		return nil
	})
	if err != nil {
		if status == 0 {
			status = 500
			message = "Could not reserve request."
		}
		return
	}
	status = 200
	return
}
