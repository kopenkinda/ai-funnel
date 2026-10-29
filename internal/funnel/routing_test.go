package funnel

import (
	"context"
	"net/http"
	"testing"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

var routingNow = time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)

func window(label string, remaining float64, reset time.Duration) Quota {
	t := routingNow.Add(reset)
	return Quota{Label: label, Remaining: &remaining, ResetsAt: &t}
}
func usage(plan string, primary, secondary float64, primaryReset, secondaryReset time.Duration) Snapshot {
	return Snapshot{Plan: plan, Quotas: []Quota{window("5h", 100-primary, primaryReset), window("7d", 100-secondary, secondaryReset)}}
}
func routingAccounts(provider string, ids ...string) []*core.Auth {
	out := []*core.Auth{}
	for _, id := range ids {
		out = append(out, &core.Auth{ID: id, Provider: provider, Status: core.StatusActive, Metadata: map[string]any{}})
	}
	return out
}

type routingFixture struct {
	route Routing
	snaps map[string]Snapshot
	draw  float64
	sel   *selector
}

func newRoutingFixture(route Routing, snaps map[string]Snapshot) *routingFixture {
	f := &routingFixture{route: route, snaps: snaps}
	f.sel = &selector{
		inputs: func(string, []string) (Routing, map[string]Snapshot) { return f.route, f.snaps },
		now:    func() time.Time { return routingNow },
		random: func() float64 { return f.draw },
	}
	return f
}
func (f *routingFixture) pick(t *testing.T, sc scope, model string, headers http.Header, auths []*core.Auth) (string, error) {
	t.Helper()
	ctx := context.WithValue(context.Background(), scopeKey{}, sc)
	a, err := f.sel.Pick(ctx, sc.provider, model, executor.Options{Headers: headers, Metadata: map[string]any{}}, auths)
	if err != nil {
		return "", err
	}
	return a.ID, nil
}
func routeWith(strategy string, edit ...func(*Routing)) Routing {
	r := defaultRouting()
	r.Strategy = strategy
	r.StickySessions = false
	for _, fn := range edit {
		fn(&r)
	}
	return r
}

func TestQuotaWindowsFollowModelPlanAndReset(t *testing.T) {
	auth := &core.Auth{Metadata: map[string]any{"plan_type": "plus"}}
	snap := Snapshot{Quotas: []Quota{
		window("5h", 0, -time.Minute),
		window("7d", 40, 3*24*time.Hour),
		window("Spark 5h", 0, time.Hour),
		window("Code review 7d", 0, time.Hour),
	}}
	q := quotaFor("codex", "gpt-5.3-codex", snap, auth, routingNow)
	if q.exhausted || q.primaryUsed() != 0 || q.secondaryUsed() != 60 || q.capacity != 1 {
		t.Fatalf("stale primary or unrelated scoped windows changed routing: %+v", q)
	}
	if q := quotaFor("codex", "gpt-5.3-codex-spark", snap, auth, routingNow); !q.exhausted || q.primaryUsed() != 100 {
		t.Fatalf("model limit did not apply: %+v", q)
	}
	claude := Snapshot{PlanTier: "default_claude_max_20x", Quotas: []Quota{window("5h", 90, time.Hour), window("7d", 70, 24*time.Hour), window("Opus 7d", 10, 24*time.Hour), window("Extra", 0, time.Hour)}}
	if q := quotaFor("claude", "claude-sonnet-4-5", claude, auth, routingNow); q.secondaryUsed() != 30 || q.capacity != 20 || q.exhausted {
		t.Fatalf("Claude account-wide windows: %+v", q)
	}
	if q := quotaFor("claude", "claude-opus-4-5", claude, auth, routingNow); q.secondaryUsed() != 90 {
		t.Fatalf("Claude model weekly limit ignored: %+v", q)
	}
	weekly := Snapshot{Quotas: []Quota{window("7d", 25, 2*24*time.Hour)}}
	if q := quotaFor("codex", "gpt-5.4", weekly, &core.Auth{Metadata: map[string]any{"plan_type": "pro"}}, routingNow); q.primary != nil || q.primaryUsed() != 75 || q.secondaryUsed() != 75 || q.remaining() != 2.5 {
		t.Fatalf("weekly-only plan: %+v", q)
	}
	if q := quotaFor("codex", "gpt-5.4", Snapshot{}, &core.Auth{}, routingNow); q.exhausted || q.remaining() != 1 {
		t.Fatalf("missing quota data must stay routable: %+v", q)
	}
}

