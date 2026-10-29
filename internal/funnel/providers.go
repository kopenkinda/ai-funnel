package funnel

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers/openai"
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
	Available  int  `json:"available"`
	Applicable *int `json:"applicable"`
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
	if conn.Provider == "zen" || conn.Provider == "go" {
		models = append(models, conn.Models...)
		accounts = []Account{{ID: conn.ID, Name: conn.Name, Plan: strings.ToUpper(conn.Provider[:1]) + conn.Provider[1:], Status: "connected", Quotas: []Quota{}, QuotaError: "View balance and billing in OpenCode Console."}}
	}
	sort.Slice(accounts, func(i, j int) bool { return accounts[i].ID < accounts[j].ID })
	sort.Strings(models)
	return gin.H{"id": conn.ID, "provider": conn.Provider, "name": conn.Name, "url": conn.URL, "enabled": conn.Enabled, "createdAt": conn.CreatedAt, "accounts": accounts, "models": models, "syncedAt": synced, "error": nil, "hasApiKey": true, "hasManagementAccess": true}
}
func openCodeModels(ctx context.Context, c Connection) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	r, _ := http.NewRequestWithContext(ctx, "GET", c.URL+"/v1/models", nil)
	r.Header.Set("Authorization", "Bearer "+c.APIKey)
	response, e := http.DefaultClient.Do(r)
	if e != nil {
		return nil, e
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, fmt.Errorf("models unavailable")
	}
	var data struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if e = json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&data); e != nil {
		return nil, e
	}
	out := []string{}
	for _, m := range data.Data {
		out = append(out, m.ID)
	}
	return out, nil
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
		_ = a.store.change(func(d *diskState) error { d.Snapshots[auth.ID] = snap; return nil })
	}
}
func allowedPath(p, path, method string) bool {
	if method == "GET" {
		return path == "/v1/models" || (p == "codex" && path == "/backend-api/codex/models") || ((p == "zen" || p == "go") && (path == "/openai/v1/models" || path == "/anthropic/v1/models"))
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
	return contains([]string{"/openai/v1/responses", "/openai/v1/chat/completions", "/anthropic/v1/messages", "/anthropic/v1/messages/count_tokens"}, path)
}
func (a *App) provider(c *gin.Context) {
	parts := strings.SplitN(strings.TrimPrefix(c.Request.URL.Path, "/providers/"), "/", 3)
	if len(parts) != 3 {
		fail(c, 404, "Provider not found.")
		return
	}
	provider, id, path := parts[0], parts[1], "/"+parts[2]
	if !allowedPath(provider, path, c.Request.Method) {
		fail(c, 404, "Provider route not available.")
		return
	}
	value := bearer(c.Request)
	d := a.store.read()
	keyID := ""
	for _, k := range d.Keys {
		if value != "" && k.Hash == digest(value) {
			keyID = k.ID
			break
		}
	}
	if keyID == "" {
		fail(c, 401, "Supply a valid client key.")
		return
	}
	var body []byte
	model := ""
	if c.Request.Method == "POST" {
		var e error
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16<<20)
		body, e = io.ReadAll(c.Request.Body)
		if e != nil {
			fail(c, 413, "Request body too large.")
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
	authProviders := map[string]string{}
	for _, auth := range a.core.List() {
		authProviders[auth.ID] = auth.Provider
	}
	var conn Connection
	var grant Grant
	var status int
	message := ""
	e := a.store.change(func(d *diskState) error {
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
			if provider == "zen" || provider == "go" {
				if account != conn.ID {
					status = 503
					message = "Assigned account unavailable."
					return fmt.Errorf("denied")
				}
			} else {
				if authProviders[account] != provider {
					status = 503
					message = "Assigned account unavailable."
					return fmt.Errorf("denied")
				}
			}
		}
		if k.DailyLimit != nil && d.Usage[usageID(k.ID)] >= *k.DailyLimit {
			status = 429
			message = "Daily request limit reached. Resets at midnight UTC."
			return fmt.Errorf("denied")
		}
		d.Usage[usageID(k.ID)]++
		t := now()
		k.LastUsedAt = &t
		d.Keys[k.ID] = k
		return nil
	})
	if e != nil {
		if status == 0 {
			status = 500
			message = "Could not reserve request."
		}
		fail(c, status, message)
		return
	}
	started := time.Now()
	defer func() {
		_ = a.store.change(func(d *diskState) error {
			d.Requests = append(d.Requests, RequestLog{token()[:24], now(), conn.ID, keyID, model, c.Writer.Status(), time.Since(started).Milliseconds()})
			if len(d.Requests) > 2000 {
				d.Requests = d.Requests[len(d.Requests)-2000:]
			}
			for k := range d.Usage {
				if len(k) >= 10 && k[:10] < now().AddDate(0, 0, -32).Format("2006-01-02") {
					delete(d.Usage, k)
				}
			}
			return nil
		})
	}()
	if provider == "zen" || provider == "go" {
		a.openCode(c, conn, grant, path, body)
		return
	}
	// Fresh policy travels through the Gin request to the SDK selector, including retries.
	ctx := context.WithValue(c.Request.Context(), scopeKey{}, scope{provider, grant.AccountIDs})
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
func (a *App) openCode(c *gin.Context, conn Connection, grant Grant, path string, body []byte) {
	target, _ := url.Parse(conn.URL)
	target.Path += path
	if c.Request.Method == "GET" {
		models, e := openCodeModels(c.Request.Context(), conn)
		if e != nil {
			fail(c, 502, "OpenCode model discovery failed.")
			return
		}
		rows := []gin.H{}
		for _, id := range models {
			if grant.Models == nil || contains(grant.Models, id) {
				rows = append(rows, gin.H{"id": id, "object": "model"})
			}
		}
		c.JSON(200, gin.H{"object": "list", "data": rows})
		return
	}
	proxy := &httputil.ReverseProxy{Rewrite: func(r *httputil.ProxyRequest) {
		r.Out.URL = target
		r.Out.Host = target.Host
		r.Out.Header = make(http.Header)
		for _, h := range []string{"Content-Type", "Accept", "Anthropic-Version", "Anthropic-Beta", "User-Agent", "X-Opencode-Session", "Session_id", "X-Session-Id"} {
			if v := r.In.Header.Get(h); v != "" {
				r.Out.Header.Set(h, v)
			}
		}
		r.Out.Header.Set("Authorization", "Bearer "+conn.APIKey)
		r.Out.Body = io.NopCloser(bytes.NewReader(body))
		r.Out.ContentLength = int64(len(body))
	}, FlushInterval: -1, ModifyResponse: func(r *http.Response) error {
		r.Header.Del("Set-Cookie")
		if r.StatusCode >= 300 && r.StatusCode < 400 {
			return fmt.Errorf("redirect disabled")
		}
		return nil
	}, ErrorHandler: func(w http.ResponseWriter, r *http.Request, e error) { fail(c, 502, "OpenCode request failed.") }}
	proxy.ServeHTTP(c.Writer, c.Request)
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
