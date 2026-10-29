package funnel

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type resetExecutor struct {
	captureExecutor
	credit   ResetCredit
	result   string
	requests []string
}

func (x *resetExecutor) HttpRequest(_ context.Context, _ *core.Auth, r *http.Request) (*http.Response, error) {
	var body []byte
	if r.Method == "GET" {
		body, _ = json.Marshal(map[string]any{"credits": []ResetCredit{x.credit}})
	} else {
		var p map[string]string
		_ = json.NewDecoder(r.Body).Decode(&p)
		x.requests = append(x.requests, p["redeem_request_id"])
		body, _ = json.Marshal(map[string]string{"code": x.result})
	}
	return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
}
func TestExpiringResetScheduleAndRestart(t *testing.T) {
	ctx := context.Background()
	s, err := NewStore(t.TempDir(), "reset-test-dashboard-key")
	if err != nil {
		t.Fatal(err)
	}
	m := core.NewManager(s, nil, nil)
	auth, err := m.Register(ctx, &core.Auth{ID: "account", Provider: "codex", Metadata: map[string]any{"account_id": "account-id"},
		Unavailable: true, Quota: core.QuotaState{Exceeded: true, NextRecoverAt: now().Add(time.Hour)},
		ModelStates: map[string]*core.ModelState{"gpt-6.1-sol": {Unavailable: true, Quota: core.QuotaState{Exceeded: true, NextRecoverAt: now().Add(time.Hour)}}}})
	if err != nil {
		t.Fatal(err)
	}
	expiry := now().Add(4 * time.Minute)
	x := &resetExecutor{credit: ResetCredit{ID: "credit", Status: "available", ResetType: "codex_rate_limits", ExpiresAt: &expiry}, result: "nothing_to_reset"}
	m.RegisterExecutor(x)
	a := &App{store: s, core: m}
	_ = s.change(func(d *diskState) error {
		d.Connections["codex"] = Connection{ID: "codex", Provider: "codex", Enabled: true}
		d.Snapshots[auth.ID] = Snapshot{ResetCredits: &ResetCredits{Items: []ResetCredit{x.credit}}}
		return nil
	})
	a.CheckExpiringResets(ctx)
	if len(x.requests) != 0 {
		t.Fatal("automation must default off")
	}
	_ = s.change(func(d *diskState) error { d.Settings.AutoUseResets = true; return nil })
	a.CheckExpiringResets(ctx)
	if len(x.requests) != 1 {
		t.Fatal("due credit not attempted")
	}
	if current, _ := m.GetByID(auth.ID); !current.Quota.Exceeded {
		t.Fatal("an unsuccessful reset cleared the cooldown")
	}
	a.CheckExpiringResets(ctx)
	if len(x.requests) != 1 {
		t.Fatal("retry was not throttled")
	}
	_ = s.change(func(d *diskState) error {
		v := d.ResetAttempts[auth.ID+"|credit"]
		v.At = now().Add(-time.Minute)
		d.ResetAttempts[auth.ID+"|credit"] = v
		return nil
	})
	x.result = "reset"
	a.CheckExpiringResets(ctx)
	if len(x.requests) != 2 || x.requests[0] != x.requests[1] || x.requests[0] != resetRequestID("account-id", "credit") {
		t.Fatal("retry idempotency changed")
	}
	if current, _ := m.GetByID(auth.ID); current.Unavailable || current.Quota.Exceeded || current.ModelStates["gpt-6.1-sol"].Unavailable {
		t.Fatal("a redeemed reset left the account in cooldown")
	}
	reopened, err := NewStore(s.dir, s.Admin)
	if err != nil {
		t.Fatal(err)
	}
	a.store = reopened
	a.CheckExpiringResets(ctx)
	if len(x.requests) != 2 {
		t.Fatal("redeemed credit repeated after restart")
	}
	for _, expiry := range []time.Time{now().Add(-time.Minute), now().Add(time.Hour)} {
		x.credit.ExpiresAt = &expiry
		_ = reopened.change(func(d *diskState) error {
			d.ResetAttempts = nil
			d.Snapshots[auth.ID] = Snapshot{ResetCredits: &ResetCredits{Items: []ResetCredit{x.credit}}}
			return nil
		})
		a.CheckExpiringResets(ctx)
	}
	if len(x.requests) != 2 {
		t.Fatal("expired or distant credit was consumed")
	}
}