func TestRoutingStrategies(t *testing.T) {
	auths := routingAccounts("codex", "a", "b", "c")
	sc := scope{provider: "codex"}
	snaps := map[string]Snapshot{
		"a": usage("plus", 80, 50, time.Hour, 24*time.Hour),
		"b": usage("pro", 20, 50, 4*time.Hour, 5*24*time.Hour),
		"c": usage("prolite", 50, 10, 2*time.Hour, 6*24*time.Hour+time.Hour),
	}
	for _, tc := range []struct {
		name  string
		route Routing
		draw  float64
		want  string
	}{
		// Weights: a 1x * 50% = 0.5, b 10x * 50% = 5, c 5x * 90% = 4.5.
		{"capacity weighted draws by plan headroom", routeWith("capacity_weighted", func(r *Routing) { r.PreferEarlierReset = false }), 0.03, "a"},
		{"capacity weighted favors larger plans", routeWith("capacity_weighted", func(r *Routing) { r.PreferEarlierReset = false }), 0.3, "b"},
		{"capacity weighted keeps the earliest secondary reset", routeWith("capacity_weighted"), 0.99, "a"},
		{"usage weighted uses lowest secondary", routeWith("usage_weighted", func(r *Routing) { r.PreferEarlierReset = false }), 0, "c"},
		{"usage weighted respects reset preference", routeWith("usage_weighted"), 0, "a"},
		{"fill first drains highest primary", routeWith("fill_first", func(r *Routing) { r.PreferEarlierReset = false }), 0, "a"},
		{"sequential drain uses smaller plans first", routeWith("sequential_drain"), 0, "a"},
		{"reset drain uses nearest secondary day", routeWith("reset_drain"), 0, "a"},
		{"single account", routeWith("single_account", func(r *Routing) { r.AccountID = "c" }), 0, "c"},
		{"round robin starts in ID order", routeWith("round_robin"), 0, "a"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newRoutingFixture(tc.route, snaps)
			f.draw = tc.draw
			got, err := f.pick(t, sc, "gpt-5.4", nil, auths)
			if err != nil || got != tc.want {
				t.Fatalf("got %q %v, want %q", got, err, tc.want)
			}
		})
	}
	t.Run("relative availability divides headroom by time to reset", func(t *testing.T) {
		snaps := map[string]Snapshot{
			"a": usage("pro", 0, 50, time.Hour, 24*time.Hour),
			"b": usage("pro", 0, 50, time.Hour, 6*24*time.Hour),
			"c": usage("plus", 0, 95, time.Hour, 6*24*time.Hour),
		}
		f := newRoutingFixture(routeWith("relative_availability"), snaps)
		// Scores are 6:1 for a and b, so b weighs 1/36 and is below the floor.
		for _, draw := range []float64{0, 0.99} {
			f.draw = draw
			if got, _ := f.pick(t, sc, "gpt-5.4", nil, auths); got != "a" {
				t.Fatalf("draw %v picked %q", draw, got)
			}
		}
		f.route.Power = 0.5
		f.route.TopK = 2
		f.draw = 0.99
		if got, _ := f.pick(t, sc, "gpt-5.4", nil, auths); got != "b" {
			t.Fatalf("lower exponent did not widen the draw: %q", got)
		}
	})
	t.Run("usage weighted alternates equal accounts", func(t *testing.T) {
		f := newRoutingFixture(routeWith("usage_weighted"), map[string]Snapshot{})
		first, _ := f.pick(t, sc, "gpt-5.4", nil, auths[:2])
		second, _ := f.sel.Pick(context.WithValue(context.Background(), scopeKey{}, sc), "codex", "gpt-5.4", executor.Options{}, auths[:2])
		if first == second.ID {
			t.Fatal("equal accounts did not alternate")
		}
	})
}

func TestRoutingEligibility(t *testing.T) {
	auths := routingAccounts("codex", "a", "b")
	sc := scope{provider: "codex"}
	exhausted := usage("pro", 100, 40, time.Hour, 3*24*time.Hour)
	f := newRoutingFixture(routeWith("fill_first"), map[string]Snapshot{"a": exhausted, "b": usage("plus", 0, 10, time.Hour, 3*24*time.Hour)})
	if got, _ := f.pick(t, sc, "gpt-5.4", nil, auths); got != "b" {
		t.Fatalf("exhausted account preferred: %q", got)
	}
	f.snaps["a"] = usage("pro", 100, 40, -time.Minute, 3*24*time.Hour)
	if got, _ := f.pick(t, sc, "gpt-5.4", nil, auths); got != "a" {
		t.Fatalf("window that already reset still blocked routing: %q", got)
	}
	f.snaps = map[string]Snapshot{"a": exhausted, "b": exhausted}
	if got, err := f.pick(t, sc, "gpt-5.4", nil, auths); err != nil || got == "" {
		t.Fatalf("all-exhausted pool must spill over to the SDK: %v", err)
	}
	f.snaps = map[string]Snapshot{"a": {Quotas: []Quota{window("Spark 5h", 0, time.Hour)}}}
	if got, _ := f.pick(t, sc, "gpt-5.3-codex-spark", nil, auths); got != "b" {
		t.Fatalf("model-specific exhaustion ignored: %q", got)
	}
	if got, _ := f.pick(t, sc, "gpt-5.4", nil, auths); got != "a" {
		t.Fatalf("model-specific exhaustion blocked other models: %q", got)
	}
}

