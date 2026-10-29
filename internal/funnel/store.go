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
	"sync"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type Grant struct {
	ConnectionID     string   `json:"connectionId"`
	AccountIDs       []string `json:"accountIds"`
	Models           []string `json:"models"`
	SubscriptionOnly bool     `json:"subscriptionOnly,omitempty"`
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
	Sessions      map[string]time.Time    `json:"sessions"`
	Usage         map[string]int          `json:"usage"`
	Requests      []RequestLog            `json:"requests"`
	Daily         map[string]DailyUsage   `json:"daily,omitempty"`
	Hourly        map[string]DailyUsage   `json:"hourly"`
	KeyUsage      map[string]UsageTotals  `json:"keyUsage"`
	TrackingAt    *time.Time              `json:"trackingAt,omitempty"`
}
type Store struct {
	mu     sync.Mutex
	dir    string
	cipher cipher.AEAD
	state  diskState
	Admin  string
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
		if a.CodexRefreshPatch != nil {
			if previous := d.Auths[a.ID]; previous != nil {
				copy.Metadata = a.CodexRefreshPatch.Apply(previous.Metadata)
			}
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
	return s.change(func(d *diskState) error { delete(d.Auths, id); return nil })
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
