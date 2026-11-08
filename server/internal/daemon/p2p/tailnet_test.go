package p2p

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/protocol"
	"tailscale.com/ipn/store/mem"
	"tailscale.com/net/netns"
	"tailscale.com/tstest/integration"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/tsnet"
	"tailscale.com/types/logger"

	"github.com/multica-ai/multica/server/internal/localconversation/timing"
)

// startTailnetControl runs an in-process control server with its own DERP and
// STUN on loopback.
func startTailnetControl(t *testing.T) string {
	t.Helper()
	// Binding sockets to the default route's interface cannot reach loopback.
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })
	control := &testcontrol.Server{
		DERPMap:   integration.RunDERPAndSTUN(t, logger.Discard, "127.0.0.1"),
		AllOnline: true,
		Logf:      logger.Discard,
	}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	t.Cleanup(control.HTTPTestServer.Close)
	return control.HTTPTestServer.URL
}

func startTailnetDevice(t *testing.T, key crypto.PrivKey, acct *testAccount, controlURL string) *Service {
	t.Helper()
	svc, err := Start(context.Background(), Config{
		Key:             key,
		Fetch:           acct.fetch,
		ListenAddrs:     []string{"/ip4/127.0.0.1/tcp/0"},
		RefreshInterval: time.Hour,
		Tailnet: func(context.Context) (TailnetCredentials, error) {
			return TailnetCredentials{ControlURL: controlURL}, nil
		},
		TailnetDir: filepath.Join(t.TempDir(), "tailnet"),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { svc.Close() })
	if err := svc.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	return svc
}

func tailnetPair(t *testing.T) (a, b *Service) {
	t.Helper()
	controlURL := startTailnetControl(t)
	keyA, idA := newKey(t)
	keyB, idB := newKey(t)
	acct := &testAccount{}
	acct.set(Peer{ID: idA, DeviceName: "a"}, Peer{ID: idB, DeviceName: "b"})
	a = startTailnetDevice(t, keyA, acct, controlURL)
	b = startTailnetDevice(t, keyB, acct, controlURL)
	if !waitFor(t, 60*time.Second, func() bool {
		return a.tailnet.connection(idB) != "" && b.tailnet.connection(idA) != ""
	}) {
		t.Fatal("devices never saw each other in the tailnet")
	}
	return a, b
}

func TestDialUsesTheTailnetAndKnowsWhoDialed(t *testing.T) {
	a, b := tailnetPair(t)
	const echo = "/multica/test-echo/1"
	ln, stop := b.Listen(echo)
	defer stop()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		accepted <- conn
		io.Copy(conn, conn)
		conn.Close()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	conn, err := a.Dial(ctx, b.ID(), echo)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, ok := conn.(*tailnetConn); !ok {
		t.Fatalf("dialed %T, want a tailnet stream", conn)
	}
	if id, ok := PeerOf(conn); !ok || id != b.ID() {
		t.Fatalf("PeerOf = %s %v", id, ok)
	}
	if Relayed(conn) {
		t.Fatal("a tailnet stream must never be moved off as relayed")
	}
	payload := bytes.Repeat([]byte("multica "), 16<<10)
	go conn.Write(payload)
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(conn, got); err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("echo: %v", err)
	}
	select {
	case server := <-accepted:
		if id, ok := PeerOf(server); !ok || id != a.ID() {
			t.Fatalf("accepted from %s %v, want %s", id, ok, a.ID())
		}
		if c := StreamConnection(server); c != timing.ConnectionDirect && c != timing.ConnectionRelayed {
			t.Fatalf("stream connection = %q", c)
		}
	case <-ctx.Done():
		t.Fatal("never accepted")
	}
	if got := a.Connection(b.ID()); got == "" {
		t.Fatal("connection is empty while the tailnet reaches the device")
	}
}

func TestDialFallsBackToLibp2pWhenTheTailnetLacksTheProtocol(t *testing.T) {
	a, b := tailnetPair(t)
	introduce(a, b)
	const echo = "/multica/test-libp2p-only/1"
	// Handle serves libp2p alone; only Listen adds the tailnet route.
	b.Handle(echo, func(s network.Stream) { io.Copy(s, s); s.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	conn, err := a.Dial(ctx, b.ID(), echo)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, ok := conn.(streamConn); !ok {
		t.Fatalf("dialed %T, want the libp2p stream", conn)
	}
}

func TestTailnetRefusesNodesOutsideTheAccount(t *testing.T) {
	controlURL := startTailnetControl(t)
	keyB, idB := newKey(t)
	acct := &testAccount{}
	acct.set(Peer{ID: idB})
	b := startTailnetDevice(t, keyB, acct, controlURL)
	ln, stop := b.Listen("/multica/test-echo/1")
	defer stop()
	go func() {
		if conn, err := ln.Accept(); err == nil {
			t.Error("accepted a stream from a node outside the account")
			conn.Close()
		}
	}()

	stranger := &tsnet.Server{Dir: t.TempDir(), Hostname: "stranger", ControlURL: controlURL, Store: new(mem.Store), Ephemeral: true}
	defer stranger.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if _, err := stranger.Up(ctx); err != nil {
		t.Fatal(err)
	}
	var addr string
	waitFor(t, 30*time.Second, func() bool {
		b.tailnet.mu.Lock()
		defer b.tailnet.mu.Unlock()
		if b.tailnet.srv == nil {
			return false
		}
		ips, _ := b.tailnet.srv.TailscaleIPs()
		if ips.IsValid() {
			addr = net.JoinHostPort(ips.String(), "4100")
		}
		return addr != ""
	})
	conn, err := stranger.Dial(ctx, "tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := writeTailnetHeader(conn, "/multica/test-echo/1"); err != nil {
		t.Fatal(err)
	}
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	// Closing an unaccepted stream reaches the dialer as EOF or a reset.
	n, err := conn.Read(make([]byte, 1))
	var netErr net.Error
	if n != 0 || err == nil || (errors.As(err, &netErr) && netErr.Timeout()) {
		t.Fatalf("stranger read %d bytes, %v; want the stream closed unanswered", n, err)
	}
}

func TestTailnetHeaderRejectsMalformedStreams(t *testing.T) {
	var buf bytes.Buffer
	if err := writeTailnetHeader(&buf, "/multica/device-link/1"); err != nil {
		t.Fatal(err)
	}
	if proto, err := readTailnetHeader(bufio.NewReader(bytes.NewReader(buf.Bytes()))); err != nil || proto != "/multica/device-link/1" {
		t.Fatalf("round trip = %q, %v", proto, err)
	}
	if err := writeTailnetHeader(io.Discard, ""); err == nil {
		t.Fatal("empty protocol accepted")
	}
	if err := writeTailnetHeader(io.Discard, protocol.ID(strings.Repeat("x", maxTailnetProtocolLen+1))); err == nil {
		t.Fatal("oversized protocol accepted")
	}
	for name, raw := range map[string][]byte{
		"wrong magic":     append([]byte("HTTP"), buf.Bytes()[4:]...),
		"data too early":  append(append([]byte{}, buf.Bytes()...), "GET /"...),
		"truncated":       buf.Bytes()[:len(buf.Bytes())-2],
		"zero length":     append(append([]byte{}, tailnetMagic[:]...), 0),
		"oversize length": append(append([]byte{}, tailnetMagic[:]...), 0xff, 0x7f),
	} {
		if _, err := readTailnetHeader(bufio.NewReader(bytes.NewReader(raw))); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
