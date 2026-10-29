package funnel

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

const resetTestOrg = "c3c0c948-0696-4945-8a7f-a7371f574ca1"

type claudeResetExecutor struct {
	captureExecutor
	grant        map[string]any
	result       string
	lookupFailed bool
	requests     []string
	profileReads int
	onProfile    func()
}

func (x *claudeResetExecutor) HttpRequest(_ context.Context, _ *core.Auth, r *http.Request) (*http.Response, error) {
	if r.Header.Get("anthropic-beta") != "oauth-2025-04-20" {
		return nil, fmt.Errorf("missing OAuth header")
	}
	var data any
	status := 200
	switch {
	case r.Method == "GET" && (r.URL.String() == claudeUsageURL || r.URL.String() == claudeResetUsageURL):
		data = map[string]any{"five_hour": map[string]int{"utilization": 100}, "cedar_ember": map[string]any{"eligible": true, "grants": []any{x.grant}, "next_grant_id": "grant"}}
		if x.lookupFailed {
			status = 503
		}
	case r.Method == "GET" && r.URL.Path == "/api/oauth/profile":
		x.profileReads++
		if x.onProfile != nil {
			x.onProfile()
		}
		data = map[string]any{"organization": map[string]string{"uuid": resetTestOrg, "organization_type": "claude_max", "rate_limit_tier": "default_claude_max_20x"}}
	case r.Method == "POST" && r.URL.String() == "https://api.anthropic.com/api/organizations/"+resetTestOrg+"/reset_rate_limits":
		var p map[string]string
		if json.NewDecoder(r.Body).Decode(&p) != nil || p["program"] != "cedar_ember" || p["grant_id"] != "grant" || p["request_id"] == "" {
			return nil, fmt.Errorf("invalid reset request")
		}
		x.requests = append(x.requests, p["request_id"])
		data = map[string]string{"result": x.result}
	default:
		return nil, fmt.Errorf("unexpected reset endpoint: %s %s", r.Method, r.URL)
	}
	body, _ := json.Marshal(data)
	return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
}

