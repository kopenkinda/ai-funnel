package funnel

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
	sdkapi "github.com/router-for-me/CLIProxyAPI/v8/sdk/api"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers/claude"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers/openai"
	sdkauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	"golang.org/x/crypto/bcrypt"
)

type privateRequest struct{}
type scopeKey struct{}
type scope struct {
	provider string
	ids      []string
}
type selector struct{ rr core.RoundRobinSelector }

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
	return s.rr.Pick(ctx, allowed.provider, model, opts, candidates)
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
	store      *Store
	core       *core.Manager
	engine     *gin.Engine
	management string
	publicURL  string
	dist       string
	responses  *openai.OpenAIResponsesAPIHandler
	claude     *claude.ClaudeCodeAPIHandler
	base       *handlers.BaseAPIHandler
	failures   map[string][]int64
	gate       chan struct{}
}

func NewRuntime(store *Store, host string, port int, publicURL, dist string) (*App, *cliproxy.Service, error) {
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
	sdkauth.RegisterTokenStore(store)
	manager := core.NewManager(store, &selector{}, nil)
	a := &App{store: store, core: manager, management: management, publicURL: strings.TrimRight(publicURL, "/"), dist: dist, failures: map[string][]int64{}, gate: make(chan struct{}, 1)}
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
		sdkapi.WithMiddleware(a.middleware),
		sdkapi.WithEngineConfigurator(func(g *gin.Engine) { _ = g.SetTrustedProxies(nil); a.engine = g }),
		sdkapi.WithRouterConfigurator(func(_ *gin.Engine, b *handlers.BaseAPIHandler, _ *config.Config) {
			a.base = b
			a.responses = openai.NewOpenAIResponsesAPIHandler(b)
			a.claude = claude.NewClaudeCodeAPIHandler(b)
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
	http.ServeFile(c.Writer, c.Request, p)
}
