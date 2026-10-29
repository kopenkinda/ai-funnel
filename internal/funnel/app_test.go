package funnel

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

type loginTokens struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
}

func (*loginTokens) SaveTokenToFile(string) error {
	return fmt.Errorf("plaintext token storage must not be used")
}

func TestOAuthStorageSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	s, e := NewStore(dir, "storage-test-dashboard-key")
	if e != nil {
		t.Fatal(e)
	}
	auth := &core.Auth{ID: "new-login", Provider: "codex", Metadata: map[string]any{"email": "person@example.com"}, Storage: &loginTokens{"initial-access-token", "initial-refresh-token"}}
	if _, e = s.Save(context.Background(), auth); e != nil {
		t.Fatal(e)
	}
	// A successful first request needs the same tokens as a later process restart.
	if auth.Metadata["refresh_token"] != "initial-refresh-token" {
		t.Fatal("new login did not receive refresh credentials")
	}
	s, e = NewStore(dir, s.Admin)
	if e != nil {
		t.Fatal(e)
	}
	auths, e := s.List(context.Background())
	if e != nil || len(auths) != 1 || auths[0].Metadata["access_token"] != "initial-access-token" || auths[0].Metadata["refresh_token"] != "initial-refresh-token" {
		t.Fatal("OAuth token storage was lost on restart", e)
	}
	data, e := os.ReadFile(filepath.Join(dir, "state.enc"))
	if e != nil || strings.Contains(string(data), "initial-refresh-token") {
		t.Fatal("credentials were not encrypted", e)
	}
}

func TestOpenCodeForwarding(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/inference/go/anthropic/v1/messages" || r.Header.Get("Authorization") != "Bearer upstream-fixture" || r.Header.Get("Cookie") != "" || r.Header.Get("X-Api-Key") != "" || r.Header.Get("X-Opencode-Session") != "conversation-fixture" {
			t.Error("provider route, credentials, or session were changed incorrectly")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Set-Cookie", "upstream-cookie=private")
		_, _ = io.WriteString(w, "event: message_stop\ndata: {}\n\n")
	}))
	defer upstream.Close()
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.Request = httptest.NewRequest("POST", "/providers/go/connection/anthropic/v1/messages", nil).WithContext(ctx)
	c.Request.Header.Set("Authorization", "Bearer device-fixture")
	c.Request.Header.Set("X-Api-Key", "device-fixture")
	c.Request.Header.Set("Cookie", "funnel_session=private")
	c.Request.Header.Set("X-Opencode-Session", "conversation-fixture")
	a := &App{}
	a.openCode(c, Connection{URL: upstream.URL + "/inference/go", APIKey: "upstream-fixture"}, Grant{}, "/anthropic/v1/messages", []byte(`{"model":"example"}`))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "message_stop") || w.Header().Get("Set-Cookie") != "" {
		t.Fatal("native stream or response isolation failed")
	}
}

type captureExecutor struct {
	provider string
	mu       sync.Mutex
	ids      []string
}

