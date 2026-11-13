package funnel

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type Grant struct {
	ConnectionID     string   `json:"connectionId"`
	AccountIDs       []string `json:"accountIds"`
	Models           []string `json:"models"`
	SubscriptionOnly bool     `json:"subscriptionOnly,omitempty"`
	// Routing overrides the provider's routing setting for this key.
	Routing *Routing `json:"routing,omitempty"`
}
type Key struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Hash          string     `json:"hash,omitempty"`
	Prefix        string     `json:"prefix"`
	Enabled       bool       `json:"enabled"`
	ArchivedAt    *time.Time `json:"archivedAt,omitempty"`
	ExpiresAt     *time.Time `json:"expiresAt"`
	DailyLimit    *int       `json:"dailyLimit"`
	Grants        []Grant    `json:"grants"`
	Imported      bool       `json:"imported"`
	CreatedAt     time.Time  `json:"createdAt"`
	LastUsedAt    *time.Time `json:"lastUsedAt"`
	RequestsToday int        `json:"requestsToday"`
	HubHash       string     `json:"hubHash,omitempty"`
	HubResets     bool       `json:"hubResets,omitempty"`
	HubEmails     bool       `json:"hubEmails,omitempty"`
	HasHubKey     bool       `json:"hasHubKey,omitempty"`
}
type Connection struct {
	ID        string    `json:"id"`
	Provider  string    `json:"provider"`
	Name      string    `json:"name"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"createdAt"`
}
type RequestLog struct {
	ID                string    `json:"id"`
	At                time.Time `json:"at"`
	ConnectionID      string    `json:"connectionId"`
	KeyID             string    `json:"keyId"`
	KeyName           string    `json:"keyName,omitempty"`
	Model             string    `json:"model"`
	Status            int       `json:"status"`
	DurationMs        int64     `json:"durationMs"`
	ParentID          string    `json:"parentId,omitempty"`
	AccountID         string    `json:"accountId,omitempty"`
	AccountName       string    `json:"accountName,omitempty"`
	Plan              string    `json:"plan,omitempty"`
	Provider          string    `json:"provider,omitempty"`
	Transport         string    `json:"transport,omitempty"`
	UpstreamTransport string    `json:"upstreamTransport,omitempty"`
	TTFTMs            int64     `json:"ttftMs,omitempty"`
	Tokens            *Tokens   `json:"tokens,omitempty"`
	Cost              *Cost     `json:"cost,omitempty"`
	ErrorCode         string    `json:"errorCode,omitempty"`
	Reasoning         string    `json:"reasoning,omitempty"`
}

// Billing is a user-entered payment cycle. Funnel only displays it; it never charges or verifies anything.
type Billing struct {
	Amount   float64 `json:"amount"`
	Currency string  `json:"currency"`
	Interval string  `json:"interval"`
	Anchor   string  `json:"anchor"`
}

func (b Billing) valid() bool {
	_, e := time.Parse(time.DateOnly, b.Anchor)
	return e == nil && b.Amount >= 0 && b.Amount < 1e6 && (b.Interval == "month" || b.Interval == "year") && len(b.Currency) == 3 && strings.ToUpper(b.Currency) == b.Currency
}

