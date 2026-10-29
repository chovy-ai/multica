package daemon

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"

	"github.com/multica-ai/multica/server/internal/p2pserver"
)

func TestFetchP2PPeersDerivesIDsAndDropsMalformedKeys(t *testing.T) {
	_, pub, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := crypto.MarshalPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	want, err := peer.IDFromPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/sessions" && r.Header.Get("Authorization") == "Bearer tok" {
			json.NewEncoder(w).Encode(map[string]any{"session_token": "sess", "expires_at": time.Now().Add(time.Hour)})
			return
		}
		if r.URL.Path != "/v1/devices" || r.Header.Get("Authorization") != "Bearer sess" {
			http.NotFound(w, r)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"devices": []p2pDevice{
			{DaemonID: "good", Profile: "work", PublicKey: base64.StdEncoding.EncodeToString(raw), DeviceName: "laptop"},
			{DaemonID: "not-a-key", PublicKey: base64.StdEncoding.EncodeToString([]byte("short"))},
			{DaemonID: "not-base64", PublicKey: "%%%"},
		}})
	}))
	defer srv.Close()

	registry := newP2PRegistryClient(srv.URL, func() string { return "tok" })
	peers, err := fetchP2PPeers(context.Background(), registry)
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 1 || peers[0].ID != want || peers[0].Profile != "work" || peers[0].DeviceName != "laptop" {
		t.Fatalf("peers = %+v, want only the well-formed key as %s", peers, want)
	}
}

func TestP2PRegistryClientUsesSessionAndRenewsOn401(t *testing.T) {
	var sessions, loginTokenOnDevices int
	issued := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		switch r.URL.Path {
		case "/v1/sessions":
			if auth != "Bearer mul_login" {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			sessions++
			issued = "sess-" + strconv.Itoa(sessions)
			json.NewEncoder(w).Encode(map[string]any{"session_token": issued, "expires_at": time.Now().Add(24 * time.Hour)})
		case "/v1/devices":
			if auth == "Bearer mul_login" {
				loginTokenOnDevices++
			}
			if auth != "Bearer "+issued {
				http.Error(w, "expired", http.StatusUnauthorized)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"devices": []p2pDevice{}})
		}
	}))
	defer srv.Close()
	c := newP2PRegistryClient(srv.URL, func() string { return "mul_login" })
	ctx := context.Background()
	for range 3 {
		if _, err := c.list(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if sessions != 1 {
		t.Fatalf("issued %d sessions for 3 calls, want 1", sessions)
	}
	// The registry forgets the session: the client renews once and retries.
	issued = "rotated-server-side"
	if _, err := c.list(ctx); err != nil {
		t.Fatalf("after server-side expiry: %v", err)
	}
	if sessions != 2 || loginTokenOnDevices != 0 {
		t.Fatalf("sessions=%d loginTokenOnDevices=%d", sessions, loginTokenOnDevices)
	}
	// A session close to expiry is renewed before use.
	c.now = func() time.Time { return time.Now().Add(24*time.Hour - p2pSessionRenewMargin/2) }
	c.list(ctx)
	if sessions != 3 {
		t.Fatalf("near-expiry session not renewed: sessions=%d", sessions)
	}
}

func TestP2PStatusHandlerReportsDisabled(t *testing.T) {
	d := &Daemon{logger: slog.Default()}
	rec := httptest.NewRecorder()
	d.p2pStatusHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/p2p/status", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	var raw map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if raw["enabled"] != false || len(raw) != 1 {
		t.Fatalf("disabled status = %v, want only enabled:false", raw)
	}
}

func TestStartP2PRegistersAndConnectsSameAccountDaemons(t *testing.T) {
	if testing.Short() {
		t.Skip("uses multicast")
	}
	t.Setenv("HOME", t.TempDir())
	// The Multica API server only answers GET /api/me; the registry is the
	// real p2p-server handler.
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/me" || r.Header.Get("Authorization") != "Bearer mul_test" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"id": "user-1"})
	}))
	defer api.Close()
	store, err := p2pserver.OpenStore(filepath.Join(t.TempDir(), "p2p.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	srv := httptest.NewServer((&p2pserver.Server{Auth: p2pserver.NewMeAuthenticator(api.URL, time.Minute), Store: store}).Handler())
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	newDaemon := func(profile string) *Daemon {
		client := NewClient("http://api.invalid")
		client.SetToken("mul_test")
		d := &Daemon{
			cfg:    Config{DaemonID: "machine-1", Profile: profile, DeviceName: "dev-" + profile, P2PServerURL: srv.URL},
			client: client,
			logger: slog.Default(),
		}
		if err := d.startP2P(ctx); err != nil {
			t.Fatal(err)
		}
		return d
	}
	a := newDaemon("p2p-a")
	b := newDaemon("p2p-b")
	if a.P2P().ID() == b.P2P().ID() {
		t.Fatal("profiles share a p2p identity")
	}

	deadline := time.Now().Add(20 * time.Second)
	for {
		connected := false
		for _, p := range a.P2P().Peers() {
			if p.ID == b.P2P().ID() && p.Connected && p.DeviceName == "dev-p2p-b" && p.Profile == "p2p-b" {
				connected = true
			}
		}
		if connected {
			break
		}
		if time.Now().After(deadline) {
			t.Skipf("daemons did not connect over mDNS; status=%+v", a.P2P().Status())
		}
		time.Sleep(100 * time.Millisecond)
	}
	pingCtx, pingCancel := context.WithTimeout(ctx, 10*time.Second)
	defer pingCancel()
	if _, err := a.P2P().Ping(pingCtx, b.P2P().ID()); err != nil {
		t.Fatalf("ping: %v", err)
	}

	cancel()
	if !waitUntil(5*time.Second, func() bool { return a.P2P() == nil && b.P2P() == nil }) {
		t.Fatal("p2p service not cleared after daemon context ended")
	}
}

func waitUntil(timeout time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return cond()
}
