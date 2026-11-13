package funnel

import (
	"math"
	"slices"
	"strings"
	"time"
)

// The quota chart shows two weeks and can step back a week, so history covers
// three weeks plus a few hours to measure the burn rate. The burn rate needs
// fine points; older weeks only need the shape, so they keep one point per
// hour. That keeps the encrypted state small.
const (
	quotaBucket = 15 * time.Minute
	quotaFine   = 8 * 24 * time.Hour
	quotaKeep   = 22 * 24 * time.Hour
)

// QuotaSeries tracks one window. Each point is [unix seconds, remaining percent].
type QuotaSeries struct {
	Label  string       `json:"label"`
	Points [][2]float64 `json:"points"`
}

// QuotaHistory tracks an account's longest account-wide window, the one that
// decides how long the account lasts, and the longest window of each model
// scope, such as "Fable 7d".
type QuotaHistory struct {
	QuotaSeries
	Scopes []QuotaSeries `json:"scopes,omitempty"`
}

// longestWindows returns the longest window with a known remaining percent for
// each scope; "" is account-wide. Code review limits are not model capacity.
func longestWindows(quotas []Quota) map[string]Quota {
	best := map[string]Quota{}
	for _, q := range quotas {
		scope, length, ok := quotaWindow(q.Label)
		if !ok || q.Remaining == nil || strings.HasPrefix(strings.ToLower(scope), "code review") {
			continue
		}
		if _, current, _ := quotaWindow(best[scope].Label); length > current {
			best[scope] = q
		}
	}
	return best
}

func (d *diskState) recordQuota(id string, quotas []Quota, at time.Time) {
	windows := longestWindows(quotas)
	all, ok := windows[""]
	if !ok {
		return
	}
	if d.QuotaHistory == nil {
		d.QuotaHistory = map[string]QuotaHistory{}
	}
	h := d.QuotaHistory[id]
	h.QuotaSeries = h.record(all, at)
	scopes := h.Scopes
	h.Scopes = nil
	for scope, q := range windows {
		if scope == "" {
			continue
		}
		s := QuotaSeries{}
		for _, old := range scopes {
			if old.Label == q.Label {
				s = old
			}
		}
		h.Scopes = append(h.Scopes, s.record(q, at))
	}
	slices.SortFunc(h.Scopes, func(a, b QuotaSeries) int { return strings.Compare(a.Label, b.Label) })
	d.QuotaHistory[id] = h
}

func (s QuotaSeries) record(q Quota, at time.Time) QuotaSeries {
	if s.Label != q.Label {
		s = QuotaSeries{Label: q.Label}
	}
	s.Points = append(s.Points, [2]float64{float64(at.Unix()), math.Round(*q.Remaining*10) / 10})
	keep, fine := at.Add(-quotaKeep).Unix(), at.Add(-quotaFine).Unix()
	points := s.Points[:0]
	for _, p := range s.Points {
		t := int64(p[0])
		if t < keep {
			continue
		}
		bucket := int64(time.Hour / time.Second)
		if t >= fine {
			bucket = int64(quotaBucket / time.Second)
		}
		// The latest point in each bucket wins.
		if n := len(points); n > 0 && int64(points[n-1][0])/bucket == t/bucket {
			points[n-1] = p
		} else {
			points = append(points, p)
		}
	}
	s.Points = points
	return s
}
