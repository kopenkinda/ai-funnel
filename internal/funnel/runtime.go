package funnel

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	sdkaccess "github.com/router-for-me/CLIProxyAPI/v8/sdk/access"
	sdkapi "github.com/router-for-me/CLIProxyAPI/v8/sdk/api"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers/claude"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers/openai"
	sdkauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	sdkusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	"golang.org/x/crypto/bcrypt"
)

type privateRequest struct{}
type scopeKey struct{}
type scope struct {
	provider         string
	ids              []string
	subscriptionOnly bool
	selected         *atomic.Pointer[core.Auth]
}
type selector struct {
	rr                    core.RoundRobinSelector
	subscriptionAvailable func(context.Context, *core.Auth) bool
	// inputs reads current routing settings and quota snapshots, so setting
	// changes apply to the next selection without replacing the SDK selector.
	inputs func(provider string, ids []string) (Routing, map[string]Snapshot)
	now    func() time.Time
	random func() float64
	mu     sync.Mutex
	last   map[string]time.Time
	sticky map[string]*core.SessionAffinitySelector
}

func (s *selector) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return now()
}

func (s *selector) Pick(ctx context.Context, provider, model string, opts executor.Options, auths []*core.Auth) (*core.Auth, error) {
	// SDK handlers retain the Gin request even when they create an execution context.
	if g, ok := ctx.Value("gin").(*gin.Context); ok {
		ctx = g.Request.Context()
	}
	allowed, ok := ctx.Value(scopeKey{}).(scope)
	if !ok || (provider != "mixed" && provider != allowed.provider) {
		return nil, fmt.Errorf("provider access denied")
	}
	candidates := make([]*core.Auth, 0, len(auths))
	for _, a := range auths {
		if a.Provider == allowed.provider && (allowed.ids == nil || contains(allowed.ids, a.ID)) {
			candidates = append(candidates, a)
		}
	}
	route, snaps := defaultRouting(), map[string]Snapshot{}
	if s.inputs != nil {
		ids := make([]string, len(candidates))
		for i, a := range candidates {
			ids[i] = a.ID
		}
		route, snaps = s.inputs(allowed.provider, ids)
	}
	// Single-account routing never falls back to another account.
	if route.Strategy == "single_account" {
		pinned := candidates[:0]
		for _, a := range candidates {
			if a.ID == route.AccountID {
				pinned = append(pinned, a)
			}
		}
		if candidates = pinned; len(candidates) == 0 {
			return nil, &core.Error{Code: "routing_account_unavailable", Message: "The single routing account is unavailable or not assigned to this key.", HTTPStatus: 503}
		}
	}
	if !allowed.subscriptionOnly {
		return s.route(ctx, allowed.provider, model, opts, candidates, route, snaps)
	}
	for len(candidates) > 0 {
		selected, err := s.route(ctx, allowed.provider, model, opts, candidates, route, snaps)
		if err != nil {
			return nil, err
		}
		if allowed.provider == "codex" && s.subscriptionAvailable != nil && s.subscriptionAvailable(ctx, selected) {
			if allowed.selected != nil {
				allowed.selected.Store(selected.Clone())
			}
			return selected, nil
		}
		for i, candidate := range candidates {
			if candidate.ID == selected.ID {
				candidates = append(candidates[:i], candidates[i+1:]...)
				break
			}
		}
	}
	return nil, &core.Error{Code: "subscription_limit_reached", Message: "No allowed Codex account has verified subscription allowance remaining.", HTTPStatus: 429}
}
func contains(items []string, v string) bool {
	for _, item := range items {
		if item == v {
			return true
		}
	}
	return false
}

type App struct {
	usageOwner string
	resetMu    sync.Mutex
	store      *Store
	core       *core.Manager
	engine     *gin.Engine
	management string
	publicURL  string
	origins    []string
	dist       string
	responses  *openai.OpenAIResponsesAPIHandler
	claude     *claude.ClaudeCodeAPIHandler
	base       *handlers.BaseAPIHandler
	failures   map[string][]int64
	gate       chan struct{}
}

