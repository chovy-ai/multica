// p2p-server is the device registry and relay for Multica daemon-to-daemon
// links. It runs apart from the Multica API server: callers exchange their
// Multica login token, checked against the API server's GET /api/me, for a
// session token; devices and sessions are stored in a local SQLite file. The
// same process runs a libp2p circuit relay for devices that cannot reach
// each other directly.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/p2p"
	"github.com/multica-ai/multica/server/internal/p2pserver"
)

// version is set at build time with -ldflags "-X main.version=<git sha>".
var version = "dev"

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
	publicIP := net.ParseIP(strings.TrimSpace(os.Getenv("MULTICA_P2P_PUBLIC_IP")))
	if publicIP == nil {
		return errors.New("MULTICA_P2P_PUBLIC_IP is required: the server's public IP, announced as the relay address")
	}
	addr := envOr("MULTICA_P2P_LISTEN", ":8090")
	dbPath := envOr("MULTICA_P2P_DB", "p2p.db")
	keyPath := envOr("MULTICA_P2P_KEY", "p2p-server.key")
	port, err := intEnv("MULTICA_P2P_LIBP2P_PORT", 4001)
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("MULTICA_P2P_LIBP2P_PORT: invalid port")
	}
	maxCircuits, err := intEnv("MULTICA_P2P_RELAY_MAX_CIRCUITS_PER_USER", p2pserver.DefaultMaxCircuitsPerUser)
	if err != nil || maxCircuits < 1 {
		return fmt.Errorf("MULTICA_P2P_RELAY_MAX_CIRCUITS_PER_USER: must be a positive integer")
	}

	store, err := p2pserver.OpenStore(dbPath)
	if err != nil {
		return err
	}
	defer store.Close()

	key, err := p2p.LoadOrCreateKey(keyPath)
	if err != nil {
		return fmt.Errorf("relay key: %w", err)
	}
	ipProto, unspec := "ip4", "0.0.0.0"
	if publicIP.To4() == nil {
		ipProto, unspec = "ip6", "::"
	}
	p := strconv.Itoa(port)
	relay, err := p2pserver.StartRelay(p2pserver.RelayConfig{
		Key: key,
		ListenAddrs: []string{
			"/" + ipProto + "/" + unspec + "/udp/" + p + "/quic-v1",
			"/" + ipProto + "/" + unspec + "/tcp/" + p,
		},
		AnnounceAddrs: []string{
			"/" + ipProto + "/" + publicIP.String() + "/udp/" + p + "/quic-v1",
			"/" + ipProto + "/" + publicIP.String() + "/tcp/" + p,
		},
		Store:              store,
		MaxCircuitsPerUser: maxCircuits,
		Logger:             logger,
	})
	if err != nil {
		return err
	}
	defer relay.Close()

	srv := &p2pserver.Server{
		Auth:   p2pserver.NewMeAuthenticator(apiURL, 5*time.Minute),
		Store:  store,
		Relay:  relay,
		Logger: logger,
	}
	tailnet, err := startTailnet(publicIP, logger)
	if err != nil {
		return err
	}
	if tailnet != nil {
		defer tailnet.DERP.Close()
		srv.Tailnet = tailnet
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go srv.RunPurge(ctx, time.Hour)
	go relay.RunSummary(ctx, 5*time.Minute)

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
	logger.Info("p2p-server listening", "addr", addr, "api_url", apiURL, "db", dbPath, "version", version)
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

func intEnv(key string, fallback int) (int, error) {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback, nil
	}
	return strconv.Atoi(v)
}

// startTailnet runs the tailnet relay when a control server is configured.
func startTailnet(publicIP net.IP, logger *slog.Logger) (*p2pserver.Tailnet, error) {
	headscaleURL := strings.TrimSpace(os.Getenv("MULTICA_P2P_HEADSCALE_URL"))
	if headscaleURL == "" {
		logger.Info("tailnet disabled: MULTICA_P2P_HEADSCALE_URL is unset")
		return nil, nil
	}
	// Headscale reads the DERP map from this process before its API key can
	// be created, so the relay starts without the key. Until it is set,
	// credentials and relay admission fail closed.
	apiKey := strings.TrimSpace(os.Getenv("MULTICA_P2P_HEADSCALE_API_KEY"))
	if apiKey == "" {
		logger.Warn("tailnet credentials unavailable: MULTICA_P2P_HEADSCALE_API_KEY is unset")
	}
	derpPort, err := intEnv("MULTICA_P2P_DERP_PORT", 8443)
	if err != nil || derpPort < 1 || derpPort > 65535 {
		return nil, fmt.Errorf("MULTICA_P2P_DERP_PORT: invalid port")
	}
	stunPort, err := intEnv("MULTICA_P2P_STUN_PORT", 3478)
	if err != nil || stunPort < 1 || stunPort > 65535 {
		return nil, fmt.Errorf("MULTICA_P2P_STUN_PORT: invalid port")
	}
	headscale := &p2pserver.Headscale{BaseURL: headscaleURL, APIKey: apiKey}
	tailnet := &p2pserver.Tailnet{
		Headscale:  headscale,
		ControlURL: envOr("MULTICA_P2P_TAILNET_CONTROL_URL", "http://"+net.JoinHostPort(publicIP.String(), "8091")),
	}
	derp, err := p2pserver.StartDERP(p2pserver.DERPConfig{
		PublicIP:   publicIP,
		Listen:     ":" + strconv.Itoa(derpPort),
		STUNListen: ":" + strconv.Itoa(stunPort),
		KeyPath:    envOr("MULTICA_P2P_DERP_KEY", "derp.key"),
		CertPath:   envOr("MULTICA_P2P_DERP_CERT", "derp.pem"),
		Admit:      tailnet.Admit,
		Logger:     logger,
	})
	if err != nil {
		return nil, err
	}
	tailnet.DERP = derp
	return tailnet, nil
}
