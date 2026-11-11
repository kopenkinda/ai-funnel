package funnel

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
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

// Grants as claude.ai returned them live on 2026-11-11, plus the ineligible
// answer that used to read as an account with nothing banked.
func TestClaudeLiveGrantsAndIneligibleReason(t *testing.T) {
	parse := func(body string) *ResetCredits {
		var data map[string]any
		if err := json.Unmarshal([]byte(body), &data); err != nil {
			t.Fatal(err)
		}
		credits, err := parseClaudeCredits(data, time.Date(2026, 11, 11, 2, 30, 0, 0, time.UTC))
		if err != nil {
			t.Fatal(err)
		}
		return credits
	}
	credits := parse(`{"cedar_ember":{"eligible":true,"ineligible_reason":null,"at_limit":false,"grants":[
		{"id":"full-reset-2611","label":"One full limit reset (November 2026)","resets_total":1,"resets_left":1,"starts_at":"2026-11-10T21:30:00+00:00","ends_at":"2026-12-10T22:00:00+00:00","clears":["seven_day","seven_day_overage_included"],"paused":false,"usable_now":true,"use_requires_limit":false,"percent_used":{"seven_day":34},"blocking":[],"arm":null,"type":"weekly","unavailable_reason":null,"gives_back_weekly":false},
		{"id":"launch-2610-fable","label":"New model launch","resets_total":1,"resets_left":1,"starts_at":"2026-11-09T18:00:00+00:00","ends_at":"2027-03-09T07:59:00+00:00","clears":["seven_day_overage_included"],"paused":false,"usable_now":true,"use_requires_limit":false,"percent_used":{"seven_day":34},"blocking":[],"arm":null,"type":"full","unavailable_reason":null,"gives_back_weekly":true},
		{"id":"launch-2610-fable-12mo","resets_total":1,"resets_left":1,"starts_at":"2026-11-09T18:00:00+00:00","ends_at":"2027-03-09T07:59:00+00:00","paused":false,"usable_now":true,"type":"full","gives_back_weekly":true},
		{"id":"launch-2610-fable-6mo","resets_total":1,"resets_left":1,"starts_at":"2026-11-09T18:00:00+00:00","ends_at":"2027-03-09T07:59:00+00:00","paused":false,"usable_now":true,"type":"full","gives_back_weekly":true}
	],"next_grant_id":"full-reset-2611","weekly_resets_at":"2026-11-11T21:00:00+00:00","cooldown_until":null,"paused_held":false}}`)
	if credits.Available != 4 || credits.Applicable == nil || *credits.Applicable != 4 || len(credits.Items) != 4 || credits.Items[0].ID != "full-reset-2611" || credits.Ineligible != "" {
		t.Fatalf("live grants were not all counted, soonest expiry first: %+v", credits)
	}
	if kinds := []string{credits.Items[0].Kind, credits.Items[1].Kind, credits.Items[2].Kind, credits.Items[3].Kind}; !slices.Equal(kinds, []string{"weekly", "fable", "fable", "fable"}) {
		t.Fatalf("grants were not named the way Claude names them: %v", kinds)
	}
	credits = parse(`{"cedar_ember":{"eligible":false,"ineligible_reason":"cli_version","grants":[]}}`)
	if credits.Available != 0 || credits.Applicable != nil || credits.Ineligible != "cli_version" {
		t.Fatalf("ineligible reason was not kept: %+v", credits)
	}
}

