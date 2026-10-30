package funnel

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// public drops both secret digests before a key leaves the dashboard API.
func (k Key) public() Key {
	k.HasHubKey = k.HubHash != ""
	k.Hash, k.HubHash = "", ""
	return k
}

// keyHubToken issues or revokes a usage hub key limited to one client key's accounts.
func (a *App) keyHubToken(c *gin.Context, id string, issue bool) {
	value := ""
	if issue {
		value = "sk-hub-" + token()
	}
	status := 400
	err := a.store.change(func(d *diskState) error {
		k, ok := d.Keys[id]
		if !ok {
			status = 404
			return fmt.Errorf("Key not found.")
		}
		if issue && k.ArchivedAt != nil {
			return fmt.Errorf("Restore this key before adding a hub key.")
		}
		k.HubHash = ""
		if issue {
			k.HubHash = digest(value)
		}
		d.Keys[id] = k
		status = 500
		return nil
	})
	if err != nil {
		if status == 500 {
			fail(c, 500, "Could not save key settings.")
		} else {
			fail(c, status, err.Error())
		}
		return
	}
	if issue {
		c.JSON(201, gin.H{"token": value})
	} else {
		c.JSON(200, gin.H{"revoked": true})
	}
}

func validateKey(k Key, connections map[string]Connection, accounts map[string]string) error {
	if strings.TrimSpace(k.Name) == "" || len(k.Name) > 80 || len(k.Grants) == 0 || len(k.Grants) > 30 || (k.DailyLimit != nil && *k.DailyLimit < 1) {
		return fmt.Errorf("Supply a name, provider access, and a valid request limit.")
	}
	seen := map[string]bool{}
	for _, g := range k.Grants {
		conn, ok := connections[g.ConnectionID]
		if !ok || seen[g.ConnectionID] || (g.AccountIDs != nil && len(g.AccountIDs) == 0) || (g.Models != nil && len(g.Models) == 0) {
			return fmt.Errorf("Select valid providers, accounts, and models.")
		}
		seen[g.ConnectionID] = true
		if g.SubscriptionOnly && conn.Provider != "codex" {
			return fmt.Errorf("Subscription-only access is supported for Codex.")
		}
		for _, id := range g.AccountIDs {
			if accounts[id] != conn.Provider {
				return fmt.Errorf("Account not found in this provider.")
			}
		}
		for _, model := range g.Models {
			if strings.TrimSpace(model) == "" || len(model) > 256 {
				return fmt.Errorf("Select a valid model.")
			}
		}
	}
	return nil
}

func (a *App) updateKey(c *gin.Context, id string) {
	var b struct {
		Enabled    *bool           `json:"enabled"`
		Archived   *bool           `json:"archived"`
		Name       *string         `json:"name"`
		Grants     *[]Grant        `json:"grants"`
		ExpiresAt  json.RawMessage `json:"expiresAt"`
		DailyLimit json.RawMessage `json:"dailyLimit"`
		HubResets  *bool           `json:"hubResets"`
	}
	if !decode(c, &b) {
		return
	}
	if b.Enabled == nil && b.Archived == nil && b.Name == nil && b.Grants == nil && b.ExpiresAt == nil && b.DailyLimit == nil && b.HubResets == nil {
		fail(c, 400, "Supply key settings to update.")
		return
	}
	accounts := a.accountProviders()
	var updated Key
	status := 400
	err := a.store.change(func(d *diskState) error {
		k, ok := d.Keys[id]
		if !ok {
			status = 404
			return fmt.Errorf("Key not found.")
		}
		if k.ArchivedAt != nil && b.Enabled != nil && *b.Enabled {
			return fmt.Errorf("Restore this key before enabling it.")
		}
		if b.Enabled != nil {
			k.Enabled = *b.Enabled
		}
		if b.Name != nil {
			k.Name = *b.Name
		}
		if b.HubResets != nil {
			k.HubResets = *b.HubResets
		}
		if b.Grants != nil {
			k.Grants = *b.Grants
		}
		if b.ExpiresAt != nil {
			if err := json.Unmarshal(b.ExpiresAt, &k.ExpiresAt); err != nil {
				return fmt.Errorf("Choose a valid expiration.")
			}
			if k.ExpiresAt != nil && !k.ExpiresAt.After(now()) {
				return fmt.Errorf("Choose a future expiration.")
			}
		}
		if b.DailyLimit != nil {
			if err := json.Unmarshal(b.DailyLimit, &k.DailyLimit); err != nil {
				return fmt.Errorf("Supply a valid request limit.")
			}
		}
		if b.Archived != nil {
			if *b.Archived {
				if k.ArchivedAt == nil {
					t := now()
					k.ArchivedAt = &t
				}
				k.Enabled = false
			} else if k.ArchivedAt != nil {
				k.ArchivedAt = nil
				k.Enabled = false
			}
		}
		// A pause remains available even after an assigned connection was removed.
		if b.Name != nil || b.Grants != nil || b.ExpiresAt != nil || b.DailyLimit != nil {
			if err := validateKey(k, d.Connections, accounts); err != nil {
				return err
			}
		}
		d.Keys[id] = k
		updated = k
		status = 500
		return nil
	})
	if err != nil {
		if status == 500 {
			fail(c, 500, "Could not save key settings.")
		} else {
			fail(c, status, err.Error())
		}
		return
	}
	c.JSON(200, updated.public())
}

func (a *App) createKey(c *gin.Context) {
	var b struct {
		Name       string     `json:"name"`
		Existing   string     `json:"existingKey"`
		Grants     []Grant    `json:"grants"`
		ExpiresAt  *time.Time `json:"expiresAt"`
		DailyLimit *int       `json:"dailyLimit"`
	}
	if !decode(c, &b) {
		return
	}
	if b.ExpiresAt != nil && !b.ExpiresAt.After(now()) {
		fail(c, 400, "Choose a future expiration.")
		return
	}
	value := b.Existing
	if value == "" {
		value = "sk-af-" + token()
	} else if len(value) < 16 || strings.ContainsAny(value, " \t\r\n") {
		fail(c, 400, "Supply a valid existing key.")
		return
	}
	k := Key{ID: token()[:24], Name: b.Name, Hash: digest(value), Prefix: value[:min(8, len(value)/2)], Enabled: true, ExpiresAt: b.ExpiresAt, DailyLimit: b.DailyLimit, Grants: b.Grants, Imported: b.Existing != "", CreatedAt: now()}
	if err := validateKey(k, a.store.read().Connections, a.accountProviders()); err != nil {
		fail(c, 400, err.Error())
		return
	}
	if !a.save(c, func(d *diskState) error {
		for _, old := range d.Keys {
			if old.Hash == k.Hash {
				return fmt.Errorf("key already registered")
			}
		}
		d.Keys[k.ID] = k
		return nil
	}) {
		return
	}
	k = k.public()
	var shown any = value
	if b.Existing != "" {
		shown = nil
	}
	c.JSON(201, gin.H{"key": k, "token": shown})
}
