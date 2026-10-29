package funnel

import (
	"fmt"
	"strings"
	"time"
)

// Only numerical, reported limits become quotas. A missing window is not an
// exhausted allowance, and a reported zero percent used is still a real limit.
func parseUsage(provider string, data map[string]any, at time.Time) ([]Quota, *ResetCredits) {
	quotas := []Quota{}
	appendQuota := func(q Quota) {
		if q.Remaining == nil {
			return
		}
		for _, existing := range quotas {
			if existing.Label == q.Label {
				return
			}
		}
		quotas = append(quotas, q)
	}
	if provider == "claude" {
		limits, _ := data["limits"].([]any)
		for _, raw := range limits {
			limit := object(raw)
			label := strings.ReplaceAll(str(limit["kind"]), "_", " ")
			switch str(limit["kind"]) {
			case "session":
				label = "5h"
			case "weekly_all", "weekly_scoped":
				label = "7d"
			}
			scope := object(limit["scope"])
			model := object(scope["model"])
			name := str(model["display_name"])
			if name == "" {
				name = str(model["id"])
			}
			if name != "" {
				label = name + " " + label
			}
			if surface := str(scope["surface"]); surface != "" {
				label = surface + " " + label
			}
			if label != "" {
				appendQuota(parseQuota(label, limit, "percent", "resets_at", true))
			}
		}
		// Older responses expose windows directly. Prefer the newer limits list
		// when present, including model names whose IDs may be null.
		appendQuota(parseQuota("5h", object(data["five_hour"]), "utilization", "resets_at", true))
		appendQuota(parseQuota("7d", object(data["seven_day"]), "utilization", "resets_at", true))
		if len(limits) == 0 {
			for _, field := range []string{"seven_day_opus", "seven_day_sonnet", "seven_day_oauth_apps", "seven_day_cowork", "seven_day_omelette"} {
				name := strings.ReplaceAll(strings.TrimPrefix(field, "seven_day_"), "_", " ")
				name = strings.ToUpper(name[:1]) + name[1:]
				appendQuota(parseQuota(name+" 7d", object(data[field]), "utilization", "resets_at", true))
			}
		}
		if extra := object(data["extra_usage"]); extra["is_enabled"] == true {
			appendQuota(parseQuota("Extra", extra, "utilization", "resets_at", true))
		}
		return quotas, nil
	}
	appendWindows := func(prefix string, rate map[string]any) {
		for _, field := range []string{"primary_window", "secondary_window"} {
			window := object(rate[field])
			seconds, _ := window["limit_window_seconds"].(float64)
			label := "5h"
			if seconds >= 86400 {
				label = fmt.Sprintf("%gd", seconds/86400)
			} else if seconds > 0 {
				label = fmt.Sprintf("%gh", seconds/3600)
			}
			if prefix != "" {
				label = prefix + " " + label
			}
			q := parseQuota(label, window, "used_percent", "reset_at", true)
			if q.ResetsAt == nil {
				if seconds, ok := window["reset_after_seconds"].(float64); ok && seconds >= 0 {
					t := at.Add(time.Duration(seconds) * time.Second)
					q.ResetsAt = &t
				}
			}
			appendQuota(q)
		}
	}
	appendWindows("", object(data["rate_limit"]))
	appendWindows("Code review", object(data["code_review_rate_limit"]))
	additional, _ := data["additional_rate_limits"].([]any)
	for _, raw := range additional {
		limit := object(raw)
		if name := str(limit["limit_name"]); name != "" {
			appendWindows(name, object(limit["rate_limit"]))
		}
	}
	credits := object(data["rate_limit_reset_credits"])
	if available, ok := credits["available_count"].(float64); ok {
		resets := &ResetCredits{Available: int(available)}
		if applicable, ok := credits["applicable_available_count"].(float64); ok {
			n := int(applicable)
			resets.Applicable = &n
		}
		return quotas, resets
	}
	return quotas, nil
}
