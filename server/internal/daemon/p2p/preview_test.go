package p2p

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/multica-ai/multica/server/internal/daemon/servicepreview"
	ma "github.com/multiformats/go-multiaddr"
)

func TestServicePreviewOverDirectAndRelayedStreams(t *testing.T) {
	for _, relayed := range []bool{false, true} {
		t.Run(fmt.Sprintf("relay=%v", relayed), func(t *testing.T) {
			keyA, idA := newKey(t)
			keyB, idB := newKey(t)
			account := &relayAccount{}
			var relay RelayFunc
			if relayed {
				server, _ := startRelay(t, idA, idB)
				relay = relayFunc(server)
				account.only = func(a string) bool { return strings.Contains(a, "/p2p-circuit") }
			}
			start := func(key crypto.PrivKey) *Service {
				value, err := Start(context.Background(), Config{Key: key, Fetch: account.fetch, ListenAddrs: []string{"/ip4/127.0.0.1/tcp/0"}, Relay: relay, RefreshInterval: time.Hour, Logger: testLogger})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { value.Close() })
				return value
			}
			a, b := start(keyA), start(keyB)
			account.mu.Lock()
			account.svcs = []*Service{a, b}
			account.mu.Unlock()
			if relayed {
				if !waitFor(t, 15*time.Second, func() bool {
					return a.Status().Relay != nil && a.Status().Relay.Reserved && b.Status().Relay != nil && b.Status().Relay.Reserved
				}) {
					t.Fatal("relay reservation unavailable")
				}
			}
			if err := a.Refresh(context.Background()); err != nil {
				t.Fatal(err)
			}
			if err := b.Refresh(context.Background()); err != nil {
				t.Fatal(err)
			}
			if !relayed {
				addresses := []ma.Multiaddr{}
				for _, addr := range b.Status().ListenAddrs {
					addresses = append(addresses, ma.StringCast(addr))
				}
				a.AddAddrs(peer.AddrInfo{ID: idB, Addrs: addresses})
			}
			payload := strings.Repeat("x", 6<<20)
			origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = fmt.Fprint(w, "REMOTE:"+r.Host+r.URL.Path+payload)
			}))
			defer origin.Close()
			_, rawPort, _ := net.SplitHostPort(origin.Listener.Addr().String())
			port, _ := strconv.Atoi(rawPort)
			manager := servicepreview.New(filepath.Join(t.TempDir(), "policy.json"), func() bool { return true }, func(context.Context, int64, string) error { return nil }, nil)
			defer manager.Revoke()
			if err := manager.SetPolicy(servicepreview.Policy{Enabled: true, Ports: []int{port}}); err != nil {
				t.Fatal(err)
			}
			listener, stop := b.Listen(servicepreview.Protocol)
			defer stop()
			go func() {
				for {
					conn, err := listener.Accept()
					if err != nil {
						return
					}
					id, _ := PeerOf(conn)
					go manager.ServeStream(id.String(), conn)
				}
			}()
			if !waitFor(t, 15*time.Second, func() bool { return a.Connection(idB) != "" }) {
				t.Fatal("device connection unavailable")
			}
			if relayed && a.Connection(idB) != ConnectionRelayed {
				t.Fatal("test did not force a relay")
			}
			lease, err := manager.Create(context.Background(), idA.String(), 1, servicepreview.Create{Version: 1, RequestID: "r", ConversationID: "conversation", Target: servicepreview.Target{Host: "localhost", Port: port}})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			conn, err := servicepreview.Dial(ctx, func(ctx context.Context) (net.Conn, error) { return a.Dial(ctx, idB, servicepreview.Protocol) }, servicepreview.Hello{Version: 1, ServiceID: lease.ID, ConnectionID: "c", Capability: lease.Capability})
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
			_, _ = fmt.Fprint(conn, "GET /login HTTP/1.1\r\nHost: localhost:3000\r\nConnection: close\r\n\r\n")
			reply, err := http.ReadResponse(bufio.NewReader(conn), nil)
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(reply.Body)
			reply.Body.Close()
			if err != nil || string(data) != "REMOTE:localhost:3000/login"+payload {
				t.Fatalf("wrong remote response: %d bytes, error %v", len(data), err)
			}
		})
	}
}
