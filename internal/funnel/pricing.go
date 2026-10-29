package funnel

import "strings"

// USD per million tokens, verified 2026-10-29 against the linked vendor tables.
// Persist the estimate with the request so later price edits do not rewrite history.
const openAIPrices = "https://developers.openai.com/api/docs/pricing"
const claudePrices = "https://platform.claude.com/docs/en/about-claude/pricing"

type rate struct{ input, output, read, writeMin, writeMax float64 }

var prices = map[string]rate{
	"gpt-6-sol":         {2, 10, .2, 2.5, 5},
	"gpt-5.6-terra":     {2, 12, .2, 2.5, 5},
	"gpt-5.6-luna":      {.2, 1.2, .02, .25, .5},
	"gpt-6-astra":       {10, 50, 1, 12.5, 25},
	"gpt-6.1-sol":       {2, 10, .1, 2.5, 5},
	"gpt-6.1-terra":     {1, 5, .05, 1.25, 2.5},
	"gpt-6-luna":        {.1, .5, .01, .125, .25},
	"gpt-5.6-sol":       {4, 20, .4, 5, 10},
	"claude-fable-5-1":  {10, 50, .25, 12.5, 20},
	"claude-fable-5":    {10, 50, 1, 12.5, 20},
	"claude-opus-5-5":   {4, 20, .2, 5, 8},
	"claude-opus-5":     {5, 25, .5, 6.25, 10},
	"claude-opus-4-8":   {5, 25, .5, 6.25, 10},
	"claude-opus-4-7":   {5, 25, .5, 6.25, 10},
	"claude-opus-4-6":   {5, 25, .5, 6.25, 10},
	"claude-opus-4-5":   {5, 25, .5, 6.25, 10},
	"claude-opus-4-1":   {15, 75, 1.5, 18.75, 30},
	"claude-opus-4":     {15, 75, 1.5, 18.75, 30},
	"claude-sonnet-5-5": {2, 10, .1, 2.5, 4},
	"claude-sonnet-5":   {2, 10, .2, 2.5, 4},
	"claude-sonnet-4-6": {3, 15, .3, 3.75, 6},
	"claude-sonnet-4-5": {3, 15, .3, 3.75, 6},
	"claude-sonnet-4":   {3, 15, .3, 3.75, 6},
	"claude-haiku-5-5":  {.1, .5, .01, .125, .2},
	"claude-haiku-4-5":  {1, 5, .1, 1.25, 2},
	"claude-haiku-3-5":  {.8, 4, .08, 1, 1.6},
}

func estimateCost(provider, model, tier string, t Tokens) Cost {
	c := Cost{Model: model, Tier: tier, Version: "2026-10-29"}
	if provider != "codex" && provider != "claude" {
		c.Note = "No verified provider price"
		return c
	}
	name := strings.TrimSpace(strings.Split(model, "(")[0])
	name = strings.TrimSuffix(name, "-latest")
	// Dated model snapshots use their family's published price.
	if i := strings.LastIndex(name, "-20"); i > 0 && len(name[i+1:]) == 8 {
		name = name[:i]
	}
	p, ok := prices[name]
	if !ok {
		c.Note = "No verified model price"
		return c
	}
	if t.Unclassified > 0 {
		c.Note = "Provider did not classify all tokens"
		return c
	}
	if name == "claude-haiku-5-5" && t.Input+t.CacheRead+t.CacheWrite > 100000 {
		p = rate{.5, 2.5, .05, .625, 1}
	}
	multiplier := 1.0
	switch tier {
	case "", "auto", "default", "standard":
	case "flex", "batch":
		if provider == "codex" {
			multiplier = .5
		} else {
			c.Note = "Unverified service tier"
			return c
		}
	case "priority", "fast":
		if provider == "codex" {
			multiplier = 2
		} else if name == "claude-opus-5-5" || name == "claude-opus-5" || name == "claude-opus-4-8" {
			multiplier = 2
		} else {
			c.Note = "Unverified fast-mode price"
			return c
		}
	case "ultrafast":
		if provider == "codex" {
			multiplier = 6
		} else {
			c.Note = "Unverified service tier"
			return c
		}
	default:
		c.Note = "Unverified service tier"
		return c
	}
	if provider == "codex" && t.Input+t.CacheRead+t.CacheWrite > 272000 {
		p.input *= 2
		p.read *= 2
		p.writeMin *= 2
		p.writeMax *= 2
		p.output *= 1.5
	}
	c.Input = float64(t.Input) * p.input / 1e6 * multiplier
	c.Output = float64(t.Output) * p.output / 1e6 * multiplier
	c.Reasoning = float64(t.Reasoning) * p.output / 1e6 * multiplier
	c.CacheRead = float64(t.CacheRead) * p.read / 1e6 * multiplier
	c.CacheWrite = float64(t.CacheWrite) * p.writeMin / 1e6 * multiplier
	c.Min = c.Input + c.Output + c.Reasoning + c.CacheRead + c.CacheWrite
	c.Max = c.Min + float64(t.CacheWrite)*(p.writeMax-p.writeMin)/1e6*multiplier
	c.Priced = true
	if t.CacheWrite > 0 {
		c.Note = "Cache-write retention not reported; range uses published short/long retention prices"
	}
	return c
}
