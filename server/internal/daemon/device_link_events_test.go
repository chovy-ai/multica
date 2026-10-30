package daemon

import (
	"bufio"
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/multica-ai/multica/server/internal/daemon/localhost"
	"github.com/multica-ai/multica/server/internal/daemon/p2p"
	ma "github.com/multiformats/go-multiaddr"
)

func TestDeviceLinkEventsWakeDesktopWhenPeerConnects(t *testing.T) {
	keyA, idA := newLinkKey(t)
	keyB, idB := newLinkKey(t)
	acct := &linkAccount{peers: []p2p.Peer{{ID: idA}, {ID: idB}}}
	viewer, host := newLinkDevice(t, acct, keyA, "viewer"), newLinkDevice(t, acct, keyB, "host")
	path := "/local/devices/" + idB.String() + "/local/v2/link-events"
	if code, _ := viewer.do(t, "invalid", http.MethodGet, path, nil); code != http.StatusForbidden {
		t.Fatal(code)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, viewer.srv.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+localhost.RendererToken(viewer.token))
	req.Header.Set("X-Multica-User-ID", "user-1")
	req.Header.Set("X-Workspace-ID", "ws-1")
	req.Header.Set("X-Multica-API-Origin", "https://api.multica.ai")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatal(res.StatusCode)
	}
	events := make(chan string, 8)
	go func() {
		scanner := bufio.NewScanner(res.Body)
		for scanner.Scan() {
			if strings.HasPrefix(scanner.Text(), "event: ") {
				events <- scanner.Text()
			}
		}
	}()
	want := func(expected string) {
		t.Helper()
		select {
		case got := <-events:
			if got != expected {
				t.Fatalf("event=%q want=%q", got, expected)
			}
		case <-time.After(time.Second):
			t.Fatal("no local connection event")
		}
	}
	want("event: link.disconnected")
	var addrs []ma.Multiaddr
	for _, addr := range host.p2p.Status().ListenAddrs {
		a, err := ma.NewMultiaddr(addr)
		if err == nil {
			addrs = append(addrs, a)
		}
	}
	viewer.p2p.AddAddrs(peer.AddrInfo{ID: idB, Addrs: addrs})
	want("event: link.connected")
}
