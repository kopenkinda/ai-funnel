package funnel

import (
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

func (a *App) requestLogs(c *gin.Context) {
	d := a.store.read()
	rows := []RequestLog{}
	models := []string{}
	seen := map[string]bool{}
	q := strings.ToLower(strings.TrimSpace(c.Query("q")))
	for _, r := range d.Requests {
		if r.Model != "" && !seen[r.Model] {
			models = append(models, r.Model)
			seen[r.Model] = true
		}
		if v := c.Query("provider"); v != "" && v != r.Provider {
			continue
		}
		if v := c.Query("account"); v != "" && v != r.AccountID {
			continue
		}
		if v := c.Query("key"); v != "" && v != r.KeyID {
			continue
		}
		if v := c.Query("model"); v != "" && v != r.Model {
			continue
		}
		if v := c.Query("transport"); v != "" && v != r.Transport {
			continue
		}
		if v := c.Query("status"); (v == "ok" && r.Status >= 400) || (v == "error" && r.Status < 400) {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(strings.Join([]string{r.ID, r.AccountName, r.AccountID, r.Model, r.ErrorCode, r.KeyName, d.Keys[r.KeyID].Name, d.Connections[r.ConnectionID].Name}, " ")), q) {
			continue
		}
		rows = append(rows, r)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].At.After(rows[j].At) })
	sort.Strings(models)
	total := len(rows)
	page, _ := strconv.Atoi(c.Query("page"))
	if page < 1 {
		page = 1
	}
	pages := max(1, (total+49)/50)
	if page > pages {
		page = pages
	}
	start := (page - 1) * 50
	rows = rows[start:min(start+50, total)]
	c.JSON(200, gin.H{"items": rows, "total": total, "page": page, "pages": pages, "models": models})
}