func TestEarlierPrimaryResetWithinSameHour(t *testing.T) {
	f := newRoutingFixture(routeWith("capacity_weighted", func(r *Routing) { r.ResetWindow = "primary" }), map[string]Snapshot{
		"a": usage("plus", 0, 0, 10*time.Minute, 24*time.Hour),
		"b": usage("pro", 0, 0, 40*time.Minute, 24*time.Hour),
	})
	f.draw = 0.99
	if got, err := f.pick(t, scope{provider: "codex"}, "gpt-5.4", nil, routingAccounts("codex", "a", "b")); err != nil || got != "a" {
		t.Fatalf("did not prefer the earlier 5h reset: %q %v", got, err)
	}
}

func TestStickySessionsAreIsolatedByKey(t *testing.T) {
	for _, explicit := range []bool{true, false} {
		name := "conversation history"
		if explicit {
			name = "explicit session"
		}
		t.Run(name, func(t *testing.T) {
			f := newRoutingFixture(routeWith("capacity_weighted", func(r *Routing) { r.StickySessions = true }), nil)
			auths := routingAccounts("codex", "a", "b")
			pick := func(key string, draw float64, grown bool) (*core.Auth, executor.Options) {
				t.Helper()
				f.draw = draw
				opts := executor.Options{SourceFormat: "openai", Metadata: map[string]any{executor.CallerScopeMetadataKey: token()}}
				if explicit {
					opts.Headers = http.Header{"X-Session-Id": {"same-client-session"}}
				} else if grown {
					opts.OriginalRequest = []byte(`{"messages":[{"role":"system","content":"stable"},{"role":"user","content":"first"},{"role":"assistant","content":"answer"},{"role":"user","content":"continue"}]}`)
				} else {
					opts.OriginalRequest = []byte(`{"messages":[{"role":"system","content":"stable"},{"role":"user","content":"first"}]}`)
				}
				ctx := context.WithValue(context.Background(), scopeKey{}, scope{provider: "codex", keyID: key})
				a, err := f.sel.Pick(ctx, "codex", "gpt-5.4", opts, auths)
				if err != nil {
					t.Fatal(err)
				}
				return a, opts
			}
			first, firstOpts := pick("first-key", 0.99, false)
			second, secondOpts := pick("second-key", 0, false)
			if first.ID != "b" || second.ID != "a" {
				t.Fatalf("keys shared a binding: %s %s", first.ID, second.ID)
			}
			for _, result := range []core.Result{
				{AuthID: first.ID, Provider: "codex", Model: "gpt-5.4", Success: true, Options: firstOpts},
				{AuthID: second.ID, Provider: "codex", Model: "gpt-5.4", Success: true, Options: secondOpts},
			} {
				f.sel.OnResult(result)
			}
			followFirst, _ := pick("first-key", 0, true)
			followSecond, _ := pick("second-key", 0.99, true)
			if followFirst.ID != "b" || followSecond.ID != "a" {
				t.Fatalf("result tracking or request identity moved bindings: %s %s", followFirst.ID, followSecond.ID)
			}
		})
	}
}

func TestSingleAccountNeverReroutes(t *testing.T) {
	auths := routingAccounts("codex", "a", "b")
	f := newRoutingFixture(routeWith("single_account", func(r *Routing) { r.AccountID = "b"; r.StickySessions = true }), nil)
	if _, err := f.pick(t, scope{provider: "codex", ids: []string{"a"}}, "gpt-5.4", nil, auths); err == nil {
		t.Fatal("single account outside the key grant was replaced")
	}
	if _, err := f.pick(t, scope{provider: "codex"}, "gpt-5.4", nil, auths[:1]); err == nil {
		t.Fatal("unavailable single account was replaced")
	}
	f.sel.subscriptionAvailable = func(_ context.Context, a *core.Auth) bool { return a.ID == "a" }
	if _, err := f.pick(t, scope{provider: "codex", subscriptionOnly: true}, "gpt-5.4", nil, auths); err == nil {
		t.Fatal("subscription-only fell back from the single account")
	}
	if got, _ := f.pick(t, scope{provider: "codex"}, "gpt-5.4", nil, auths); got != "b" {
		t.Fatalf("single account: %q", got)
	}
}

