package funnel

import (
	"context"
	"math"
	"testing"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	sdkusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

func TestUsageAccountingAndDeduplication(t *testing.T) {
	store, err := NewStore(t.TempDir(), "accounting-test-admin")
	if err != nil {
		t.Fatal(err)
	}
	oldDay := now().AddDate(0, 0, -400).Format("2006-01-02")
	_ = store.change(func(d *diskState) error {
		d.Keys["key"] = Key{ID: "key"}
		d.Daily = map[string]DailyUsage{oldDay: {Day: oldDay, UsageTotals: UsageTotals{Tokens: Tokens{Total: 50}, Requests: 1}}}
		return nil
	})
	a := &App{store: store, core: core.NewManager(store, nil, nil)}
	// OpenAI cached input and reasoning output are subsets, not extra tokens.
	r := sdkusage.Record{RequestID: "execution", APIKey: a.usageIdentity("key", "codex", "HTTP", "parent"), Provider: "codex", Model: "gpt-6.1-sol", RequestedAt: now(), Detail: sdkusage.Detail{InputTokens: 1000, CachedTokens: 800, CacheReadTokens: 800, OutputTokens: 100, ReasoningTokens: 40, TotalTokens: 1100}}
	a.logRequest(RequestLog{ID: "parent"})
	a.HandleUsage(context.Background(), r)
	a.HandleUsage(context.Background(), r)
	d := store.read()
	if len(d.Requests) != 1 || d.Requests[0].Tokens.Total != 1100 || d.Requests[0].Tokens.Input != 200 || d.Requests[0].Tokens.Output != 60 {
		t.Fatalf("overlap or duplicate: %+v", d.Requests)
	}
	cost := d.Requests[0].Cost
	if !cost.Priced || math.Abs(cost.Min-.00148) > .0000001 {
		t.Fatalf("cost = %+v", cost)
	}
	if d.Daily[oldDay].Tokens.Total != 50 {
		t.Fatal("older history was lost")
	}
	for _, v := range d.Hourly {
		if v.Requests != 1 || v.Tokens.Total != 1100 {
			t.Fatal("hourly aggregate counted duplicate")
		}
	}
	if d.Daily[now().Format("2006-01-02")+"|codex"].Requests != 1 {
		t.Fatal("daily aggregate counted duplicate")
	}
	if usage := d.KeyUsage["key"]; usage.Requests != 1 || usage.Tokens.Total != 1100 || math.Abs(usage.Cost.Min-cost.Min) > 1e-10 {
		t.Fatalf("per-key totals lost usage or counted duplicates: %+v", usage)
	}
	// Finishing an authorized request after its key was revoked must still count.
	_ = store.change(func(d *diskState) error { delete(d.Keys, "key"); return nil })
	r.RequestID = "after-revocation"
	a.HandleUsage(context.Background(), r)
	if len(store.read().Requests) != 2 {
		t.Fatal("in-flight usage was lost after key revocation")
	}
	if usage := store.read().KeyUsage["key"]; usage.Requests != 2 || usage.Tokens.Total != 2200 {
		t.Fatal("in-flight key usage was lost after key revocation")
	}
	foreign := &App{usageOwner: "another-runtime", store: store, core: a.core}
	r.RequestID = "foreign"
	foreign.HandleUsage(context.Background(), r)
	if len(store.read().Requests) != 2 {
		t.Fatal("another runtime accepted usage")
	}

	// Anthropic's cache buckets are independent of its ordinary input count.
	detail := sdkusage.EnsureTokenBreakdownForProvider(sdkusage.Detail{InputTokens: 100, CacheReadTokens: 800, CacheCreationTokens: 200, OutputTokens: 50}, "claude", "claude")
	b := detail.TokenBreakdown
	if b.TotalTokens != 1150 || b.Input.UncachedTokens != 100 {
		t.Fatalf("Claude independent buckets: %+v", b)
	}
	ranged := estimateCost("claude", "claude-sonnet-5-5", "", Tokens{Input: 100, CacheWrite: 200, CacheRead: 800, Output: 50, Total: 1150})
	if !ranged.Priced || ranged.Max <= ranged.Min {
		t.Fatalf("write retention uncertainty lost: %+v", ranged)
	}
	unknown := estimateCost("codex", "unknown-model", "", Tokens{Total: 100})
	if unknown.Priced {
		t.Fatal("unknown model presented as free")
	}
}

func TestUnpricedRequestsArePricedOnRestart(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir, "reprice-test-admin")
	if err != nil {
		t.Fatal(err)
	}
	a := &App{store: store, core: core.NewManager(store, nil, nil)}
	at := now()
	a.HandleUsage(context.Background(), sdkusage.Record{RequestID: "early", APIKey: a.usageIdentity("key", "claude", "HTTP", "parent"), Provider: "claude", Model: "claude-next", RequestedAt: at, Detail: sdkusage.Detail{InputTokens: 1000, OutputTokens: 100, TotalTokens: 1100}})
	if err := store.change(func(d *diskState) error {
		// Priced under an older table; a restart must not rewrite it.
		d.Requests = append(d.Requests, RequestLog{ID: "kept", At: at, Provider: "claude", Tokens: &Tokens{Input: 1000, Total: 1000}, Cost: &Cost{Min: .5, Max: .5, Priced: true, Model: "claude-opus-5-5"}})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if d := store.read(); d.Requests[0].Cost.Priced || d.KeyUsage["key"].Unpriced != 1 {
		t.Fatalf("model without a price was priced: %+v", d.Requests[0].Cost)
	}
	prices["claude-next"] = rate{1, 10, .1, 1.25, 2}
	t.Cleanup(func() { delete(prices, "claude-next") })
	// The second restart must not add the cost again.
	for range 2 {
		store, err = NewStore(dir, "reprice-test-admin")
		if err != nil {
			t.Fatal(err)
		}
		d := store.read()
		if c := d.Requests[0].Cost; !c.Priced || math.Abs(c.Min-.002) > 1e-9 {
			t.Fatalf("request not priced after its price was added: %+v", c)
		}
		if d.Requests[1].Cost.Min != .5 {
			t.Fatalf("priced request was rewritten: %+v", d.Requests[1].Cost)
		}
		for name, totals := range map[string]UsageTotals{
			"daily":  d.Daily[at.Format("2006-01-02")+"|claude"].UsageTotals,
			"hourly": d.Hourly[at.Truncate(time.Hour).Format(time.RFC3339)+"|claude"].UsageTotals,
			"key":    d.KeyUsage["key"],
		} {
			if totals.Requests != 1 || totals.Unpriced != 0 || math.Abs(totals.Cost.Min-.002) > 1e-9 {
				t.Fatalf("%s totals after repricing: %+v", name, totals)
			}
		}
	}
}

func TestHourlyHistoryUpgrade(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir, "hourly-upgrade-admin")
	if err != nil {
		t.Fatal(err)
	}
	at := now().Add(-time.Minute)
	if err := store.change(func(d *diskState) error {
		d.Hourly = nil // State written before hourly accounting existed.
		d.KeyUsage = nil
		d.Requests = []RequestLog{
			{At: at, Provider: "codex", KeyID: "key", Tokens: &Tokens{Input: 100, Total: 100}, Cost: &Cost{Min: .1, Max: .1, Input: .1, Priced: true}},
			{At: at.AddDate(0, 0, -3), Provider: "codex", KeyID: "key", Tokens: &Tokens{Total: 200}, Cost: &Cost{}},
			{At: at, Provider: "codex", KeyID: "key"},
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		store, err = NewStore(dir, "hourly-upgrade-admin")
		if err != nil {
			t.Fatal(err)
		}
		hourly := store.read().Hourly
		key := at.UTC().Truncate(time.Hour).Format(time.RFC3339) + "|codex"
		if len(hourly) != 1 || hourly[key].Tokens.Total != 100 || hourly[key].Requests != 1 || hourly[key].Cost.Min != .1 {
			t.Fatalf("existing usage lost or duplicated on restart: %+v", hourly)
		}
		totals := store.read().KeyUsage["key"]
		if totals.Requests != 2 || totals.Tokens.Total != 300 || totals.Cost.Min != .1 || totals.Unpriced != 1 {
			t.Fatalf("key history lost or duplicated on restart: %+v", totals)
		}
		// Once backfilled, totals must survive the source logs being evicted.
		if err := store.change(func(d *diskState) error { d.Requests = nil; return nil }); err != nil {
			t.Fatal(err)
		}
	}
}