// The hub mirrors Claude's own endpoints, so a client can list the banked
// resets, choose one and redeem it, for the global key and for per-key hubs.
func TestClaudeResetsThroughUsageHub(t *testing.T) {
	a, x := claudeResetApp(t)
	x.grant["type"] = "weekly"
	a.refresh(context.Background(), a.store.read().Connections["claude"])
	key := Key{ID: "key", Enabled: true, HubHash: digest("sk-hub-scoped"), Grants: []Grant{{ConnectionID: "claude"}}}
	_ = a.store.change(func(d *diskState) error {
		d.Settings.HubTokenHash = digest("sk-hub-global")
		d.Keys[key.ID] = key
		return nil
	})
	router := gin.New()
	router.Any("/v0/management/*path", a.hub)
	call := func(token, index, method, url string, data any) (int, int, string) {
		t.Helper()
		encoded, _ := json.Marshal(data)
		payload, _ := json.Marshal(map[string]string{"auth_index": index, "method": method, "url": url, "data": string(encoded)})
		r := httptest.NewRequest("POST", "/v0/management/api-call", strings.NewReader(string(payload)))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		var out struct {
			StatusCode int    `json:"status_code"`
			Body       string `json:"body"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out.StatusCode, out.Body
	}
	const redeemURL = "https://api.anthropic.com/api/organizations/any/reset_rate_limits"
	scoped := "acct-" + digest("key|claude-account")[:16]
	claim := func(requestID string) map[string]string {
		return map[string]string{"program": "cedar_ember", "grant_id": "grant", "request_id": requestID}
	}
	if _, upstream, body := call("sk-hub-scoped", scoped, "GET", claudeResetUsageURL, nil); upstream != 200 || !strings.Contains(body, "seven_day") || strings.Contains(body, "cedar_ember") {
		t.Fatalf("resets listed without redeem permission: %d %s", upstream, body)
	}
	if status, _, _ := call("sk-hub-scoped", scoped, "POST", redeemURL, claim("first")); status != 403 || len(x.requests) != 0 {
		t.Fatal("hub redeemed without permission", status)
	}
	key.HubResets = true
	_ = a.store.change(func(d *diskState) error { d.Keys[key.ID] = key; return nil })
	for token, index := range map[string]string{"sk-hub-scoped": scoped, "sk-hub-global": "claude-account"} {
		_, upstream, body := call(token, index, "GET", claudeResetUsageURL, nil)
		var usage struct {
			Resets struct {
				Eligible bool   `json:"eligible"`
				Next     string `json:"next_grant_id"`
				Grants   []struct {
					ID     string `json:"id"`
					Left   int    `json:"resets_left"`
					Type   string `json:"type"`
					Usable bool   `json:"usable_now"`
				} `json:"grants"`
			} `json:"cedar_ember"`
		}
		_ = json.Unmarshal([]byte(body), &usage)
		if upstream != 200 || !usage.Resets.Eligible || usage.Resets.Next != "grant" || len(usage.Resets.Grants) != 1 || usage.Resets.Grants[0].Left != 2 || usage.Resets.Grants[0].Type != "weekly" || !usage.Resets.Grants[0].Usable {
			t.Fatalf("%s did not list the banked reset: %d %s", token, upstream, body)
		}
	}
	for range 2 {
		if status, upstream, body := call("sk-hub-scoped", scoped, "POST", redeemURL, claim("first")); status != 200 || upstream != 200 || body != `{"result":"reset"}` {
			t.Fatalf("hub redeem %d/%d %s", status, upstream, body)
		}
	}
	if len(x.requests) != 1 || x.requests[0] != "first" {
		t.Fatalf("a repeated hub request redeemed again: %v", x.requests)
	}
	// A cooldown is no verdict: the same request must reach Claude again.
	x.grant["resets_left"], x.result = 1, "cooldown"
	for range 2 {
		if _, upstream, body := call("sk-hub-global", "claude-account", "POST", redeemURL, claim("cooling")); upstream != 502 || body != "" {
			t.Fatalf("cooldown answered as a result: %d %s", upstream, body)
		}
	}
	if len(x.requests) != 3 {
		t.Fatalf("a cooled-down request was not retried upstream: %v", x.requests)
	}
}

func TestAccountRequestsFollowNewestClaudeClient(t *testing.T) {
	built := claudeClient.version
	t.Cleanup(func() { claudeClient.version = built })
	claudeClient.version = [3]int{2, 1, 322}
	for _, agent := range []string{"claude-cli/2.1.90 (external, cli)", "curl/8.7.1", "claude-cli/9.9.9-evil\r\nX: y", "claude-cli/2.2.4 (external, sdk-ts)", "claude-cli/2.1.400 (external, cli)"} {
		noteClaudeClient(agent)
	}
	r, _ := http.NewRequest("GET", claudeResetUsageURL, nil)
	providerHeaders(r, &core.Auth{Provider: "claude"})
	if got := r.Header.Get("User-Agent"); got != "claude-code/2.2.4" {
		t.Fatalf("account requests present %q, want the newest connected client", got)
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