type Settings struct {
	AutoUseResets bool               `json:"autoUseResets"`
	HubTokenHash  string             `json:"hubTokenHash,omitempty"`
	Routing       map[string]Routing `json:"routing,omitempty"`
}
type diskState struct {
	ResetAttempts map[string]ResetAttempt `json:"resetAttempts,omitempty"`
	Settings      Settings                `json:"settings"`
	Snapshots     map[string]Snapshot     `json:"snapshots"`
	Connections   map[string]Connection   `json:"connections"`
	Keys          map[string]Key          `json:"keys"`
	Auths         map[string]*core.Auth   `json:"auths"`
	// Kept outside SDK auth records so token refreshes and re-imports cannot drop it.
	Billing map[string]Billing `json:"billing,omitempty"`
	// Archived accounts are always paused and hidden from pools, routing and the hub.
	Archived   map[string]bool        `json:"archived,omitempty"`
	Sessions   map[string]time.Time   `json:"sessions"`
	Usage      map[string]int         `json:"usage"`
	Requests   []RequestLog           `json:"requests"`
	Daily      map[string]DailyUsage  `json:"daily,omitempty"`
	Hourly     map[string]DailyUsage  `json:"hourly"`
	KeyUsage   map[string]UsageTotals `json:"keyUsage"`
	TrackingAt *time.Time             `json:"trackingAt,omitempty"`
	// Keyed by account ID; see recordQuota.
	QuotaHistory map[string]QuotaHistory `json:"quotaHistory,omitempty"`
}
type Store struct {
	mu     sync.Mutex
	dir    string
	cipher cipher.AEAD
	state  diskState
	Admin  string
	// Codex refresh receipts. Holding them here keeps the SDK from writing
	// rotated tokens to plaintext files under the auth directory.
	refreshMu sync.Mutex
	refreshes map[string][]byte
}

// RefreshClaim, RefreshRead and RefreshComplete implement the SDK's Codex
// refresh journal, so one process never exchanges a refresh token twice.
func (s *Store) RefreshClaim(_ context.Context, key string) (bool, error) {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	if _, ok := s.refreshes[key]; ok {
		return false, nil
	}
	if s.refreshes == nil {
		s.refreshes = map[string][]byte{}
	}
	s.refreshes[key] = nil
	return true, nil
}

func (s *Store) RefreshRead(_ context.Context, key string) ([]byte, error) {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	receipt, ok := s.refreshes[key]
	if ok && receipt == nil {
		return []byte(`{"stage":"pending"}`), nil
	}
	return append([]byte(nil), receipt...), nil
}

func (s *Store) RefreshComplete(_ context.Context, key string, receipt []byte) error {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	if s.refreshes == nil {
		s.refreshes = map[string][]byte{}
	}
	s.refreshes[key] = append([]byte(nil), receipt...)
	return nil
}

func token() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func digest(s string) string { v := sha256.Sum256([]byte(s)); return hex.EncodeToString(v[:]) }
func now() time.Time         { return time.Now().UTC() }
func NewStore(dir, admin string) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	readOrCreate := func(name string, value []byte) ([]byte, error) {
		p := filepath.Join(dir, name)
		b, e := os.ReadFile(p)
		if os.IsNotExist(e) {
			e = os.WriteFile(p, value, 0600)
			b = value
		}
		return b, e
	}
	master := make([]byte, 32)
	if _, e := rand.Read(master); e != nil {
		return nil, e
	}
	master, e := readOrCreate("master.key", master)
	if e != nil {
		return nil, e
	}
	if len(master) != 32 {
		return nil, fmt.Errorf("master key must contain 32 bytes")
	}
	block, e := aes.NewCipher(master)
	if e != nil {
		return nil, e
	}
	aead, e := cipher.NewGCM(block)
	if e != nil {
		return nil, e
	}
	if admin == "" {
		b, e := readOrCreate("admin-token", []byte(token()))
		if e != nil {
			return nil, e
		}
		admin = string(b)
	}
	if len(admin) < 16 {
		return nil, fmt.Errorf("dashboard key must have at least 16 characters")
	}
	s := &Store{dir: dir, cipher: aead, Admin: admin, state: diskState{Snapshots: map[string]Snapshot{}, Connections: map[string]Connection{}, Keys: map[string]Key{}, Auths: map[string]*core.Auth{}, Sessions: map[string]time.Time{}, Usage: map[string]int{}, Requests: []RequestLog{}}}
	b, e := os.ReadFile(filepath.Join(dir, "state.enc"))
	if e == nil {
		if len(b) < aead.NonceSize() {
			return nil, fmt.Errorf("invalid encrypted state")
		}
		b, e = aead.Open(nil, b[:aead.NonceSize()], b[aead.NonceSize():], nil)
		if e != nil {
			return nil, e
		}
		if e = json.Unmarshal(b, &s.state); e != nil {
			return nil, e
		}
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	upgraded := false
	if s.state.Hourly == nil {
		upgraded = true
		s.state.Hourly = map[string]DailyUsage{}
		// Upgrade existing metadata so Today includes already-recorded usage.
		for _, r := range s.state.Requests {
			if r.Tokens != nil && r.Cost != nil && !r.At.Before(now().AddDate(0, 0, -2)) {
				s.state.addHourly(r.At, r.Provider, *r.Tokens, *r.Cost)
			}
		}
	}
	if s.state.KeyUsage == nil {
		upgraded = true
		s.state.KeyUsage = map[string]UsageTotals{}
		// Older versions only retained per-key attribution in request metadata.
		for _, r := range s.state.Requests {
			if r.KeyID != "" && r.Tokens != nil && r.Cost != nil {
				s.state.addKeyUsage(r.KeyID, *r.Tokens, *r.Cost)
			}
		}
	}
	// Prices ship with the binary, so a restart is when new ones can apply.
	// Runs after the rebuilds above, which count requests at their stored cost.
	if s.state.reprice() {
		upgraded = true
	}
	if upgraded && e == nil {
		if err := s.change(func(*diskState) error { return nil }); err != nil {
			return nil, err
		}
	}
	return s, nil
}
func (s *Store) read() diskState {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, _ := json.Marshal(s.state)
	var d diskState
	_ = json.Unmarshal(b, &d)
	return d
}

