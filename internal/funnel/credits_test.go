package funnel

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type creditLookupExecutor struct {
	captureExecutor
	status int
	body   string
}

func (x *creditLookupExecutor) HttpRequest(context.Context, *core.Auth, *http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: x.status, Body: io.NopCloser(strings.NewReader(x.body))}, nil
}

func TestSubscriptionAllowanceCheck(t *testing.T) {
	manager := core.NewManager(nil, nil, nil)
	app := &App{core: manager}
	for _, tc := range []struct {
		name   string
		status int
		body   string
		allow  bool
	}{
		{"funded with allowance", 200, `{"credits":{"has_credits":true,"balance":"68342.80"},"rate_limit":{"primary_window":{"used_percent":99},"secondary_window":{"used_percent":75}}}`, true},
		{"weekly only", 200, `{"rate_limit":{"primary_window":null,"secondary_window":{"used_percent":50}}}`, true},
		{"session exhausted despite credits", 200, `{"credits":{"has_credits":true},"rate_limit":{"allowed":true,"primary_window":{"used_percent":100},"secondary_window":{"used_percent":50}}}`, false},
		{"weekly exhausted", 200, `{"rate_limit":{"primary_window":{"used_percent":50},"secondary_window":{"used_percent":100}}}`, false},
		{"provider limit reached", 200, `{"rate_limit":{"limit_reached":true,"primary_window":{"used_percent":99}}}`, false},
		{"provider denied", 200, `{"rate_limit":{"allowed":false,"primary_window":{"used_percent":0}}}`, false},
		{"unrelated exhausted quota", 200, `{"rate_limit":{"primary_window":{"used_percent":20}},"code_review_rate_limit":{"primary_window":{"used_percent":100}}}`, true},
		{"unknown", 200, `{}`, false},
		{"allowed without windows", 200, `{"rate_limit":{"allowed":true}}`, false},
		{"missing percentage", 200, `{"rate_limit":{"primary_window":{}}}`, false},
		{"lookup failed", 503, `{"rate_limit":{"primary_window":{"used_percent":0}}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			manager.RegisterExecutor(&creditLookupExecutor{status: tc.status, body: tc.body})
			if got := app.codexSubscriptionAvailable(context.Background(), &core.Auth{Provider: "codex"}); got != tc.allow {
				t.Fatalf("subscription available = %v, want %v", got, tc.allow)
			}
		})
	}
}
