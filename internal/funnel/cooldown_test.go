package funnel

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

type usageLimit struct{}

func (usageLimit) Error() string {
	return `{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":3600}}`
}
func (usageLimit) StatusCode() int { return 429 }

type limitedExecutor struct{ captureExecutor }

func (x *limitedExecutor) Execute(ctx context.Context, a *core.Auth, r executor.Request, o executor.Options) (executor.Response, error) {
	if a.ID == "account-a" {
		return executor.Response{}, usageLimit{}
	}
	return x.captureExecutor.Execute(ctx, a, r, o)
}

// The SDK only reports its cooldown 429 when the whole pool is cooling down. A
// key limited to rate-limited accounts must still get a 429 with a reset time
// while an account outside the key is healthy, instead of a generic 503.
func TestRestrictedKeyCooldownKeepsResetTime(t *testing.T) {
	store, e := NewStore(t.TempDir(), "cooldown-test-dashboard-key")
	if e != nil {
		t.Fatal(e)
	}
	for _, id := range []string{"account-a", "account-b"} {
		if _, e = store.Save(context.Background(), &core.Auth{ID: id, Provider: "codex", Status: core.StatusActive, Metadata: map[string]any{"type": "codex", "email": id + "@example.com", "access_token": "fixture", "plan_type": "plus"}, LastRefreshedAt: now(), NextRefreshAfter: now().Add(24 * time.Hour)}); e != nil {
			t.Fatal(e)
		}
	}
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	app, svc, e := NewRuntime(store, "127.0.0.1", port, "", t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- svc.Run(ctx) }()
	defer func() { cancel(); <-done }()
	root := fmt.Sprintf("http://127.0.0.1:%d", port)
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if r, e := http.Get(root + "/healthz"); e == nil {
			r.Body.Close()
			break
		} else if time.Now().After(deadline) {
			t.Fatal(e)
		}
	}
	time.Sleep(250 * time.Millisecond)
	app.core.RegisterExecutor(&limitedExecutor{})
	request := func(method, path, token, body string) (int, string) {
		t.Helper()
		r, _ := http.NewRequest(method, root+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+token)
		response, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		b, _ := io.ReadAll(response.Body)
		return response.StatusCode, string(b)
	}
	if status, b := request("POST", "/api/connections", store.Admin, `{"provider":"codex","name":"Codex"}`); status != 201 {
		t.Fatal(status, b)
	}
	status, b := request("POST", "/api/keys", store.Admin, `{"name":"A only","dailyLimit":null,"grants":[{"connectionId":"codex","accountIds":["account-a"],"models":null}]}`)
	if status != 201 {
		t.Fatal(status, b)
	}
	var key struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal([]byte(b), &key)
	_, b = request("GET", "/api/state", store.Admin, "")
	var state struct {
		Connections []struct {
			Models []string `json:"models"`
		} `json:"connections"`
	}
	if e = json.Unmarshal([]byte(b), &state); e != nil || len(state.Connections) == 0 || len(state.Connections[0].Models) == 0 {
		t.Fatalf("no models: %s", b)
	}
	path, payload := "/providers/codex/codex/v1/responses", fmt.Sprintf(`{"model":%q,"input":"hi"}`, state.Connections[0].Models[0])
	if status, b := request("POST", path, key.Token, payload); status != 429 || !strings.Contains(b, "usage_limit_reached") {
		t.Fatalf("first turn: %d %s", status, b)
	}
	if status, b := request("POST", path, key.Token, payload); status != 429 || !strings.Contains(b, "model_cooldown") || strings.Contains(b, `"reset_seconds":0`) {
		t.Fatalf("cooling key lost its reset time: %d %s", status, b)
	}
}
