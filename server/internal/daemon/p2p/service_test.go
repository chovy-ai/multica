package p2p

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
)

// testAccount is a mutable server-side device list.
type testAccount struct {
	mu    sync.Mutex
	peers []Peer
}

func (a *testAccount) set(peers ...Peer) {
	a.mu.Lock()
	a.peers = peers
	a.mu.Unlock()
}

func (a *testAccount) fetch(context.Context) ([]Peer, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]Peer(nil), a.peers...), nil
}

type testDevice struct {
	key  crypto.PrivKey
	id   peer.ID
	svc  *Service
	acct *testAccount
}

func newKey(t *testing.T) (crypto.PrivKey, peer.ID) {
	t.Helper()
	key, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id, err := peer.IDFromPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return key, id
}

func startDevice(t *testing.T, key crypto.PrivKey, acct *testAccount, mdnsName string, listen ...string) *Service {
	t.Helper()
	if len(listen) == 0 && mdnsName == "" {
		listen = []string{"/ip4/127.0.0.1/udp/0/quic-v1", "/ip4/127.0.0.1/tcp/0"}
	}
	svc, err := Start(context.Background(), Config{
		Key:             key,
		Fetch:           acct.fetch,
		ListenAddrs:     listen,
		MDNSServiceName: mdnsName,
		RefreshInterval: time.Hour,
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

func introduce(from, to *Service) {
	from.AddAddrs(peer.AddrInfo{ID: to.ID(), Addrs: to.host.Addrs()})
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return cond()
}

func TestLoadOrCreateKeyPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "p2p.key")
	first, err := LoadOrCreateKey(path)
	if err != nil {
		t.Fatal(err)
	}
	second, err := LoadOrCreateKey(path)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Equals(second) {
		t.Fatal("key changed across loads")
	}
	if info, err := os.Stat(path); err != nil {
		t.Fatal(err)
	} else if os.PathSeparator == '/' && info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("key file readable by others: %v", info.Mode().Perm())
	}
	if err := os.WriteFile(path, []byte("garbage"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateKey(path); err == nil {
		t.Fatal("corrupt key file should fail instead of minting a new identity")
	}
}

func TestSameAccountDevicesPingAndStream(t *testing.T) {
	keyA, idA := newKey(t)
	keyB, idB := newKey(t)
	acct := &testAccount{}
	acct.set(Peer{ID: idA, DeviceName: "a"}, Peer{ID: idB, DeviceName: "b"})
	a := startDevice(t, keyA, acct, "")
	b := startDevice(t, keyB, acct, "")

	const echo = "/multica/test-echo/1"
	b.Handle(echo, func(s network.Stream) {
		defer s.Close()
		if s.Conn().RemotePeer() != idA {
			t.Errorf("remote = %s, want %s", s.Conn().RemotePeer(), idA)
		}
		io.Copy(s, s)
	})
	introduce(a, b)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := a.Ping(ctx, idB); err != nil {
		t.Fatalf("ping: %v", err)
	}
	s, err := a.Open(ctx, idB, echo)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	payload := bytes.Repeat([]byte("multica "), 64<<10)
	go func() {
		s.Write(payload)
		s.CloseWrite()
	}()
	got, err := io.ReadAll(s)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("echo mismatch: %d bytes, want %d", len(got), len(payload))
	}

	var st PeerStatus
	for _, p := range a.Status().Peers {
		if p.ID == idB {
			st = p
		}
	}
	if !st.Connected || st.DeviceName != "b" || len(st.Addrs) == 0 {
		t.Fatalf("status for b = %+v", st)
	}
}

func TestOpenRejectsPeerOutsideAccount(t *testing.T) {
	keyA, idA := newKey(t)
	_, idX := newKey(t)
	acct := &testAccount{}
	acct.set(Peer{ID: idA})
	a := startDevice(t, keyA, acct, "")
	if _, err := a.Open(context.Background(), idX, "/multica/test/1"); !errors.Is(err, ErrNotAllowed) {
		t.Fatalf("got %v, want ErrNotAllowed", err)
	}
}

func TestResponderRejectsDeviceItDoesNotTrust(t *testing.T) {
	keyA, idA := newKey(t)
	keyB, idB := newKey(t)
	trustsBoth := &testAccount{}
	trustsBoth.set(Peer{ID: idA}, Peer{ID: idB})
	trustsSelf := &testAccount{}
	trustsSelf.set(Peer{ID: idB})
	a := startDevice(t, keyA, trustsBoth, "")
	b := startDevice(t, keyB, trustsSelf, "")
	introduce(a, b)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := a.Ping(ctx, idB); err == nil {
		t.Fatal("responder admitted a device outside its account")
	}
}

func TestRevokedDeviceIsDisconnected(t *testing.T) {
	keyA, idA := newKey(t)
	keyB, idB := newKey(t)
	acct := &testAccount{}
	acct.set(Peer{ID: idA}, Peer{ID: idB})
	a := startDevice(t, keyA, acct, "")
	b := startDevice(t, keyB, acct, "")
	introduce(a, b)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := a.Ping(ctx, idB); err != nil {
		t.Fatalf("ping before revoke: %v", err)
	}

	acct.set(Peer{ID: idA})
	if err := a.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	if !waitFor(t, 3*time.Second, func() bool {
		return a.host.Network().Connectedness(idB) != network.Connected
	}) {
		t.Fatal("revoked device still connected")
	}
	// b has not refreshed yet and still lists a; a must refuse it anyway.
	if _, err := b.Ping(ctx, idA); err == nil {
		t.Fatal("revoked device could reconnect")
	}
}

func TestDeviceSeenBeforeRegistrationConnectsAfterRefresh(t *testing.T) {
	keyA, idA := newKey(t)
	keyB, idB := newKey(t)
	acctA := &testAccount{}
	acctA.set(Peer{ID: idA})
	acctB := &testAccount{}
	acctB.set(Peer{ID: idA}, Peer{ID: idB})
	a := startDevice(t, keyA, acctA, "")
	startB := startDevice(t, keyB, acctB, "")
	// a sees b on the LAN before b's key reached the server.
	introduce(a, startB)

	acctA.set(Peer{ID: idA}, Peer{ID: idB})
	if err := a.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !waitFor(t, 10*time.Second, func() bool {
		return a.host.Network().Connectedness(idB) == network.Connected
	}) {
		t.Fatal("newly registered device seen earlier was not dialed")
	}
}

func TestMDNSDiscoveryConnectsDevices(t *testing.T) {
	if testing.Short() {
		t.Skip("uses multicast")
	}
	keyA, idA := newKey(t)
	keyB, idB := newKey(t)
	acct := &testAccount{}
	acct.set(Peer{ID: idA}, Peer{ID: idB})
	// A per-test service name keeps parallel test runs from discovering
	// each other.
	name := "_multica-test-" + idA.String()[len(idA.String())-8:] + "._udp"
	a := startDevice(t, keyA, acct, name)
	startDevice(t, keyB, acct, name)

	if !waitFor(t, 15*time.Second, func() bool {
		return a.host.Network().Connectedness(idB) == network.Connected
	}) {
		t.Skip("no mDNS route on this host; LAN discovery not exercised")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := a.Ping(ctx, idB); err != nil {
		t.Fatalf("ping over mDNS-discovered connection: %v", err)
	}
}

// Regression: a device that registers right after our last refresh used to
// be rejected until the next periodic refresh, because the refresh its
// connection attempt requested fell inside the rate limit and was dropped.
func TestUnknownPeerRefreshIsDeferredNotDropped(t *testing.T) {
	keyA, idA := newKey(t)
	keyB, idB := newKey(t)
	acctA := &testAccount{}
	acctA.set(Peer{ID: idA})
	acctB := &testAccount{}
	acctB.set(Peer{ID: idA}, Peer{ID: idB})
	a := startDevice(t, keyA, acctA, "")
	b := startDevice(t, keyB, acctB, "")
	// b registers just after a's refresh.
	acctA.set(Peer{ID: idA}, Peer{ID: idB})
	introduce(b, a)

	ok := waitFor(t, minKickInterval+5*time.Second, func() bool {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_, err := b.Ping(ctx, idA)
		return err == nil
	})
	if !ok {
		t.Fatal("a never admitted b; its refresh request was dropped")
	}
}
