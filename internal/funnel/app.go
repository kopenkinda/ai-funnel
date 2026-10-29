package funnel

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func fail(c *gin.Context, status int, message string) {
	typ := "invalid_request_error"
	if status == 401 {
		typ = "authentication_error"
	}
	if status == 403 {
		typ = "permission_error"
	}
	if status == 429 {
		typ = "rate_limit_error"
	}
	if status >= 500 {
		typ = "api_error"
	}
	body := gin.H{"error": gin.H{"type": typ, "message": message}}
	if strings.Contains(c.Request.URL.Path, "/claude/") || strings.Contains(c.Request.URL.Path, "/anthropic/") {
		body["type"] = "error"
	}
	c.JSON(status, body)
}
func decode(c *gin.Context, v any) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 128<<10)
	if e := json.NewDecoder(c.Request.Body).Decode(v); e != nil {
		fail(c, 400, "Supply a valid JSON object.")
		return false
	}
	return true
}
func bearer(r *http.Request) string {
	if len(r.Header.Values("Authorization")) > 1 {
		return ""
	}
	b := ""
	if v := r.Header.Get("Authorization"); v != "" {
		parts := strings.Fields(v)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			return ""
		}
		b = parts[1]
	}
	keys := r.Header.Values("X-Api-Key")
	if len(keys) > 1 {
		return ""
	}
	k := r.Header.Get("X-Api-Key")
	if k != "" && b != "" && k != b {
		return ""
	}
	if b != "" {
		return b
	}
	return k
}
func session(r *http.Request) string {
	v, e := r.Cookie("funnel_session")
	if e != nil {
		return ""
	}
	return v.Value
}
func (a *App) authorized(r *http.Request) bool {
	d := a.store.read()
	return d.Sessions[digest(session(r))].After(now()) || subtle.ConstantTimeCompare([]byte(digest(bearer(r))), []byte(digest(a.store.Admin))) == 1
}
func (a *App) save(c *gin.Context, fn func(*diskState) error) bool {
	if e := a.store.change(fn); e != nil {
		fail(c, 500, "Could not save application state.")
		return false
	}
	return true
}
func (a *App) dashboard(c *gin.Context) {
	p, m := strings.TrimPrefix(c.Request.URL.Path, "/api/"), c.Request.Method
	if origin := c.Request.Header.Get("Origin"); origin != "" && m != "GET" && m != "HEAD" {
		expected := a.publicURL
		if expected == "" {
			expected = "http://" + c.Request.Host
		}
		u, e := url.Parse(expected)
		if e != nil || origin != u.Scheme+"://"+u.Host {
			fail(c, 403, "Use the dashboard from its configured address.")
			return
		}
	}
	if p == "session" && m == "GET" {
		d := a.store.read()
		c.JSON(200, gin.H{"authenticated": d.Sessions[digest(session(c.Request))].After(now())})
		return
	}
	if p == "session" && m == "POST" {
		a.gate <- struct{}{}
		defer func() { <-a.gate }()
		host, _, _ := strings.Cut(c.Request.RemoteAddr, ":")
		t := now().Unix()
		valid := []int64{}
		for _, v := range a.failures[host] {
			if v > t-60 {
				valid = append(valid, v)
			}
		}
		if len(valid) >= 8 {
			fail(c, 429, "Too many attempts. Try again in one minute.")
			return
		}
		var b struct {
			Token string `json:"token"`
		}
		if !decode(c, &b) {
			return
		}
		if subtle.ConstantTimeCompare([]byte(digest(b.Token)), []byte(digest(a.store.Admin))) != 1 {
			a.failures[host] = append(valid, t)
			fail(c, 401, "The dashboard key is incorrect.")
			return
		}
		delete(a.failures, host)
		value := token()
		if !a.save(c, func(d *diskState) error {
			for k, v := range d.Sessions {
				if v.Before(now()) {
					delete(d.Sessions, k)
				}
			}
			d.Sessions[digest(value)] = now().Add(7 * 24 * time.Hour)
			return nil
		}) {
			return
		}
		http.SetCookie(c.Writer, &http.Cookie{Name: "funnel_session", Value: value, Path: "/", HttpOnly: true, Secure: strings.HasPrefix(a.publicURL, "https:"), SameSite: http.SameSiteStrictMode, MaxAge: 604800})
		c.JSON(200, gin.H{"authenticated": true})
		return
	}
	if !a.authorized(c.Request) {
		fail(c, 401, "Unlock the dashboard to continue.")
		return
	}
	if p == "session" && m == "DELETE" {
		if !a.save(c, func(d *diskState) error { delete(d.Sessions, digest(session(c.Request))); return nil }) {
			return
		}
		http.SetCookie(c.Writer, &http.Cookie{Name: "funnel_session", Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: -1})
		c.JSON(200, gin.H{"authenticated": false})
		return
	}
	if p == "hub-token" && m == "POST" {
		value := "sk-hub-" + token()
		if !a.save(c, func(d *diskState) error { d.Settings.HubTokenHash = digest(value); return nil }) {
			return
		}
		c.JSON(201, gin.H{"token": value})
		return
	}
	if p == "settings" && m == "PATCH" {
		var b struct {
			AutoUseResets bool `json:"autoUseResets"`
		}
		if !decode(c, &b) {
			return
		}
		if !a.save(c, func(d *diskState) error { d.Settings.AutoUseResets = b.AutoUseResets; return nil }) {
			return
		}
		c.JSON(200, gin.H{"autoUseResets": b.AutoUseResets})
		return
	}
	if p == "requests" && m == "GET" {
		a.requestLogs(c)
		return
	}
	if p == "state" && m == "GET" {
		a.state(c)
		return
	}
	if p == "accounts/import" && m == "POST" {
		a.importAccount(c)
		return
	}
	if p == "oauth" && m == "POST" {
		var b struct {
			Provider string `json:"provider"`
		}
		if !decode(c, &b) {
			return
		}
		if b.Provider != "codex" && b.Provider != "claude" {
			fail(c, 400, "Select Codex or Claude.")
			return
		}
		w := a.managementCall(c.Request.Context(), "GET", "/oauth/auth-url?provider="+b.Provider+"&is_webui=true", "")
		a.managementResponse(c, w.Code, w.Body.Bytes())
		return
	}
	if p == "oauth/session" && m == "DELETE" {
		state := c.Query("state")
		if state == "" || len(state) > 256 {
			fail(c, 400, "Supply a login state.")
			return
		}
		w := a.managementCall(c.Request.Context(), "DELETE", "/oauth/session?state="+url.QueryEscape(state), "")
		a.managementResponse(c, w.Code, w.Body.Bytes())
		return
	}
	if p == "oauth/status" && m == "GET" {
		state := c.Query("state")
		if state == "" || len(state) > 256 {
			fail(c, 400, "Supply a login state.")
			return
		}
		w := a.managementCall(c.Request.Context(), "GET", "/oauth/status?state="+url.QueryEscape(state), "")
		a.managementResponse(c, w.Code, w.Body.Bytes())
		return
	}
	if p == "oauth/callback" && m == "POST" {
		var b struct {
			RedirectURL string `json:"redirect_url"`
		}
		if !decode(c, &b) {
			return
		}
		u, e := url.Parse(b.RedirectURL)
		if e != nil || u.Query().Get("state") == "" {
			fail(c, 400, "Paste the complete callback URL.")
			return
		}
		payload, _ := json.Marshal(b)
		w := a.managementCall(c.Request.Context(), "POST", "/oauth/callback", string(payload))
		a.managementResponse(c, w.Code, w.Body.Bytes())
		return
	}
	if p == "connections" && m == "POST" {
		var b Connection
		if !decode(c, &b) {
			return
		}
		if !contains([]string{"codex", "claude"}, b.Provider) || strings.TrimSpace(b.Name) == "" || len(b.Name) > 80 {
			fail(c, 400, "Supply a provider and connection name.")
			return
		}
		b.ID = b.Provider
		b.Enabled = true
		b.CreatedAt = now()
		if existing, ok := a.store.read().Connections[b.ID]; ok {
			c.JSON(200, a.publicConnection(existing))
			return
		}
		if !a.save(c, func(d *diskState) error {
			if _, ok := d.Connections[b.ID]; ok {
				return fmt.Errorf("pool already exists")
			}
			d.Connections[b.ID] = b
			return nil
		}) {
			return
		}
		c.JSON(201, a.publicConnection(b))
		return
	}
	parts := strings.Split(p, "/")
	if len(parts) >= 2 && parts[0] == "connections" {
		d := a.store.read()
		conn, ok := d.Connections[parts[1]]
		if !ok {
			fail(c, 404, "Connection not found.")
			return
		}
		if len(parts) == 3 && parts[2] == "models" && m == "GET" {
			models, err := a.providerModels(c.Request.Context(), conn.Provider, nil)
			if err != nil {
				fail(c, 502, "Provider model catalog unavailable.")
				return
			}
			data := []gin.H{}
			for _, id := range models {
				data = append(data, gin.H{"id": id, "object": "model"})
			}
			c.JSON(200, gin.H{"data": data})
			return
		}
		if len(parts) == 3 && parts[2] == "sync" && m == "POST" {
			a.refresh(c.Request.Context(), conn)
			c.JSON(200, a.publicConnection(conn))
			return
		}
		if len(parts) == 2 && m == "PATCH" {
			var b struct {
				Enabled *bool `json:"enabled"`
			}
			if !decode(c, &b) {
				return
			}
			if b.Enabled == nil {
				fail(c, 400, "Supply the connection state.")
				return
			}
			if !a.save(c, func(d *diskState) error {
				v := d.Connections[conn.ID]
				v.Enabled = *b.Enabled
				d.Connections[conn.ID] = v
				conn = v
				return nil
			}) {
				return
			}
			c.JSON(200, a.publicConnection(conn))
			return
		}
		if len(parts) == 2 && m == "DELETE" {
			if !a.save(c, func(d *diskState) error { delete(d.Connections, conn.ID); return nil }) {
				return
			}
			c.JSON(200, gin.H{"deleted": true})
			return
		}
	}
	if len(parts) == 2 && parts[0] == "accounts" && (m == "PATCH" || m == "DELETE") {
		auth, ok := a.core.GetByID(parts[1])
		if !ok {
			fail(c, 404, "Account not found.")
			return
		}
		if m == "DELETE" {
			if e := a.store.Delete(c.Request.Context(), auth.ID); e != nil {
				fail(c, 500, "Could not remove account.")
				return
			}
			a.core.Remove(c.Request.Context(), auth.ID)
		} else {
			var b struct {
				Enabled *bool `json:"enabled"`
			}
			if !decode(c, &b) {
				return
			}
			if b.Enabled == nil {
				fail(c, 400, "Supply the account state.")
				return
			}
			auth.Disabled = !*b.Enabled
			if _, e := a.core.Update(c.Request.Context(), auth); e != nil {
				fail(c, 500, "Could not update account.")
				return
			}
		}
		c.JSON(200, gin.H{"ok": true})
		return
	}
	if p == "keys" && m == "POST" {
		a.createKey(c)
		return
	}
	if len(parts) == 2 && parts[0] == "keys" {
		if m == "PATCH" {
			a.updateKey(c, parts[1])
			return
		}
		d := a.store.read()
		k, ok := d.Keys[parts[1]]
		if !ok {
			fail(c, 404, "Key not found.")
			return
		}
		if m == "DELETE" {
			if !a.save(c, func(d *diskState) error { delete(d.Keys, k.ID); return nil }) {
				return
			}
			c.JSON(200, gin.H{"deleted": true})
			return
		}
	}
	fail(c, 404, "Route not found.")
}
func (a *App) managementResponse(c *gin.Context, status int, b []byte) {
	if status >= 400 {
		fail(c, status, "Account sign-in could not be completed. Try starting a new sign-in.")
		return
	}
	c.Data(status, "application/json", b)
}
func (a *App) state(c *gin.Context) {
	d := a.store.read()
	conns := []any{}
	for _, v := range d.Connections {
		conns = append(conns, a.publicConnection(v))
	}
	sort.Slice(conns, func(i, j int) bool {
		return conns[i].(gin.H)["provider"].(string) < conns[j].(gin.H)["provider"].(string)
	})
	keys := []Key{}
	for _, k := range d.Keys {
		k.Hash = ""
		k.RequestsToday = d.Usage[usageID(k.ID)]
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].CreatedAt.Before(keys[j].CreatedAt) })
	logs := d.Requests
	if len(logs) > 100 {
		logs = logs[len(logs)-100:]
	}
	reverse := make([]RequestLog, len(logs))
	for i, v := range logs {
		reverse[len(logs)-1-i] = v
	}
	c.JSON(200, gin.H{"connections": conns, "keys": keys, "requests": reverse, "publicUrl": a.publicURL, "daily": d.Daily, "hourly": d.Hourly, "trackingAt": d.TrackingAt, "pricing": gin.H{"asOf": "2026-10-29", "openai": openAIPrices, "claude": claudePrices}, "settings": gin.H{"autoUseResets": d.Settings.AutoUseResets, "hasHubKey": d.Settings.HubTokenHash != ""}})
}
