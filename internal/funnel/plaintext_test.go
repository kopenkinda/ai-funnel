package funnel

import (
	"bytes"
	"context"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	core "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type tokenEndpoint struct{}

func (tokenEndpoint) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Host != "auth.openai.com" {
		return nil, io.EOF
	}
	body := `{"access_token":"rotated-access","refresh_token":"rotated-refresh-secret","id_token":"","token_type":"Bearer","expires_in":3600}`
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
}

// SDK upgrades have added their own on-disk stores. Rotated credentials must
// still only reach disk through the encrypted state.
func TestRefreshKeepsCredentialsEncrypted(t *testing.T) {
	original := http.DefaultTransport
	http.DefaultTransport = tokenEndpoint{}
	defer func() { http.DefaultTransport = original }()

	dir := t.TempDir()
	store, e := NewStore(dir, "plaintext-test-dashboard-key")
	if e != nil {
		t.Fatal(e)
	}
	_, e = store.Save(context.Background(), &core.Auth{ID: "codex-a", Provider: "codex", Status: core.StatusActive, Metadata: map[string]any{"type": "codex", "email": "a@example.com", "access_token": "old-access", "refresh_token": "old-refresh", "plan_type": "plus"}, LastRefreshedAt: now(), NextRefreshAfter: now().Add(24 * time.Hour)})
	if e != nil {
		t.Fatal(e)
	}
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	app, svc, e := NewRuntime(store, "127.0.0.1", port, "", t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- svc.Run(ctx) }()
	defer func() { cancel(); <-done }()
	time.Sleep(500 * time.Millisecond)

	refreshed, e := app.core.ForceRefreshAuth(ctx, "codex-a")
	if e != nil {
		t.Fatal(e)
	}
	if got, _ := refreshed.Metadata["refresh_token"].(string); got != "rotated-refresh-secret" {
		t.Fatalf("refresh did not rotate the token: %q", got)
	}
	e = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if d.Name() == "kv.db" {
			t.Errorf("SDK kv store written at %s", path)
		}
		b, err := os.ReadFile(path)
		if err == nil && bytes.Contains(b, []byte("rotated-refresh-secret")) {
			t.Errorf("plaintext refresh token in %s", path)
		}
		return err
	})
	if e != nil {
		t.Fatal(e)
	}
}