func TestStickySessionsStayWithinPolicy(t *testing.T) {
	auths := routingAccounts("codex", "a", "b", "c")
	snaps := map[string]Snapshot{"a": usage("plus", 0, 0, time.Hour, 24*time.Hour), "b": usage("plus", 0, 0, time.Hour, 24*time.Hour), "c": usage("plus", 0, 0, time.Hour, 24*time.Hour)}
	f := newRoutingFixture(routeWith("capacity_weighted", func(r *Routing) { r.StickySessions = true }), snaps)
	session := http.Header{"X-Session-Id": {"thread-1"}}
	sc := scope{provider: "codex"}
	f.draw = 0.5
	bound, err := f.pick(t, sc, "gpt-5.4", session, auths)
	if err != nil || bound != "b" {
		t.Fatalf("initial pick %q %v", bound, err)
	}
	f.draw = 0
	if got, _ := f.pick(t, sc, "gpt-5.4", session, auths); got != bound {
		t.Fatalf("session moved from %q to %q", bound, got)
	}
	if got, _ := f.pick(t, sc, "gpt-5.4", http.Header{"X-Session-Id": {"thread-2"}}, auths); got != "a" {
		t.Fatalf("new session reused a binding: %q", got)
	}
	if got, _ := f.pick(t, scope{provider: "codex", ids: []string{"a", "c"}}, "gpt-5.4", session, auths); got == bound {
		t.Fatal("binding overrode the key's account grant")
	}
	f.sel.subscriptionAvailable = func(_ context.Context, a *core.Auth) bool { return a.ID != "c" }
	if got, _ := f.pick(t, scope{provider: "codex", subscriptionOnly: true}, "gpt-5.4", session, auths); got == "c" || got == "" {
		t.Fatalf("subscription-only reused an exhausted binding: %q", got)
	}
	f.snaps = map[string]Snapshot{"a": snaps["a"], "b": snaps["b"], "c": usage("plus", 0, 100, time.Hour, 24*time.Hour)}
	bound, _ = f.pick(t, sc, "gpt-5.4", http.Header{"X-Session-Id": {"thread-3"}}, auths)
	f.snaps[bound] = usage("plus", 100, 50, time.Hour, 24*time.Hour)
	if got, _ := f.pick(t, sc, "gpt-5.4", http.Header{"X-Session-Id": {"thread-3"}}, auths); got == bound {
		t.Fatal("session stayed on an exhausted account while others had allowance")
	}
	// thread-1 is bound to a. A retry excludes a and fails over within policy.
	if got, _ := f.pick(t, sc, "gpt-5.4", session, auths[:1]); got != "a" {
		t.Fatalf("thread-1 binding: %q", got)
	}
	if got, _ := f.pick(t, sc, "gpt-5.4", session, auths[1:]); got != "b" {
		t.Fatalf("failover: %q", got)
	}
}

func TestSubscriptionOnlySpilloverAndFailClosed(t *testing.T) {
	auths := routingAccounts("codex", "a", "b")
	f := newRoutingFixture(routeWith("fill_first"), map[string]Snapshot{"a": usage("plus", 90, 10, time.Hour, 24*time.Hour)})
	f.sel.subscriptionAvailable = func(_ context.Context, a *core.Auth) bool { return a.ID == "b" }
	if got, _ := f.pick(t, scope{provider: "codex", subscriptionOnly: true}, "gpt-5.4", nil, auths); got != "b" {
		t.Fatalf("subscription-only kept an unverified account: %q", got)
	}
	f.sel.subscriptionAvailable = func(context.Context, *core.Auth) bool { return false }
	if _, err := f.pick(t, scope{provider: "codex", subscriptionOnly: true}, "gpt-5.4", nil, auths); err == nil {
		t.Fatal("unverifiable subscription allowance was accepted")
	}
	if got, _ := f.pick(t, scope{provider: "codex"}, "gpt-5.4", nil, auths); got != "a" {
		t.Fatalf("ordinary key lost access: %q", got)
	}
	if _, err := f.pick(t, scope{provider: "claude"}, "gpt-5.4", nil, auths); err == nil {
		t.Fatal("provider scope was bypassed")
	}
}
