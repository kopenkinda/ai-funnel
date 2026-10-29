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
	UsageTotals
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
	v.Cost.Min += cost.Min
	v.Cost.Max += cost.Max
	v.Cost.Input += cost.Input
	v.Cost.CacheRead += cost.CacheRead
	v.Cost.CacheWrite += cost.CacheWrite
	v.Cost.Output += cost.Output
	v.Cost.Reasoning += cost.Reasoning
	if !cost.Priced {
		v.Unpriced++
	}
}

func (d *diskState) addHourly(at time.Time, provider string, tokens Tokens, cost Cost) {
	hour := at.UTC().Truncate(time.Hour).Format(time.RFC3339)
	k := hour + "|" + provider
	v := d.Hourly[k]
	v.Day, v.Hour, v.Provider = at.UTC().Format("2006-01-02"), hour, provider
	v.add(tokens, cost)
	d.Hourly[k] = v
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
		if d.Daily == nil {
			d.Daily = map[string]DailyUsage{}
		}
		if d.TrackingAt == nil {
			t := at
			d.TrackingAt = &t
		}
		day := at.Format("2006-01-02")
		k := day + "|" + r.Provider
		v := d.Daily[k]
		v.Day = day
		v.Provider = r.Provider
		v.add(tokens, cost)
		d.Daily[k] = v
		d.addHourly(at, r.Provider, tokens, cost)
		d.addKeyUsage(keyID, tokens, cost)
		cutoff := now().AddDate(0, 0, -2).Format(time.RFC3339)
		for k, v := range d.Hourly {
			if v.Hour < cutoff {
				delete(d.Hourly, k)
			}
		}
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
