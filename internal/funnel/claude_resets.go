package funnel

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"time"

	"github.com/google/uuid"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

const claudeUsageURL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1"
const claudeResetUsageURL = claudeUsageURL + "&skip_spend=1"

var claudeGrantID = regexp.MustCompile(`^[a-z0-9_-]{1,40}$`)

func parseClaudeCredits(data map[string]any, at time.Time) (*ResetCredits, error) {
	credits := &ResetCredits{CheckedAt: &at}
	if data["cedar_ember"] == nil {
		return credits, nil
	}
	body, _ := json.Marshal(data["cedar_ember"])
	var status struct {
		Eligible      *bool             `json:"eligible"`
		Grants        []json.RawMessage `json:"grants"`
		CooldownUntil *time.Time        `json:"cooldown_until"`
	}
	if json.Unmarshal(body, &status) != nil || status.Eligible == nil {
		return nil, fmt.Errorf("invalid Claude reset status")
	}
	if !*status.Eligible {
		return credits, nil
	}
	applicable := 0
	credits.Applicable = &applicable
	for _, raw := range status.Grants {
		var grant struct {
			ID        string     `json:"id"`
			Remaining *int       `json:"resets_left"`
			StartsAt  *time.Time `json:"starts_at"`
			EndsAt    *time.Time `json:"ends_at"`
			Paused    bool       `json:"paused"`
			UsableNow bool       `json:"usable_now"`
		}
		if json.Unmarshal(raw, &grant) != nil || !claudeGrantID.MatchString(grant.ID) || grant.Remaining == nil || *grant.Remaining <= 0 || grant.Paused || (grant.StartsAt != nil && grant.StartsAt.After(at)) || (grant.EndsAt != nil && !grant.EndsAt.After(at)) {
			continue
		}
		usable := grant.UsableNow && (status.CooldownUntil == nil || !status.CooldownUntil.After(at))
		credits.Items = append(credits.Items, ResetCredit{ID: grant.ID, Status: "available", ResetType: "claude_rate_limits", ExpiresAt: grant.EndsAt, Remaining: grant.Remaining, UsableNow: usable})
		credits.Available += *grant.Remaining
		if usable {
			applicable += *grant.Remaining
		}
	}
	credits.Items = activeCredits(credits.Items, at)
	return credits, nil
}

func claudeCreditsUnavailable(previous *ResetCredits) *ResetCredits {
	credits := ResetCredits{}
	if previous != nil {
		credits = *previous
	}
	credits.Error = "Claude reset lookup unavailable."
	return &credits
}

func (a *App) fetchClaudeCredits(ctx context.Context, auth *core.Auth, previous *ResetCredits) *ResetCredits {
	status, body, err := a.accountRequest(ctx, auth, "GET", claudeResetUsageURL, nil)
	var data map[string]any
	if err != nil || status != 200 || json.Unmarshal(body, &data) != nil || data == nil {
		return claudeCreditsUnavailable(previous)
	}
	credits, err := parseClaudeCredits(data, now())
	if err != nil {
		return claudeCreditsUnavailable(previous)
	}
	return credits
}

// Imported setup tokens may not include an organization. Resolve it with the
// same account's OAuth profile, never a client-supplied organization or URL.
func (a *App) claudeOrganization(ctx context.Context, auth *core.Auth) (string, error) {
	if org, err := uuid.Parse(str(auth.Metadata["organization_uuid"])); err == nil && org != uuid.Nil {
		return org.String(), nil
	}
	status, body, err := a.accountRequest(ctx, auth, "GET", "https://api.anthropic.com/api/oauth/profile", nil)
	var profile struct {
		Organization struct {
			UUID string `json:"uuid"`
		} `json:"organization"`
	}
	if err != nil || status != 200 || json.Unmarshal(body, &profile) != nil {
		return "", fmt.Errorf("Claude organization lookup failed")
	}
	org, err := uuid.Parse(profile.Organization.UUID)
	if err != nil || org == uuid.Nil {
		return "", fmt.Errorf("Claude organization unavailable")
	}
	_, ok, err := a.core.Modify(ctx, auth.ID, auth.RegistrationEpoch, func(latest *core.Auth) error {
		if latest.Metadata == nil {
			latest.Metadata = map[string]any{}
		}
		latest.Metadata["organization_uuid"] = org.String()
		return nil
	})
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("Claude account unavailable")
	}
	return org.String(), nil
}

// A grant can contain several resets. Keep an unanswered request's ID even if
// discovery already reports a lower count. Start another only after its result
// is known and the provider confirms the previous reset was deducted.
func (a *App) consumeClaudeResetLocked(ctx context.Context, auth *core.Auth, credit ResetCredit) error {
	if !claudeGrantID.MatchString(credit.ID) || credit.count() <= 0 {
		return fmt.Errorf("invalid Claude reset grant")
	}
	key := auth.ID + "|" + credit.ID
	previous := a.store.read().ResetAttempts[key]
	if resetAttemptBlocks(credit, previous) {
		return nil
	}
	attempt := ResetAttempt{At: now(), RequestID: previous.RequestID, Remaining: previous.Remaining}
	if attempt.RequestID == "" || previous.Result != "" {
		attempt.RequestID = uuid.NewString()
		attempt.Remaining = credit.count()
	}
	save := func() error {
		return a.store.change(func(d *diskState) error {
			if d.ResetAttempts == nil {
				d.ResetAttempts = map[string]ResetAttempt{}
			}
			d.ResetAttempts[key] = attempt
			return nil
		})
	}
	if err := save(); err != nil {
		return err
	}
	org, err := a.claudeOrganization(ctx, auth)
	if err == nil && (ctx.Err() != nil || credit.ExpiresAt == nil || !credit.ExpiresAt.After(now()) || !a.store.read().Settings.AutoUseResets) {
		return nil
	}
	if err == nil {
		latest, ok := a.core.GetByID(auth.ID)
		if !ok || latest.Disabled || !a.store.read().Connections["claude"].Enabled {
			return nil
		}
		payload, _ := json.Marshal(map[string]string{"program": "cedar_ember", "grant_id": credit.ID, "request_id": attempt.RequestID})
		status, body, requestErr := a.accountRequest(ctx, latest, "POST", "https://api.anthropic.com/api/organizations/"+org+"/reset_rate_limits", payload)
		var response struct {
			Result string `json:"result"`
		}
		if requestErr == nil && status == 200 && json.Unmarshal(body, &response) == nil {
			switch response.Result {
			case "reset":
				attempt.Result = "reset"
			case "already_used":
				attempt.Result = "already_redeemed"
			case "not_limited":
				attempt.Result = "nothing_to_reset"
			case "ineligible":
				attempt.Result = "no_credit"
			case "cooldown":
				attempt.Result = "cooldown"
			}
		}
		if attempt.Result == "" || attempt.Result == "cooldown" {
			err = fmt.Errorf("Claude reset request not confirmed")
		}
	}
	if err != nil {
		attempt.Error = "Claude reset failed. Retry pending."
	}
	saveErr := save()
	if attempt.Result == "reset" || attempt.Result == "already_redeemed" {
		if _, _, quotaErr := a.core.ResetQuota(ctx, auth.ID); quotaErr != nil {
			return fmt.Errorf("reset applied, but local cooldown could not be cleared: %w", quotaErr)
		}
	}
	if saveErr != nil {
		return saveErr
	}
	return err
}
