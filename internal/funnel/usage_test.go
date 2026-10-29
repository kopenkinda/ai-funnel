package funnel

import (
	"encoding/json"
	"testing"
	"time"
)

func TestReportedUsageLimits(t *testing.T) {
	for _, tt := range []struct {
		name, provider, body string
		labels               []string
		remaining            []float64
	}{
		{
			name:     "Claude scoped limits with a null model ID and inactive window",
			provider: "claude",
			body: `{"limits":[
				{"kind":"session","percent":0,"resets_at":"2030-01-01T00:00:00Z"},
				{"kind":"weekly_all","percent":20},
				{"kind":"weekly_scoped","percent":100,"scope":{"model":{"id":null,"display_name":"Fable"}},"is_active":false},
				{"kind":"monthly","percent":null}],
				"five_hour":{"utilization":0},"seven_day":{"utilization":20},"extra_usage":{"is_enabled":false,"utilization":5}}`,
			labels:    []string{"5h", "7d", "Fable 7d"},
			remaining: []float64{100, 80, 0},
		},
		{
			name:     "Claude legacy model pools without absent windows",
			provider: "claude",
			body:     `{"five_hour":{"utilization":10},"seven_day":null,"seven_day_opus":{"utilization":40},"seven_day_sonnet":null}`,
			labels:   []string{"5h", "Opus 7d"}, remaining: []float64{90, 60},
		},
		{
			name:     "Codex weekly-only account and banked resets",
			provider: "codex",
			body:     `{"rate_limit":{"primary_window":{"used_percent":27,"limit_window_seconds":604800,"reset_at":1893456000},"secondary_window":null},"rate_limit_reset_credits":{"available_count":2,"applicable_available_count":0}}`,
			labels:   []string{"7d"}, remaining: []float64{73},
		},
		{
			name:     "Codex additional pools and relative resets",
			provider: "codex",
			body:     `{"rate_limit":null,"code_review_rate_limit":{"primary_window":{"used_percent":100,"limit_window_seconds":604800,"reset_after_seconds":60}},"additional_rate_limits":[{"limit_name":"Spark","rate_limit":{"primary_window":{"used_percent":20,"limit_window_seconds":18000,"reset_after_seconds":60}}}]}`,
			labels:   []string{"Code review 7d", "Spark 5h"}, remaining: []float64{0, 80},
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var data map[string]any
			if err := json.Unmarshal([]byte(tt.body), &data); err != nil {
				t.Fatal(err)
			}
			at := time.Date(2029, 12, 31, 23, 59, 0, 0, time.UTC)
			quotas, credits := parseUsage(tt.provider, data, at)
			if len(quotas) != len(tt.labels) {
				t.Fatalf("got %v, want labels %v", quotas, tt.labels)
			}
			for i, quota := range quotas {
				if quota.Label != tt.labels[i] || quota.Remaining == nil || *quota.Remaining != tt.remaining[i] {
					t.Errorf("quota %d = %+v, want %s at %g%%", i, quota, tt.labels[i], tt.remaining[i])
				}
			}
			if tt.provider == "codex" {
				if quotas[0].ResetsAt == nil || !quotas[0].ResetsAt.Equal(at.Add(time.Minute)) {
					t.Errorf("reset = %v, want %v", quotas[0].ResetsAt, at.Add(time.Minute))
				}
				if data["rate_limit_reset_credits"] != nil && (credits == nil || credits.Available != 2 || credits.Applicable == nil || *credits.Applicable != 0) {
					t.Errorf("banked resets = %+v, want 2 banked and 0 applicable", credits)
				}
			} else if credits != nil {
				t.Errorf("unexpected reset credits: %+v", credits)
			}
		})
	}
}
