package funnel

import (
	"context"
	"math"
	"math/rand/v2"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

var routingStrategies = []string{"capacity_weighted", "relative_availability", "usage_weighted", "round_robin", "fill_first", "sequential_drain", "reset_drain", "single_account"}

type Routing struct {
	Strategy           string  `json:"strategy"`
	StickySessions     bool    `json:"stickySessions"`
	PreferEarlierReset bool    `json:"preferEarlierReset"`
	ResetWindow        string  `json:"resetWindow"`
	Power              float64 `json:"power"`
	TopK               int     `json:"topK"`
	AccountID          string  `json:"accountId,omitempty"`
}

func defaultRouting() Routing {
	return Routing{Strategy: "capacity_weighted", StickySessions: true, PreferEarlierReset: true, ResetWindow: "secondary", Power: 2, TopK: 5}
}
func (s Settings) routing(provider string) Routing {
	if r, ok := s.Routing[provider]; ok {
		return r
	}
	return defaultRouting()
}

// Single-account routing names one enabled account of the same provider.
func (a *App) validRouting(provider string, r Routing) (Routing, string) {
	if !contains(routingStrategies, r.Strategy) {
		return r, "Select a routing strategy."
	}
	if r.ResetWindow != "primary" && r.ResetWindow != "secondary" {
		return r, "Select the primary or secondary reset window."
	}
	if math.IsNaN(r.Power) || r.Power <= 0 || r.Power > 10 {
		return r, "Weight exponent must be greater than 0 and at most 10."
	}
	if r.TopK < 1 || r.TopK > 50 {
		return r, "Top accounts must be between 1 and 50."
	}
	if r.Strategy != "single_account" {
		r.AccountID = ""
		return r, ""
	}
	auth, ok := a.core.GetByID(r.AccountID)
	if r.AccountID == "" || !ok || auth.Provider != provider || auth.Disabled {
		return r, "Select an active " + provider + " account."
	}
	return r, ""
}

type usageWindow struct {
	used     float64
	resetsAt *time.Time
}
type accountQuota struct {
	primary, secondary *usageWindow
	capacity           float64
	exhausted          bool
}

// Relative capacity matches the dashboard plan badges. Unknown plans count as 1.
func planCapacity(provider, raw string) float64 {
	plan := strings.NewReplacer(" ", "", "_", "", "-", "").Replace(strings.ToLower(raw))
	tiers := map[string]float64{"prolite": 5, "pro100": 5, "pro": 10, "pro200": 10, "promax": 20, "pro500": 20}
	if provider == "claude" {
		tiers = map[string]float64{"max5x": 5, "claudemax5x": 5, "defaultclaudemax5x": 5, "max20x": 20, "claudemax20x": 20, "defaultclaudemax20x": 20}
	}
	if v, ok := tiers[plan]; ok {
		return v
	}
	return 1
}
func accountPlan(snap Snapshot, auth *core.Auth) string {
	if snap.PlanTier != "" {
		return snap.PlanTier
	}
	if snap.Plan != "" {
		return snap.Plan
	}
	if tier := str(auth.Metadata["rate_limit_tier"]); tier != "" {
		return tier
	}
	return str(auth.Metadata["plan_type"])
}

// Labels end in the window length; any preceding text names a model or
// limit scope. Code review and unrecognized scopes do not affect routing.
func quotaWindow(label string) (scope string, length time.Duration, ok bool) {
	scope, unit := "", label
	if i := strings.LastIndexByte(label, ' '); i >= 0 {
		scope, unit = label[:i], label[i+1:]
	}
	if len(unit) < 2 {
		return "", 0, false
	}
	n, err := strconv.ParseFloat(unit[:len(unit)-1], 64)
	if err != nil || n <= 0 {
		return "", 0, false
	}
	switch unit[len(unit)-1] {
	case 'h':
		return scope, time.Duration(n * float64(time.Hour)), true
	case 'd':
		return scope, time.Duration(n * 24 * float64(time.Hour)), true
	}
	return "", 0, false
}
func words(s string) []string {
	return strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
}
func scopeMatches(scope, model string) bool {
	if scope == "" {
		return true
	}
	want := words(scope)
	if len(want) == 0 || strings.HasPrefix(strings.ToLower(scope), "code review") {
		return false
	}
	have := words(model)
	for _, w := range want {
		if !contains(have, w) {
			return false
		}
	}
	return true
}

// Windows shorter than a day are primary; longer ones are secondary. The most
// used account-wide or matching model window of each kind applies. A window
// whose reset time has passed counts as unused until the next quota read.
func quotaFor(provider, model string, snap Snapshot, auth *core.Auth, at time.Time) accountQuota {
	q := accountQuota{capacity: planCapacity(provider, accountPlan(snap, auth))}
	for _, quota := range snap.Quotas {
		scope, length, ok := quotaWindow(quota.Label)
		if !ok || quota.Remaining == nil || !scopeMatches(scope, model) {
			continue
		}
		w := &usageWindow{used: 100 - *quota.Remaining, resetsAt: quota.ResetsAt}
		if w.resetsAt != nil && !w.resetsAt.After(at) {
			w = &usageWindow{}
		}
		slot := &q.secondary
		if length < 24*time.Hour {
			slot = &q.primary
		}
		if *slot == nil || w.used > (*slot).used {
			*slot = w
		}
		if w.used >= 100 {
			q.exhausted = true
		}
	}
	return q
}
func (q accountQuota) primaryUsed() float64 {
	if q.primary == nil {
		return 0
	}
	return q.primary.used
}

// Plans without a secondary window use their primary window.
func (q accountQuota) secondaryUsed() float64 {
	if q.secondary == nil {
		return q.primaryUsed()
	}
	return q.secondary.used
}
func (q accountQuota) remaining() float64 {
	return q.capacity * max(0, 100-q.secondaryUsed()) / 100
}
func (q accountQuota) reset(window string) *time.Time {
	first, second := q.secondary, q.primary
	if window == "primary" {
		first, second = second, first
	}
	for _, w := range []*usageWindow{first, second} {
		if w != nil && w.resetsAt != nil {
			return w.resetsAt
		}
	}
	return nil
}

const unknownReset = 365 * 24 * time.Hour

// Secondary resets compare by whole day and primary resets by whole hour.
func (q accountQuota) resetBucket(window string, at time.Time) int64 {
	unit := 24 * time.Hour
	if window == "primary" {
		unit = time.Hour
	}
	until := unknownReset
	if t := q.reset(window); t != nil {
		until = max(0, t.Sub(at))
	}
	return int64(until / unit)
}

type routePlanKey struct{}
type routePlan struct {
	route  Routing
	quotas map[string]accountQuota
	at     time.Time
}

// strategy chooses among candidates that already passed access, account
// state, model, and quota filters. It is also the session-affinity fallback.
type strategy struct{ s *selector }

func (p strategy) Pick(ctx context.Context, provider, model string, opts executor.Options, auths []*core.Auth) (*core.Auth, error) {
	plan, _ := ctx.Value(routePlanKey{}).(routePlan)
	if len(auths) == 0 {
		return nil, &core.Error{Code: "auth_not_found", Message: "no auth available"}
	}
	if plan.route.Strategy == "round_robin" {
		return p.s.rr.Pick(ctx, provider, model, opts, auths)
	}
	q := func(a *core.Auth) accountQuota { return plan.quotas[a.ID] }
	pool := auths
	if plan.route.PreferEarlierReset && contains([]string{"capacity_weighted", "usage_weighted", "fill_first"}, plan.route.Strategy) {
		best := int64(math.MaxInt64)
		for _, a := range auths {
			best = min(best, q(a).resetBucket(plan.route.ResetWindow, plan.at))
		}
		pool = nil
		for _, a := range auths {
			if q(a).resetBucket(plan.route.ResetWindow, plan.at) == best {
				pool = append(pool, a)
			}
		}
	}
	pool = append([]*core.Auth(nil), pool...)
	sort.Slice(pool, func(i, j int) bool { return pool[i].ID < pool[j].ID })
	first := func(less func(x, y accountQuota) int) *core.Auth {
		best := pool[0]
		for _, a := range pool[1:] {
			if less(q(a), q(best)) < 0 {
				best = a
			}
		}
		return best
	}
	var selected *core.Auth
	switch plan.route.Strategy {
	case "capacity_weighted":
		weights := make([]float64, len(pool))
		for i, a := range pool {
			weights[i] = q(a).remaining()
		}
		selected = p.s.weighted(pool, weights)
		if selected == nil {
			selected = p.s.leastUsed(pool, q)
		}
	case "relative_availability":
		selected = p.s.relative(pool, q, plan)
	case "usage_weighted":
		selected = p.s.leastUsed(pool, q)
	case "fill_first":
		selected = first(func(x, y accountQuota) int {
			return compare(y.primaryUsed(), x.primaryUsed(), y.secondaryUsed(), x.secondaryUsed())
		})
	case "sequential_drain":
		selected = first(func(x, y accountQuota) int { return compare(x.capacity, y.capacity) })
	case "reset_drain":
		selected = first(func(x, y accountQuota) int {
			return compare(float64(x.resetBucket("secondary", plan.at)), float64(y.resetBucket("secondary", plan.at)), x.primaryUsed(), y.primaryUsed(), x.secondaryUsed(), y.secondaryUsed())
		})
	default:
		selected = pool[0]
	}
	p.s.mu.Lock()
	if p.s.last == nil {
		p.s.last = map[string]time.Time{}
	}
	p.s.last[selected.ID] = plan.at
	p.s.mu.Unlock()
	return selected, nil
}

// compare orders pairs of values left to right.
func compare(pairs ...float64) int {
	for i := 0; i+1 < len(pairs); i += 2 {
		if pairs[i] < pairs[i+1] {
			return -1
		}
		if pairs[i] > pairs[i+1] {
			return 1
		}
	}
	return 0
}

// leastUsed prefers lower secondary then primary usage, then the account
// selected least recently so equal accounts alternate between quota reads.
func (s *selector) leastUsed(pool []*core.Auth, q func(*core.Auth) accountQuota) *core.Auth {
	s.mu.Lock()
	defer s.mu.Unlock()
	best := pool[0]
	for _, a := range pool[1:] {
		x, y := q(a), q(best)
		c := compare(x.secondaryUsed(), y.secondaryUsed(), x.primaryUsed(), y.primaryUsed())
		if c < 0 || (c == 0 && s.last[a.ID].Before(s.last[best.ID])) {
			best = a
		}
	}
	return best
}

// relative weights remaining capacity per second until the secondary reset,
// raised to the configured power, among the top accounts. Accounts below a
// tenth of the best weight are skipped.
func (s *selector) relative(pool []*core.Auth, q func(*core.Auth) accountQuota, plan routePlan) *core.Auth {
	scores := make([]float64, len(pool))
	best := 0.0
	for i, a := range pool {
		until := 7 * 24 * time.Hour
		if t := q(a).reset("secondary"); t != nil {
			until = t.Sub(plan.at)
		}
		scores[i] = q(a).remaining() / max(until, 5*time.Minute).Seconds()
		best = max(best, scores[i])
	}
	if best <= 0 {
		return s.leastUsed(pool, q)
	}
	type ranked struct {
		auth   *core.Auth
		weight float64
	}
	top := []ranked{}
	for i, a := range pool {
		if w := math.Pow(scores[i]/best, plan.route.Power); w >= 0.1 {
			top = append(top, ranked{a, w})
		}
	}
	sort.SliceStable(top, func(i, j int) bool { return top[i].weight > top[j].weight })
	top = top[:min(len(top), plan.route.TopK)]
	auths, weights := make([]*core.Auth, len(top)), make([]float64, len(top))
	for i, r := range top {
		auths[i], weights[i] = r.auth, r.weight
	}
	return s.weighted(auths, weights)
}
func (s *selector) weighted(pool []*core.Auth, weights []float64) *core.Auth {
	total := 0.0
	for _, w := range weights {
		total += w
	}
	if total <= 0 {
		return nil
	}
	draw := rand.Float64
	if s.random != nil {
		draw = s.random
	}
	n := draw() * total
	for i, w := range weights {
		if n < w {
			return pool[i]
		}
		n -= w
	}
	for i := len(pool) - 1; i >= 0; i-- {
		if weights[i] > 0 {
			return pool[i]
		}
	}
	return nil
}

// route applies quota-aware selection to permitted candidates. Accounts whose
// known windows are exhausted are only used when every candidate is
// exhausted, so purchased credits and extra usage remain a spillover.
func (s *selector) route(ctx context.Context, provider, model string, opts executor.Options, candidates []*core.Auth, route Routing, snaps map[string]Snapshot) (*core.Auth, error) {
	at := s.clock()
	quotas := make(map[string]accountQuota, len(candidates))
	ready := []*core.Auth{}
	for _, a := range candidates {
		quotas[a.ID] = quotaFor(provider, model, snaps[a.ID], a, at)
		if !quotas[a.ID].exhausted {
			ready = append(ready, a)
		}
	}
	if len(ready) == 0 {
		ready = candidates
	}
	ctx = context.WithValue(ctx, routePlanKey{}, routePlan{route, quotas, at})
	if !route.StickySessions || route.Strategy == "single_account" {
		return strategy{s}.Pick(ctx, provider, model, opts, ready)
	}
	return s.affinity(provider).Pick(ctx, provider, model, opts, ready)
}
func (s *selector) affinity(provider string) *core.SessionAffinitySelector {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sticky == nil {
		s.sticky = map[string]*core.SessionAffinitySelector{}
	}
	if s.sticky[provider] == nil {
		s.sticky[provider] = core.NewSessionAffinitySelector(strategy{s})
	}
	return s.sticky[provider]
}

// The manager reports results and removals to its selector; forward them so
// failed or removed accounts lose their session bindings.
func (s *selector) OnResult(result core.Result) {
	for _, a := range s.stickySelectors() {
		a.OnResult(result)
	}
}
func (s *selector) InvalidateAuth(id string) {
	for _, a := range s.stickySelectors() {
		a.InvalidateAuth(id)
	}
}
func (s *selector) stickySelectors() []*core.SessionAffinitySelector {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*core.SessionAffinitySelector, 0, len(s.sticky))
	for _, a := range s.sticky {
		out = append(out, a)
	}
	return out
}
