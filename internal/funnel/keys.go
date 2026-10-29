package funnel

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

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
		Name       *string         `json:"name"`
		Grants     *[]Grant        `json:"grants"`
		ExpiresAt  json.RawMessage `json:"expiresAt"`
		DailyLimit json.RawMessage `json:"dailyLimit"`
	}
	if !decode(c, &b) {
		return
	}
	if b.Enabled == nil && b.Name == nil && b.Grants == nil && b.ExpiresAt == nil && b.DailyLimit == nil {
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
		if b.Enabled != nil {
			k.Enabled = *b.Enabled
		}
		if b.Name != nil {
			k.Name = *b.Name
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
	updated.Hash = ""
	c.JSON(200, updated)
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
	k.Hash = ""
	var shown any = value
	if b.Existing != "" {
		shown = nil
	}
	c.JSON(201, gin.H{"key": k, "token": shown})
}
