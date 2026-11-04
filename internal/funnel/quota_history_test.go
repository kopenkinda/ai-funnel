package funnel

import (
	"testing"
	"time"
)

// Refreshes run every couple of minutes, so history must collapse to one point
// per bucket and drop old points, or the encrypted state grows without bound.
func TestQuotaHistoryBucketsAndPrunes(t *testing.T) {
	pct := func(v float64) *float64 { return &v }
	quotas := func(weekly float64) []Quota {
		return []Quota{{Label: "5h", Remaining: pct(10)}, {Label: "Opus 7d", Remaining: pct(1)}, {Label: "7d", Remaining: pct(weekly)}}
	}
	var d diskState
	start := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	d.recordQuota("a", quotas(90), start)
	d.recordQuota("a", quotas(80), start.Add(5*time.Minute))
	d.recordQuota("a", quotas(70), start.Add(20*time.Minute))
	h := d.QuotaHistory["a"]
	if h.Label != "7d" || len(h.Points) != 2 || h.Points[0][1] != 80 || h.Points[1][1] != 70 {
		t.Fatalf("history = %+v", h)
	}
	d.recordQuota("a", quotas(60), start.Add(quotaKeep+10*time.Minute))
	if h := d.QuotaHistory["a"]; len(h.Points) != 2 || h.Points[0][1] != 70 {
		t.Fatalf("pruned history = %+v", h)
	}
}
