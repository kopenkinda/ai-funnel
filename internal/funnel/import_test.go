package funnel

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

func TestCredentialFormats(t *testing.T) {
	claims, _ := json.Marshal(map[string]any{"email": "token@example.com", "exp": 2000000000, "https://api.openai.com/auth": map[string]any{"chatgpt_account_id": "claim-account", "chatgpt_plan_type": "plus"}})
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
	access := header + "." + base64.RawURLEncoding.EncodeToString(claims) + ".fixture"
	for _, input := range []accountImport{
		{Provider: "codex", Token: access},
		{Provider: "codex", Auth: json.RawMessage(`{"access_token":"fixture-flat-access-token","refresh_token":"fixture-flat-refresh-token","type":"codex","account_id":"flat-account"}`)},
		{Provider: "claude", Auth: json.RawMessage(`{"claudeAiOauth":{"accessToken":"sk-ant-oat01-fixture-file-token","refreshToken":"fixture-file-refresh-token","expiresAt":2000000000000,"subscriptionType":"max"}}`)},
	} {
		auth, e := parseAccountImport(input)
		if e != nil || auth == nil || str(auth.Metadata["access_token"]) == "" {
			t.Fatalf("%s credentials rejected: %v", input.Provider, e)
		}
		if input.Token != "" && (str(auth.Metadata["account_id"]) != "claim-account" || str(auth.Metadata["email"]) != "token@example.com" || str(auth.Metadata["expired"]) == "") {
			t.Fatal("Codex token identity or expiry was lost")
		}
		if input.Provider == "claude" && (str(auth.Metadata["refresh_token"]) != "fixture-file-refresh-token" || str(auth.Metadata["expired"]) == "") {
			t.Fatal("Claude refresh credentials were lost")
		}
	}
	for _, raw := range []string{`null`, `[]`, `{"tokens":{}}`, `{"OPENAI_API_KEY":"fixture-paid-key"}`} {
		if _, e := parseAccountImport(accountImport{Provider: "codex", Auth: json.RawMessage(raw)}); e == nil {
			t.Fatal("unsupported credential file accepted")
		}
	}
}
