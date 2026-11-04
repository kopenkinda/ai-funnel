package funnel

import (
	"math"
	"time"
)

// The quota chart looks back a week and needs a few hours more to measure the
// burn rate. One point per bucket keeps the encrypted state small.
const (
	quotaBucket = 15 * time.Minute
	quotaKeep   = 8 * 24 * time.Hour
)

// QuotaHistory tracks one account's longest account-wide window, the one that
// decides how long the account lasts.
type QuotaHistory struct {
	Label string `json:"label"`
	// Each point is [unix seconds, remaining percent].
	Points [][2]float64 `json:"points"`
}

func poolQuota(quotas []Quota) *Quota {
	var best *Quota
	var longest time.Duration
	for i, q := range quotas {
		scope, length, ok := quotaWindow(q.Label)
		if ok && scope == "" && q.Remaining != nil && length > longest {
			best, longest = &quotas[i], length
		}
	}
	return best
}

func (d *diskState) recordQuota(id string, quotas []Quota, at time.Time) {
	q := poolQuota(quotas)
	if q == nil {
		return
	}
	if d.QuotaHistory == nil {
		d.QuotaHistory = map[string]QuotaHistory{}
	}
	h := d.QuotaHistory[id]
	if h.Label != q.Label {
		h = QuotaHistory{Label: q.Label}
	}
	point := [2]float64{float64(at.Unix()), math.Round(*q.Remaining*10) / 10}
	bucket := int64(quotaBucket / time.Second)
	if n := len(h.Points); n > 0 && int64(h.Points[n-1][0])/bucket == at.Unix()/bucket {
		h.Points[n-1] = point
	} else {
		h.Points = append(h.Points, point)
	}
	cutoff := float64(at.Add(-quotaKeep).Unix())
	for len(h.Points) > 0 && h.Points[0][0] < cutoff {
		h.Points = h.Points[1:]
	}
	d.QuotaHistory[id] = h
}