// routingInputs avoids copying the whole state for every account selection.
func (s *Store) routingInputs(provider string, ids []string) (Routing, map[string]Snapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	snaps := make(map[string]Snapshot, len(ids))
	for _, id := range ids {
		if snap, ok := s.state.Snapshots[id]; ok {
			snaps[id] = Snapshot{Plan: snap.Plan, PlanTier: snap.PlanTier, Quotas: append([]Quota(nil), snap.Quotas...), At: snap.At}
		}
	}
	return s.state.Settings.routing(provider), snaps
}
func (s *Store) change(fn func(*diskState) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	backup, _ := json.Marshal(s.state)
	if e := fn(&s.state); e != nil {
		_ = json.Unmarshal(backup, &s.state)
		return e
	}
	b, e := json.Marshal(s.state)
	if e != nil {
		_ = json.Unmarshal(backup, &s.state)
		return e
	}
	nonce := make([]byte, s.cipher.NonceSize())
	if _, e = rand.Read(nonce); e != nil {
		_ = json.Unmarshal(backup, &s.state)
		return e
	}
	b = s.cipher.Seal(nonce, nonce, b, nil)

	tmp, e := os.CreateTemp(s.dir, ".state-*")
	if e == nil {
		name := tmp.Name()
		defer os.Remove(name)
		_, e = tmp.Write(b)
		if e == nil {
			e = tmp.Sync()
		}
		closeErr := tmp.Close()
		if e == nil {
			e = closeErr
		}
		if e == nil {
			e = os.Rename(name, filepath.Join(s.dir, "state.enc"))
		}
	}

	if e != nil {
		_ = json.Unmarshal(backup, &s.state)
	}
	return e
}

// sameAccount reports whether two credentials sign in to one provider account.
// OAuth names Codex credentials by plan, so IDs alone change after an upgrade.
func sameAccount(old, auth *core.Auth) bool {
	if old.Provider != auth.Provider {
		return false
	}
	field := "account_id"
	if auth.Provider == "claude" {
		field = "account_uuid"
	}
	identity := str(auth.Metadata[field])
	email, oldEmail := str(auth.Metadata["email"]), str(old.Metadata["email"])
	emailMatches := email == "" || oldEmail == "" || strings.EqualFold(email, oldEmail)
	return identity != "" && identity == str(old.Metadata[field]) && emailMatches && str(old.Metadata["organization_uuid"]) == str(auth.Metadata["organization_uuid"])
}

