//go:build tailnetintegration

package daemon

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"

	"github.com/multica-ai/multica/server/internal/daemon/p2p"
)

// TestTailnetThroughARealControlServer runs two devices against a running
// p2p-server with Headscale and DERP configured:
//
//	MULTICA_TAILNET_E2E_REGISTRY=http://127.0.0.1:18090 MULTICA_TAILNET_E2E_TOKEN=<login> \
//	  go test -tags=tailnetintegration ./internal/daemon -run TestTailnetThroughARealControlServer -v
//
// The devices register no libp2p addresses and use no relay, so a stream
// between them can only travel over the tailnet.
func TestTailnetThroughARealControlServer(t *testing.T) {
	registryURL, token := os.Getenv("MULTICA_TAILNET_E2E_REGISTRY"), os.Getenv("MULTICA_TAILNET_E2E_TOKEN")
	if registryURL == "" || token == "" {
		t.Skip("set MULTICA_TAILNET_E2E_REGISTRY and MULTICA_TAILNET_E2E_TOKEN")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	start := func(name, token string) *p2p.Service {
		key, pub, err := crypto.GenerateEd25519Key(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		self, _ := peer.IDFromPublicKey(pub)
		raw, _ := crypto.MarshalPublicKey(pub)
		registry := newP2PRegistryClient(registryURL, func() string { return token })
		if err := registry.register(ctx, "e2e-"+self.String(), "", base64.StdEncoding.EncodeToString(raw), name, nil); err != nil {
			t.Fatalf("register %s: %v", name, err)
		}
		t.Cleanup(func() { registry.remove(context.Background(), "e2e-"+self.String(), "") })
		svc, err := p2p.Start(ctx, p2p.Config{
			Key:             key,
			Fetch:           func(ctx context.Context) ([]p2p.Peer, error) { return fetchP2PPeers(ctx, registry) },
			ListenAddrs:     []string{"/ip4/127.0.0.1/tcp/0"},
			RefreshInterval: 5 * time.Second,
			Tailnet: func(ctx context.Context) (p2p.TailnetCredentials, error) {
				return registry.tailnet(ctx, self.String())
			},
			TailnetDir: filepath.Join(t.TempDir(), "tailnet"),
			Logger:     slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug})).With("device", name),
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { svc.Close() })
		return svc
	}
	a, b := start("e2e-a", token), start("e2e-b", token)
	a.Refresh(ctx)
	b.Refresh(ctx)
	var other *p2p.Service
	if otherToken := os.Getenv("MULTICA_TAILNET_E2E_OTHER_TOKEN"); otherToken != "" {
		other = start("e2e-other", otherToken)
	}

	const echo = "/multica/test-echo/1"
	ln, stop := b.Listen(echo)
	defer stop()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { io.Copy(conn, conn); conn.Close() }()
		}
	}()

	began := time.Now()
	for a.Connection(b.ID()) == "" {
		if ctx.Err() != nil {
			t.Fatal("b never became reachable over the tailnet")
		}
		a.Refresh(ctx)
		time.Sleep(500 * time.Millisecond)
	}
	t.Logf("reachable after %s, path %s", time.Since(began).Round(time.Millisecond), a.Connection(b.ID()))

	conn, err := a.Dial(ctx, b.ID(), echo)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	msg := []byte("hello over the tailnet")
	conn.Write(msg)
	got := make([]byte, len(msg))
	if _, err := io.ReadFull(conn, got); err != nil || string(got) != string(msg) {
		t.Fatalf("echo = %q, %v", got, err)
	}
	for i := 0; i < 20 && a.Connection(b.ID()) != p2p.ConnectionDirect; i++ {
		time.Sleep(500 * time.Millisecond)
	}
	t.Logf("path after traffic: %s (stream %s)", a.Connection(b.ID()), p2p.StreamConnection(conn))

	// Another account's node is not even a tailnet peer.
	if other != nil {
		if got := a.Connection(other.ID()); got != "" {
			t.Fatalf("another account's device is reachable: %s", got)
		}
		if got := other.Connection(a.ID()); got != "" {
			t.Fatalf("this account's device is reachable from another account: %s", got)
		}
	}
}
