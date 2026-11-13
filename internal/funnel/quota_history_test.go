package funnel

import (
	"testing"
	"time"
)

// Refreshes run every couple of minutes, so history must collapse to one point
// per bucket, thin older points and drop expired ones, or the encrypted state
// grows without bound. Model scopes keep their own history for the chart.
func TestQuotaHistoryBucketsAndPrunes(t *testing.T) {
	pct := func(v float64) *float64 { return &v }
	quotas := func(weekly float64) []Quota {
		return []Quota{{Label: "5h", Remaining: pct(10)}, {Label: "Fable 7d", Remaining: pct(weekly - 5)}, {Label: "Code review 7d", Remaining: pct(1)}, {Label: "7d", Remaining: pct(weekly)}}
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
	if len(h.Scopes) != 1 || h.Scopes[0].Label != "Fable 7d" || len(h.Scopes[0].Points) != 2 || h.Scopes[0].Points[1][1] != 65 {
		t.Fatalf("scopes = %+v", h.Scopes)
	}
	// Past the fine window, the two points share an hour and thin to the later one.
	d.recordQuota("a", quotas(60), start.Add(quotaFine+time.Hour))
	if h := d.QuotaHistory["a"]; len(h.Points) != 2 || h.Points[0][1] != 70 {
		t.Fatalf("thinned history = %+v", h)
	}
	d.recordQuota("a", quotas(50), start.Add(quotaKeep+30*time.Minute))
	if h := d.QuotaHistory["a"]; len(h.Points) != 2 || h.Points[0][1] != 60 {
		t.Fatalf("pruned history = %+v", h)
	}
}
