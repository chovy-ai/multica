// p2p-server is the device registry for Multica daemon-to-daemon links. It
// runs apart from the Multica API server: callers authenticate with their
// Multica login token, which is checked against the API server's GET /api/me,
// and devices are stored in a local SQLite file.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/multica-ai/multica/server/internal/p2pserver"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(logger); err != nil {
		logger.Error("p2p-server exited", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	apiURL := strings.TrimSpace(os.Getenv("MULTICA_API_URL"))
	if apiURL == "" {
		return errors.New("MULTICA_API_URL is required (e.g. https://api.multica.ai)")
	}
	addr := envOr("MULTICA_P2P_LISTEN", ":8090")
	dbPath := envOr("MULTICA_P2P_DB", "p2p.db")

	store, err := p2pserver.OpenStore(dbPath)
	if err != nil {
		return err
	}
	defer store.Close()

	srv := &p2pserver.Server{
		Auth:   p2pserver.NewMeAuthenticator(apiURL, 5*time.Minute),
		Store:  store,
		Logger: logger,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go srv.RunPurge(ctx, time.Hour)

	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		httpSrv.Shutdown(shutdownCtx)
	}()
	logger.Info("p2p-server listening", "addr", addr, "api_url", apiURL, "db", dbPath)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