// adoptAccount keeps the existing ID so key grants, billing and history stay
// attached. A manual pause survives; a sign-out the SDK disabled does not.
func adoptAccount(old, auth *core.Auth) {
	auth.ID, auth.CreatedAt = old.ID, old.CreatedAt
	auth.Disabled = old.Disabled && !core.HasDisabledInvalidGrantFailure(old)
}

// The SDK uses this store for both OAuth login and refresh. No plaintext token files are created.
func (s *Store) List(context.Context) ([]*core.Auth, error) {
	d := s.read()
	out := make([]*core.Auth, 0, len(d.Auths))
	for _, a := range d.Auths {
		defaultTransport(a)
		out = append(out, a)
	}
	return out, nil
}
func (s *Store) Save(_ context.Context, a *core.Auth) (string, error) {
	defaultTransport(a)
	b, e := json.Marshal(a)
	if e != nil {
		return "", e
	}
	var copy core.Auth
	if e = json.Unmarshal(b, &copy); e != nil {
		return "", e
	}
	if copy.Metadata == nil {
		copy.Metadata = map[string]any{}
	}
	if a.Storage != nil {
		b, e = json.Marshal(a.Storage)
		if e != nil {
			return "", e
		}
		var tokens map[string]any
		if e = json.Unmarshal(b, &tokens); e != nil {
			return "", e
		}
		for k, v := range tokens {
			copy.Metadata[k] = v
		}
		a.Metadata = copy.Metadata
	}
	copy.Metadata["type"] = a.Provider
	// A virtual path keeps SDK post-persist registration from reading an unencrypted file.
	e = s.change(func(d *diskState) error {
		// The SDK registers the record under whatever ID it holds after Save,
		// so a new login for a known account updates that account in place.
		if d.Auths[a.ID] == nil {
			for _, old := range d.Auths {
				if sameAccount(old, &copy) {
					adoptAccount(old, a)
					copy.ID, copy.CreatedAt, copy.Disabled = a.ID, a.CreatedAt, a.Disabled
					break
				}
			}
		}
		if a.CodexRefreshPatch != nil {
			if previous := d.Auths[a.ID]; previous != nil {
				copy.Metadata = a.CodexRefreshPatch.Apply(previous.Metadata)
			}
		}
		// Archive implies paused, so a save that enables the account (a new login
		// or resume) brings it back rather than leaving a hidden account routing.
		if !copy.Disabled {
			delete(d.Archived, copy.ID)
		}
		d.Auths[a.ID] = &copy
		return nil
	})
	if e == nil {
		b, _ := json.Marshal(copy.Metadata)
		var metadata map[string]any
		_ = json.Unmarshal(b, &metadata)
		a.Metadata = metadata
	}
	return "encrypted:" + a.ID, e
}
func (s *Store) Delete(_ context.Context, id string) error {
	return s.change(func(d *diskState) error {
		delete(d.Auths, id)
		delete(d.Billing, id)
		delete(d.Archived, id)
		delete(d.QuotaHistory, id)
		return nil
	})
}
func usageID(id string) string { return now().Format("2006-01-02") + ":" + id }

// Default Codex imports to native WebSockets while preserving explicit choices.
func defaultTransport(a *core.Auth) {
	if a.Provider != "codex" {
		return
	}
	if a.Attributes == nil {
		a.Attributes = map[string]string{}
	}
	if _, exists := a.Attributes["websockets"]; exists {
		return
	}
	value := "true"
	if v, exists := a.Metadata["websockets"]; exists {
		value = fmt.Sprint(v)
	}
	a.Attributes["websockets"] = value
}
