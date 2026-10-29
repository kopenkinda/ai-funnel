package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"ai-funnel/internal/funnel"
	"github.com/joho/godotenv"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
func main() {
	if e := godotenv.Load(); e != nil && !os.IsNotExist(e) {
		log.Fatal(e)
	}
	dir, e := filepath.Abs(env("DATA_DIR", "data/embedded"))
	if e != nil {
		log.Fatal(e)
	}
	if e = os.MkdirAll(dir, 0700); e != nil {
		log.Fatal(e)
	}
	lock, e := os.OpenFile(filepath.Join(dir, "service.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		log.Fatal(e)
	}
	defer lock.Close()
	if e = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		log.Fatal("Another service is using this data directory")
	}
	store, e := funnel.NewStore(dir, os.Getenv("ADMIN_TOKEN"))
	if e != nil {
		log.Fatal(e)
	}
	port, e := strconv.Atoi(env("PORT", "4310"))
	if e != nil || port < 1 || port > 65535 {
		log.Fatal("Invalid PORT")
	}
	app, service, e := funnel.NewRuntime(store, env("HOST", "127.0.0.1"), port, os.Getenv("PUBLIC_URL"), env("DIST_DIR", "dist"))
	if e != nil {
		log.Fatal(e)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		ticker := time.NewTicker(2 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				app.RefreshAll(ctx)
			}
		}
	}()
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				app.CheckExpiringResets(ctx)
			}
		}
	}()
	log.Printf("ai-funnel: embedded CLIProxyAPI, port %d; dashboard key file: %s", port, filepath.Join(dir, "admin-token"))
	if e = service.Run(ctx); e != nil && !errors.Is(e, context.Canceled) {
		log.Fatal(e)
	}
}