func NewRuntime(store *Store, host string, port int, publicURL, dist string, additionalOrigins ...string) (*App, *cliproxy.Service, error) {
	gin.SetMode(gin.ReleaseMode)
	cfg, e := config.ParseConfigBytes([]byte("host: 127.0.0.1\nport: 4310\nrequest-log: false\nlogging-to-file: false\nremote-management:\n  disable-control-panel: true\n"))
	if e != nil {
		return nil, nil, e
	}
	cfg.Host = host
	cfg.Port = port
	cfg.AuthDir = filepath.Join(store.dir, "oauth-sessions")
	cfg.APIKeys = []string{token()}
	management := token()
	hashed, err := bcrypt.GenerateFromPassword([]byte(management), bcrypt.DefaultCost)
	if err != nil {
		return nil, nil, err
	}
	cfg.RemoteManagement.SecretKey = string(hashed)
	cfg.RemoteManagement.AllowRemote = true
	cfg.RequestLog = false
	cfg.Codex.UpstreamRequestCompression = true
	sdkauth.RegisterTokenStore(store)
	selection := &selector{inputs: store.routingInputs}
	manager := core.NewManager(store, selection, nil)
	a := &App{usageOwner: token(), store: store, core: manager, management: management, publicURL: strings.TrimRight(publicURL, "/"), dist: dist, failures: map[string][]int64{}, gate: make(chan struct{}, 1)}
	selection.subscriptionAvailable = a.codexSubscriptionAvailable
	a.origins = append([]string{a.publicURL}, additionalOrigins...)
	sdkusage.RegisterNamedPlugin("ai-funnel:"+store.dir, a)
	// OAuth callback files stay separate from the encrypted account store.
	if e = os.MkdirAll(cfg.AuthDir, 0700); e != nil {
		return nil, nil, e
	}
	cfgPath := filepath.Join(cfg.AuthDir, "runtime.yaml")
	// Do not persist runtime API or management keys in configuration.
	if e = os.WriteFile(cfgPath, []byte("host: 127.0.0.1\nport: 4310\n"), 0600); e != nil {
		return nil, nil, e
	}
	svc, e := cliproxy.NewBuilder().WithConfig(cfg).WithConfigPath(cfgPath).WithCoreAuthManager(manager).WithWatcherFactory(func(string, string, func(*config.Config)) (*cliproxy.WatcherWrapper, error) {
		return &cliproxy.WatcherWrapper{}, nil
	}).WithServerOptions(
		// SDK-owned routes stay private. Our routes run after its negotiated
		// response compression rather than aborting that middleware early.
		sdkapi.WithMiddleware(func(c *gin.Context) {
			if c.FullPath() != "" {
				a.middleware(c)
			}
		}),
		sdkapi.WithEngineConfigurator(func(g *gin.Engine) { _ = g.SetTrustedProxies(nil); a.engine = g }),
		sdkapi.WithRouterConfigurator(func(_ *gin.Engine, b *handlers.BaseAPIHandler, _ *config.Config) {
			a.base = b
			a.responses = openai.NewOpenAIResponsesAPIHandler(b)
			a.responses.AccessManager = sdkaccess.NewManager()
			a.responses.AccessManager.SetProviders([]sdkaccess.Provider{&websocketAccess{app: a}})
			a.claude = claude.NewClaudeCodeAPIHandler(b)
			a.engine.Use(a.middleware)
		}),
	).Build()
	return a, svc, e
}
func (a *App) managementCall(ctx context.Context, method, path string, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1/v8/management"+path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:1"
	r = r.WithContext(context.WithValue(ctx, privateRequest{}, true))
	r.Header.Set("Authorization", "Bearer "+a.management)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	a.engine.ServeHTTP(w, r)
	return w
}
func (a *App) middleware(c *gin.Context) {
	if c.Request.Context().Value(privateRequest{}) == true {
		return
	}
	c.Abort()
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Referrer-Policy", "same-origin")
	c.Header("Cache-Control", "no-store")
	path := c.Request.URL.Path
	if strings.Contains(path, "\\") || strings.Contains(path, "//") || strings.Contains(path, "/../") {
		fail(c, 400, "Invalid path.")
		return
	}
	if path == "/healthz" && c.Request.Method == "GET" {
		c.JSON(200, gin.H{"status": "ok", "backend": "embedded-cliproxyapi"})
		return
	}
	if (path == "/codex/callback" || path == "/anthropic/callback") && c.Request.Method == "GET" {
		q := c.Request.URL.Query()
		if len(c.Request.URL.RawQuery) > 8192 || q.Get("state") == "" {
			fail(c, 400, "Invalid sign-in callback.")
			return
		}
		provider := "codex"
		if path == "/anthropic/callback" {
			provider = "claude"
		}
		q.Set("provider", provider)
		w := a.managementCall(c.Request.Context(), "GET", "/oauth/callback?"+q.Encode(), "")
		if w.Code >= 400 {
			fail(c, 400, "Sign-in callback was rejected. Start sign-in again.")
			return
		}
		c.Data(200, "text/html; charset=utf-8", []byte("<!doctype html><title>Sign-in received</title><p>Sign-in received. Return to your dashboard.</p>"))
		return
	}
	if strings.HasPrefix(path, "/v0/management/") {
		a.hub(c)
		return
	}
	if strings.HasPrefix(path, "/api/") {
		a.dashboard(c)
		return
	}
	if strings.HasPrefix(path, "/providers/") && strings.Count(path, "/") >= 3 {
		a.provider(c)
		return
	}
	if strings.HasPrefix(path, "/v1/") || strings.HasPrefix(path, "/v8/") || strings.HasPrefix(path, "/v0/") || strings.HasSuffix(path, "/callback") || path == "/management.html" {
		fail(c, 404, "Route not found.")
		return
	}
	if c.Request.Method != "GET" && c.Request.Method != "HEAD" {
		fail(c, 405, "Method not allowed.")
		return
	}
	p := filepath.Join(a.dist, filepath.Clean("/"+path))
	if info, e := os.Stat(p); e != nil || info.IsDir() {
		p = filepath.Join(a.dist, "index.html")
	}
	c.Header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
	c.Status(http.StatusOK)
	http.ServeFile(c.Writer, c.Request, p)
}