func claudeResetApp(t *testing.T) (*App, *claudeResetExecutor) {
	t.Helper()
	ctx := context.Background()
	s, err := NewStore(t.TempDir(), "claude-reset-test-dashboard-key")
	if err != nil {
		t.Fatal(err)
	}
	m := core.NewManager(s, nil, nil)
	_, err = m.Register(ctx, &core.Auth{ID: "claude-account", Provider: "claude", Unavailable: true,
		Quota: core.QuotaState{Exceeded: true, NextRecoverAt: now().Add(time.Hour)}})
	if err != nil {
		t.Fatal(err)
	}
	x := &claudeResetExecutor{captureExecutor: captureExecutor{provider: "claude"}, result: "reset",
		grant: map[string]any{"id": "grant", "resets_left": 2, "ends_at": now().Add(4 * time.Minute), "usable_now": true}}
	m.RegisterExecutor(x)
	if err := s.change(func(d *diskState) error {
		d.Connections["claude"] = Connection{ID: "claude", Provider: "claude", Enabled: true}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return &App{store: s, core: m}, x
}

func ageClaudeResetAttempt(t *testing.T, a *App) {
	t.Helper()
	if err := a.store.change(func(d *diskState) error {
		attempt := d.ResetAttempts["claude-account|grant"]
		attempt.At = now().Add(-time.Minute)
		d.ResetAttempts["claude-account|grant"] = attempt
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeBankedResetCounts(t *testing.T) {
	at := now()
	var data map[string]any
	err := json.Unmarshal([]byte(`{"cedar_ember":{"eligible":true,"grants":[
		{"id":"banked","resets_left":2,"usable_now":false,"ends_at":"2035-01-01T00:00:00Z"},
		{"id":"no_expiry","resets_left":3,"usable_now":true},
		{"id":"expired","resets_left":5,"usable_now":true,"ends_at":"2020-01-01T00:00:00Z"},
		{"id":"paused","resets_left":5,"paused":true},
		{"id":"invalid","resets_left":5,"ends_at":"bad date"},
		{"id":"fractional","resets_left":1.5},
		{"id":"../unsafe","resets_left":5}
	]}}`), &data)
	if err != nil {
		t.Fatal(err)
	}
	credits, err := parseClaudeCredits(data, at)
	if err != nil || credits.Available != 5 || len(credits.Items) != 2 || credits.Applicable == nil || *credits.Applicable != 3 || credits.Items[1].ExpiresAt != nil {
		t.Fatalf("incorrect banked count or expiry: %+v, %v", credits, err)
	}
}

func TestClaudeResetRetryRestartAndMultipleUses(t *testing.T) {
	ctx := context.Background()
	a, x := claudeResetApp(t)
	a.refresh(ctx, a.store.read().Connections["claude"])
	snapshot := a.store.read().Snapshots["claude-account"]
	if snapshot.ResetCredits == nil || snapshot.ResetCredits.Available != 2 || len(snapshot.Quotas) != 1 {
		t.Fatal("regular usage refresh did not discover Claude grants alongside quotas")
	}
	account := a.publicConnection(a.store.read().Connections["claude"])["accounts"].([]Account)[0]
	if account.Plan != "claude_max" || account.PlanTier != "default_claude_max_20x" {
		t.Fatal("usage refresh did not expose the Claude subscription tier")
	}
	profileReads := x.profileReads
	a.CheckExpiringResets(ctx)
	if len(x.requests) != 0 {
		t.Fatal("automation must default off")
	}
	_ = a.store.change(func(d *diskState) error { d.Settings.AutoUseResets = true; return nil })
	x.result = "not_limited"
	a.CheckExpiringResets(ctx)
	if len(x.requests) != 1 || a.store.read().ResetAttempts["claude-account|grant"].Result != "nothing_to_reset" {
		t.Fatal("due Claude reset was not attempted")
	}
	if auth, _ := a.core.GetByID("claude-account"); !auth.Quota.Exceeded {
		t.Fatal("an unsuccessful reset cleared the cooldown")
	}
	a.CheckExpiringResets(ctx)
	if len(x.requests) != 1 {
		t.Fatal("retry was not throttled")
	}
	ageClaudeResetAttempt(t, a)
	x.result = "unavailable"
	a.CheckExpiringResets(ctx)
	if len(x.requests) != 2 || x.requests[0] == x.requests[1] {
		t.Fatal("a settled rejection reused its request ID")
	}
	ageClaudeResetAttempt(t, a)
	// The server may have applied the unanswered claim before the connection
	// failed. A restart and lower remaining count must still retry that claim.
	x.grant["resets_left"] = 1
	reopened, err := NewStore(a.store.dir, a.store.Admin)
	if err != nil {
		t.Fatal(err)
	}
	a.store = reopened
	a.core = core.NewManager(reopened, nil, nil)
	if err = a.core.Load(ctx); err != nil {
		t.Fatal(err)
	}
	a.core.RegisterExecutor(x)
	x.result = "already_used"
	a.CheckExpiringResets(ctx)
	if len(x.requests) != 3 || x.requests[1] != x.requests[2] {
		t.Fatal("unconfirmed request changed after restart or count decrease")
	}
	if x.profileReads != profileReads+1 {
		t.Fatal("organization was not persisted")
	}
	if auth, _ := a.core.GetByID("claude-account"); auth.Unavailable || auth.Quota.Exceeded {
		t.Fatal("successful Claude reset left the account in cooldown")
	}
	public := a.publicConnection(reopened.read().Connections["claude"])
	accounts := public["accounts"].([]Account)
	if accounts[0].ResetCredits.Available != 1 {
		t.Fatal("using one reset hid the rest of the grant")
	}
	ageClaudeResetAttempt(t, a)
	x.result = "reset"
	a.CheckExpiringResets(ctx)
	if len(x.requests) != 4 || x.requests[3] == x.requests[2] {
		t.Fatal("next reset in the grant did not get its own request ID")
	}
	ageClaudeResetAttempt(t, a)
	a.CheckExpiringResets(ctx)
	if len(x.requests) != 4 {
		t.Fatal("a stale grant count caused a duplicate reset")
	}
}

func TestClaudeResetEligibilityAndFailedDiscovery(t *testing.T) {
	ctx := context.Background()
	a, x := claudeResetApp(t)
	_ = a.store.change(func(d *diskState) error { d.Settings.AutoUseResets = true; return nil })
	for _, expiry := range []any{nil, now().Add(-time.Minute), now().Add(time.Hour)} {
		x.grant["ends_at"] = expiry
		_ = a.store.change(func(d *diskState) error { d.Snapshots = map[string]Snapshot{}; return nil })
		a.CheckExpiringResets(ctx)
	}
	x.grant["ends_at"] = now().Add(4 * time.Minute)
	x.grant["usable_now"] = false
	_ = a.store.change(func(d *diskState) error { d.Snapshots = map[string]Snapshot{}; return nil })
	a.CheckExpiringResets(ctx)
	if credits := a.store.read().Snapshots["claude-account"].ResetCredits; credits.Available != 2 {
		t.Fatal("unusable resets should still be counted as banked")
	}
	x.grant["usable_now"] = true
	x.lookupFailed = true
	a.CheckExpiringResets(ctx)
	if credits := a.store.read().Snapshots["claude-account"].ResetCredits; credits.Available != 2 || credits.Error == "" {
		t.Fatal("failed discovery did not preserve the snapshot and report an error")
	}
	x.lookupFailed = false
	// A setting change during the profile lookup must prevent the pending POST.
	x.onProfile = func() {
		_ = a.store.change(func(d *diskState) error { d.Settings.AutoUseResets = false; return nil })
	}
	a.CheckExpiringResets(ctx)
	if len(x.requests) != 0 {
		t.Fatal("an ineligible, expired, unverified, or disabled reset was redeemed")
	}
}