func (x *captureExecutor) Identifier() string {
	if x.provider != "" {
		return x.provider
	}
	return "codex"
}
func (x *captureExecutor) Execute(_ context.Context, a *core.Auth, r executor.Request, _ executor.Options) (executor.Response, error) {
	x.mu.Lock()
	x.ids = append(x.ids, a.ID)
	x.mu.Unlock()
	if a.Provider == "claude" {
		return executor.Response{Payload: []byte(`{"id":"msg_fixture","type":"message","role":"assistant","content":[],"stop_reason":"end_turn"}`)}, nil
	}
	return executor.Response{Payload: []byte(`{"id":"resp_fixture","object":"response","status":"completed","output":[]}`)}, nil
}
func (x *captureExecutor) ExecuteStream(ctx context.Context, a *core.Auth, r executor.Request, o executor.Options) (*executor.StreamResult, error) {
	_, _ = x.Execute(ctx, a, r, o)
	ch := make(chan executor.StreamChunk, 1)
	ch <- executor.StreamChunk{Payload: []byte("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_fixture\",\"status\":\"completed\",\"output\":[]}}\n\n")}
	close(ch)
	return &executor.StreamResult{Chunks: ch}, nil
}
func (*captureExecutor) Refresh(_ context.Context, a *core.Auth) (*core.Auth, error) { return a, nil }
func (*captureExecutor) CountTokens(context.Context, *core.Auth, executor.Request, executor.Options) (executor.Response, error) {
	return executor.Response{}, fmt.Errorf("not used")
}
func (*captureExecutor) HttpRequest(context.Context, *core.Auth, *http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"rate_limit":{"primary_window":{"used_percent":100,"reset_at":1900000000,"limit_window_seconds":18000},"secondary_window":{"used_percent":20,"reset_at":1900000000,"limit_window_seconds":604800}}}`))}, nil
}
func TestEmbeddedService(t *testing.T) {
	dir := t.TempDir()
	store, e := NewStore(dir, "embedded-test-dashboard-key")
	if e != nil {
		t.Fatal(e)
	}
	for _, id := range []string{"account-a", "account-b@example.com.json"} {
		_, e = store.Save(context.Background(), &core.Auth{ID: id, Provider: "codex", Status: core.StatusActive, Metadata: map[string]any{"type": "codex", "email": id + "@example.com", "access_token": "fixture-private-access-token", "plan_type": "plus"}, LastRefreshedAt: now(), NextRefreshAfter: now().Add(24 * time.Hour)})
		if e != nil {
			t.Fatal(e)
		}
	}
	_, e = store.Save(context.Background(), &core.Auth{ID: "account-c", Provider: "claude", Status: core.StatusActive, Metadata: map[string]any{"type": "claude", "email": "c@example.com", "access_token": "fixture-claude-token"}, LastRefreshedAt: now(), NextRefreshAfter: now().Add(24 * time.Hour)})
	if e != nil {
		t.Fatal(e)
	}
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	app, svc, e := NewRuntime(store, "127.0.0.1", port, "", t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- svc.Run(ctx) }()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("shutdown timed out")
		}
	}()
	root := fmt.Sprintf("http://127.0.0.1:%d", port)
	client := &http.Client{Timeout: 5 * time.Second}
	deadline := time.Now().Add(10 * time.Second)
	for {
		r, e := client.Get(root + "/healthz")
		if e == nil {
			r.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("server did not start", e)
		}
		time.Sleep(20 * time.Millisecond)
	}
	// Wait for the SDK's post-start model registration before replacing its executor.
	time.Sleep(250 * time.Millisecond)
	capture := &captureExecutor{}
	app.core.RegisterExecutor(capture)
	app.core.RegisterExecutor(&captureExecutor{provider: "claude"})
	request := func(method, path, token, body string) (int, []byte) {
		t.Helper()
		r, _ := http.NewRequest(method, root+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		response, e := client.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		b, e := io.ReadAll(response.Body)
		if e != nil {
			t.Fatal(e)
		}
		return response.StatusCode, b
	}
	admin := store.Admin
	t.Run("dashboard auth and raw routes", func(t *testing.T) {
		for _, p := range []string{"/v8/management/credentials", "/v1/models", "/v0/management/config"} {
			status, _ := request("GET", p, admin, "")
			if status != 404 {
				t.Fatalf("raw route %s status %d", p, status)
			}
		}
		status, _ := request("GET", "/api/state", "", "")
		if status != 401 {
			t.Fatal(status)
		}
		r, _ := http.NewRequest("POST", root+"/api/connections", strings.NewReader(`{"provider":"codex","name":"Codex"}`))
		r.Header.Set("Authorization", "Bearer "+admin)
		r.Header.Set("Origin", "https://foreign.example")
		response, e := client.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		response.Body.Close()
		if response.StatusCode != 403 {
			t.Fatal(response.StatusCode)
		}
	})
	status, b := request("POST", "/api/connections", admin, `{"provider":"codex","name":"Codex"}`)
	if status != 201 {
		t.Fatalf("pool %d %s", status, b)
	}
	status, b = request("GET", "/api/state", admin, "")
	if status != 200 || strings.Contains(string(b), "fixture-private-access-token") {
		t.Fatalf("state leaked credentials: %d", status)
	}
	var state struct {
		Connections []struct {
			Models []string `json:"models"`
		} `json:"connections"`
	}
	_ = json.Unmarshal(b, &state)
	if len(state.Connections) != 1 || len(state.Connections[0].Models) == 0 {
		t.Fatalf("SDK models not registered: %s", b)
	}
	model := state.Connections[0].Models[0]
	for _, m := range state.Connections[0].Models {
		if m == "gpt-5.4" {
			model = m
		}
	}
	makeKey := func(limit string) string {
		t.Helper()
		payload := fmt.Sprintf(`{"name":"Devices","dailyLimit":%s,"grants":[{"connectionId":"codex","accountIds":["account-b@example.com.json"],"models":[%q]}]}`, limit, model)
		status, b := request("POST", "/api/keys", admin, payload)
		if status != 201 {
			t.Fatalf("key %d %s", status, b)
		}
		var result struct {
			Token string `json:"token"`
		}
		_ = json.Unmarshal(b, &result)
		return result.Token
	}
	key := makeKey("null")
	path := "/providers/codex/codex/v1/responses"
	payload := fmt.Sprintf(`{"model":%q,"input":"test"}`, model)
	t.Run("native execution and scoped selection", func(t *testing.T) {
		status, b := request("POST", path, key, payload)
		if status != 200 || !strings.Contains(string(b), "resp_fixture") {
			t.Fatalf("inference %d %s", status, b)
		}
		capture.mu.Lock()
		defer capture.mu.Unlock()
		if len(capture.ids) != 1 || capture.ids[0] != "account-b@example.com.json" {
			t.Fatal(capture.ids)
		}
	})
	t.Run("streaming and model restriction", func(t *testing.T) {
		stream := strings.TrimSuffix(payload, "}") + `,"stream":true}`
		status, b := request("POST", path, key, stream)
		if status != 200 || !strings.Contains(string(b), "response.completed") {
			t.Fatalf("stream %d %s", status, b)
		}
		status, _ = request("POST", path, key, `{"model":"forbidden","input":"test"}`)
		if status != 403 {
			t.Fatal(status)
		}
		status, _ = request("GET", "/api/state", key, "")
		if status != 401 {
			t.Fatal(status)
		}
	})
	t.Run("parallel requests cannot exceed daily cap", func(t *testing.T) {
		limited := makeKey("1")
		var wg sync.WaitGroup
		statuses := make(chan int, 6)
		for range 6 {
			wg.Add(1)
			go func() { defer wg.Done(); s, _ := request("POST", path, limited, payload); statuses <- s }()
		}
		wg.Wait()
		close(statuses)
		success, limitedCount := 0, 0
		for s := range statuses {
			if s == 200 {
				success++
			} else if s == 429 {
				limitedCount++
			} else {
				t.Error(s)
			}
		}
		if success != 1 || limitedCount != 5 {
			t.Fatal(success, limitedCount)
		}
	})
	t.Run("Claude uses native messages and cannot borrow Codex accounts", func(t *testing.T) {
		status, b := request("POST", "/api/connections", admin, `{"provider":"claude","name":"Claude"}`)
		if status != 201 {
			t.Fatalf("pool %d %s", status, b)
		}
		var pool struct {
			Models []string `json:"models"`
		}
		_ = json.Unmarshal(b, &pool)
		if len(pool.Models) == 0 {
			t.Fatal("Claude models missing")
		}
		claudeModel := pool.Models[0]
		payload := fmt.Sprintf(`{"name":"Claude device","grants":[{"connectionId":"claude","accountIds":["account-c"],"models":null}]}`)
		status, b = request("POST", "/api/keys", admin, payload)
		if status != 201 {
			t.Fatalf("key %d %s", status, b)
		}
		var key struct {
			Token string `json:"token"`
		}
		_ = json.Unmarshal(b, &key)
		status, b = request("POST", "/providers/claude/claude/v1/messages", key.Token, fmt.Sprintf(`{"model":%q,"max_tokens":10,"messages":[{"role":"user","content":"Hello"}]}`, claudeModel))
		if status != 200 || !strings.Contains(string(b), "msg_fixture") {
			t.Fatalf("Claude %d %s", status, b)
		}
		status, _ = request("POST", "/providers/claude/claude/v1/messages", key.Token, fmt.Sprintf(`{"model":%q,"max_tokens":10,"messages":[]}`, model))
		if status < 400 {
			t.Fatal("cross-provider routing was allowed")
		}
	})
	t.Run("paused and deleted assignments fail closed", func(t *testing.T) {
		status, b := request("PATCH", "/api/accounts/account-b%40example.com.json", admin, `{"enabled":false}`)
		if status != 200 {
			t.Fatalf("pause %d %s", status, b)
		}
		status, _ = request("POST", path, key, payload)
		if status < 400 {
			t.Fatal(status)
		}
		status, _ = request("DELETE", "/api/accounts/account-b%40example.com.json", admin, "")
		if status != 200 {
			t.Fatal(status)
		}
		status, _ = request("POST", path, key, payload)
		if status != 503 {
			t.Fatal(status)
		}
	})
	t.Run("quota refresh preserves exhausted allowance", func(t *testing.T) {
		status, b := request("POST", "/api/connections/codex/sync", admin, "")
		if status != 200 || !strings.Contains(string(b), `"remaining":0`) {
			t.Fatalf("quota %d %s", status, b)
		}
	})
	t.Run("encrypted credentials survive restart", func(t *testing.T) {
		raw, e := os.ReadFile(filepath.Join(dir, "state.enc"))
		if e != nil {
			t.Fatal(e)
		}
		if strings.Contains(string(raw), "fixture-private-access-token") || strings.Contains(string(raw), key) {
			t.Fatal("plaintext secret persisted")
		}
		reopened, e := NewStore(dir, admin)
		if e != nil {
			t.Fatal(e)
		}
		auths, e := reopened.List(ctx)
		if e != nil || len(auths) != 2 {
			t.Fatal("credential round trip failed", e)
		}
		if len(reopened.read().Keys) < 2 {
			t.Fatal("key policy not persisted")
		}
	})
	t.Run("credential import activates models and preserves account assignments", func(t *testing.T) {
		input := `{"provider":"codex","auth":{"tokens":{"access_token":"import-fixture-access-token","refresh_token":"import-fixture-refresh-token","account_id":"import-fixture-account"},"expired":"2099-01-01T00:00:00Z","email":"import@example.com","plan_type":"plus","proxy_url":"https://forbidden.example"}}`
		status, _ := request("POST", "/api/accounts/import", "", input)
		if status != 401 {
			t.Fatal("import bypassed dashboard auth", status)
		}
		status, data := request("POST", "/api/accounts/import", admin, input)
		if status != 201 || strings.Contains(string(data), "import-fixture-access-token") || strings.Contains(string(data), "import-fixture-refresh-token") {
			t.Fatal("credential import failed or leaked tokens", status)
		}
		id := ""
		for _, auth := range app.core.List() {
			if str(auth.Metadata["email"]) == "import@example.com" {
				id = auth.ID
				if auth.ProxyURL != "" || str(auth.Metadata["proxy_url"]) != "" {
					t.Fatal("import changed upstream routing")
				}
			}
		}
		if id == "" {
			t.Fatal("imported account missing")
		}
		// SDK activation installs its provider executor. Restore the controlled one
		// before inference so this test cannot send fixture credentials upstream.
		app.core.RegisterExecutor(capture)
		status, data = request("POST", "/api/keys", admin, fmt.Sprintf(`{"name":"Imported account","grants":[{"connectionId":"codex","accountIds":[%q],"models":null}]}`, id))
		if status != 201 {
			t.Fatal("could not assign imported account", status)
		}
		var created struct{ Token string }
		_ = json.Unmarshal(data, &created)
		status, data = request("POST", path, created.Token, payload)
		if status != 200 || !strings.Contains(string(data), "resp_fixture") {
			t.Fatal("imported account was not available for inference", status)
		}
		_, _ = request("PATCH", "/api/accounts/"+id, admin, `{"enabled":false}`)
		count := len(app.core.List())
		status, _ = request("POST", "/api/accounts/import", admin, input)
		auth, ok := app.core.GetByID(id)
		if status != 201 || !ok || !auth.Disabled || len(app.core.List()) != count {
			t.Fatal("re-import duplicated or unpaused the account", status)
		}
		reopened, e := NewStore(dir, admin)
		if e != nil || str(reopened.read().Auths[id].Metadata["refresh_token"]) != "import-fixture-refresh-token" {
			t.Fatal("imported refresh token did not persist", e)
		}
		status, _ = request("POST", "/api/accounts/import", admin, `{"provider":"claude","token":"sk-ant-oat01-fixture-setup-token"}`)
		if status != 201 {
			t.Fatal("Claude setup token import failed", status)
		}
		status, _ = request("POST", "/api/accounts/import", admin, `{"provider":"codex","auth":{"type":"claude","access_token":"fixture-claude-access-token"}}`)
		if status != 400 {
			t.Fatal("wrong-provider credentials accepted", status)
		}
	})
}
