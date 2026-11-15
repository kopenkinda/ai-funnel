package funnel

import (
	"context"
	"strings"
	"time"

	sdkusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

// These buckets are disjoint. Reasoning is separated from other output, and
// cache reads/writes are separated from ordinary input.
type Tokens struct {
	Input        int64 `json:"input"`
	CacheRead    int64 `json:"cacheRead"`
	CacheWrite   int64 `json:"cacheWrite"`
	Output       int64 `json:"output"`
	Reasoning    int64 `json:"reasoning"`
	Unclassified int64 `json:"unclassified"`
	Total        int64 `json:"total"`
}

func (t *Tokens) add(v Tokens) {
	t.Input += v.Input
	t.CacheRead += v.CacheRead
	t.CacheWrite += v.CacheWrite
	t.Output += v.Output
	t.Reasoning += v.Reasoning
	t.Unclassified += v.Unclassified
	t.Total += v.Total
}

type Cost struct {
	Min        float64 `json:"min"`
	Max        float64 `json:"max"`
	Input      float64 `json:"input"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
	Output     float64 `json:"output"`
	Reasoning  float64 `json:"reasoning"`
	Priced     bool    `json:"priced"`
	Model      string  `json:"model,omitempty"`
	Tier       string  `json:"tier,omitempty"`
	Note       string  `json:"note,omitempty"`
	Version    string  `json:"version,omitempty"`
}
type DailyUsage struct {
	Day      string `json:"day"`
	Hour     string `json:"hour,omitempty"`
	Provider string `json:"provider"`
	KeyID    string `json:"keyId,omitempty"`
	UsageTotals
}

// usageSeries is one day or hour aggregate, either provider-wide or per API
// key. Per-key series feed a key's usage tab; provider-wide ones the Usage page.
type usageSeries struct {
	m      map[string]DailyUsage
	hourly bool
	perKey bool
}

func (d *diskState) usageSeries() []usageSeries {
	return []usageSeries{{d.Daily, false, false}, {d.Hourly, true, false}, {d.KeyDaily, false, true}, {d.KeyHourly, true, true}}
}

func (s usageSeries) bucket(at time.Time, provider, keyID string) (string, DailyUsage) {
	at = at.UTC()
	v := DailyUsage{Day: at.Format("2006-01-02"), Provider: provider}
	k := v.Day
	if s.hourly {
		v.Hour = at.Truncate(time.Hour).Format(time.RFC3339)
		k = v.Hour
	}
	k += "|" + provider
	if s.perKey {
		v.KeyID = keyID
		k += "|" + keyID
	}
	return k, v
}

func (s usageSeries) add(r RequestLog) {
	if r.Tokens == nil || r.Cost == nil || (s.perKey && r.KeyID == "") {
		return
	}
	k, v := s.bucket(r.At, r.Provider, r.KeyID)
	if old, ok := s.m[k]; ok {
		v = old
	}
	v.add(*r.Tokens, *r.Cost)
	s.m[k] = v
}

// Hours older than two days are dropped.
func (d *diskState) pruneHourly() {
	cutoff := now().AddDate(0, 0, -2).Format(time.RFC3339)
	for _, m := range []map[string]DailyUsage{d.Hourly, d.KeyHourly} {
		for k, v := range m {
			if v.Hour < cutoff {
				delete(m, k)
			}
		}
	}
}

type UsageTotals struct {
	Tokens   Tokens `json:"tokens"`
	Cost     Cost   `json:"cost"`
	Requests int    `json:"requests"`
	Unpriced int    `json:"unpriced"`
}

func (v *UsageTotals) add(tokens Tokens, cost Cost) {
	v.Requests++
	v.Tokens.add(tokens)
	v.addCost(cost)
	if !cost.Priced {
		v.Unpriced++
	}
}

func (v *UsageTotals) addCost(cost Cost) {
	v.Cost.Min += cost.Min
	v.Cost.Max += cost.Max
	v.Cost.Input += cost.Input
	v.Cost.CacheRead += cost.CacheRead
	v.Cost.CacheWrite += cost.CacheWrite
	v.Cost.Output += cost.Output
	v.Cost.Reasoning += cost.Reasoning
}

// reprice estimates retained requests that had no price when they completed,
// so adding a model's price also covers the usage recorded before it. Their
// totals already count them as unpriced with no cost, so only the cost moves.
// Requests that were priced keep their original estimate.
func (d *diskState) reprice() bool {
	changed := false
	for i, r := range d.Requests {
		if r.Tokens == nil || r.Cost == nil || r.Cost.Priced {
			continue
		}
		cost := estimateCost(r.Provider, r.Cost.Model, r.Cost.Tier, *r.Tokens)
		if !cost.Priced {
			continue
		}
		d.Requests[i].Cost = &cost
		changed = true
		// Hours older than two days are already gone.
		for _, s := range d.usageSeries() {
			k, _ := s.bucket(r.At, r.Provider, r.KeyID)
			if v, ok := s.m[k]; ok {
				v.addCost(cost)
				v.Unpriced--
				s.m[k] = v
			}
		}
		if v, ok := d.KeyUsage[r.KeyID]; ok {
			v.addCost(cost)
			v.Unpriced--
			d.KeyUsage[r.KeyID] = v
		}
	}
	return changed
}

func (d *diskState) addKeyUsage(keyID string, tokens Tokens, cost Cost) {
	if d.KeyUsage == nil {
		d.KeyUsage = map[string]UsageTotals{}
	}
	v := d.KeyUsage[keyID]
	v.add(tokens, cost)
	d.KeyUsage[keyID] = v
}

// Only opaque internal identifiers enter the SDK's usage identity, never the
// bearer credential. CaptureIdentity snapshots this before Gin can be reused.
func (a *App) usageIdentity(keyID, connID, transport, requestID string) string {
	return strings.Join([]string{a.usageOwner, keyID, connID, transport, requestID}, "|")
}
func (a *App) HandleUsage(_ context.Context, r sdkusage.Record) {
	identity := strings.Split(r.APIKey, "|")
	if len(identity) != 5 || identity[0] != a.usageOwner {
		return
	}
	keyID, connID, transport, parent := identity[1], identity[2], identity[3], identity[4]
	detail := sdkusage.EnsureTokenBreakdownForProvider(r.Detail, r.Provider, r.ExecutorType)
	b := detail.TokenBreakdown
	tokens := Tokens{b.Input.UncachedTokens, b.Input.CacheReadTokens, b.Input.CacheWriteTokens, b.Output.NonReasoningTokens, b.Output.ReasoningTokens, b.UnclassifiedTokens, b.TotalTokens}
	if transport == "HTTP" && r.Stream {
		transport = "SSE"
	}
	at := r.RequestedAt.UTC()
	if at.IsZero() {
		at = now()
	}
	model := r.ResponseModel
	if model == "" {
		model = r.Model
	}
	tier := r.ResponseServiceTier
	if tier == "" {
		tier = r.EffectiveServiceTier
	}
	if tier == "" {
		tier = r.ServiceTier
	}
	cost := estimateCost(r.Provider, model, tier, tokens)
	status := 200
	if r.Failed {
		status = r.Fail.StatusCode
		if status < 400 {
			status = 502
		}
	}
	id := r.RequestID
	if id == "" {
		id = token()[:24]
	}
	entry := RequestLog{ID: id, ParentID: parent, At: at, ConnectionID: connID, KeyID: keyID, Model: r.Model, Provider: r.Provider, AccountID: r.AuthID, Transport: transport, Status: status, DurationMs: r.Latency.Milliseconds(), TTFTMs: r.TTFT.Milliseconds(), Tokens: &tokens, Cost: &cost, ErrorCode: r.Fail.Code, Reasoning: r.ReasoningEffort}
	if r.ExecutorType != "" {
		entry.UpstreamTransport = "HTTP"
		if strings.Contains(strings.ToLower(r.ExecutorType), "websocket") {
			entry.UpstreamTransport = "WS"
		}
	}
	if auth, ok := a.core.GetByID(r.AuthID); ok {
		entry.AccountName = str(auth.Metadata["email"])
		if entry.AccountName == "" {
			entry.AccountName = auth.Label
		}
		entry.Plan = str(auth.Metadata["plan_type"])
	}
	_ = a.store.change(func(d *diskState) error {
		entry.KeyName = d.Keys[keyID].Name
		for _, old := range d.Requests {
			if old.ID == id {
				return nil
			}
		}
		filtered := d.Requests[:0]
		for _, old := range d.Requests {
			if old.ID != parent {
				filtered = append(filtered, old)
			}
		}
		d.Requests = append(filtered, entry)
		if len(d.Requests) > 10000 {
			d.Requests = d.Requests[len(d.Requests)-10000:]
		}
		if d.TrackingAt == nil {
			t := at
			d.TrackingAt = &t
		}
		for _, s := range d.usageSeries() {
			s.add(entry)
		}
		d.addKeyUsage(keyID, tokens, cost)
		d.pruneHourly()
		return nil
	})
}
func (a *App) logRequest(entry RequestLog) {
	_ = a.store.change(func(d *diskState) error {
		if entry.KeyName == "" {
			entry.KeyName = d.Keys[entry.KeyID].Name
		}
		for _, old := range d.Requests {
			if old.ParentID == entry.ID {
				return nil
			}
		}
		d.Requests = append(d.Requests, entry)
		if len(d.Requests) > 10000 {
			d.Requests = d.Requests[len(d.Requests)-10000:]
		}
		for k := range d.Usage {
			if len(k) >= 10 && k[:10] < now().Add(-32*24*time.Hour).Format("2006-01-02") {
				delete(d.Usage, k)
			}
		}
		return nil
	})
}
