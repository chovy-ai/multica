package p2p

import (
	"context"
	"errors"
	"net"
	"slices"
	"sync"

	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"

	"github.com/multica-ai/multica/server/internal/localconversation/timing"
	"github.com/multica-ai/multica/server/internal/tailnetid"
)

// Addr is a device's address as net.Addr: its peer ID.
type Addr peer.ID

func (a Addr) Network() string { return "libp2p" }
func (a Addr) String() string  { return peer.ID(a).String() }

// streamConn is a libp2p stream as net.Conn, so net/http can run over it.
type streamConn struct{ network.Stream }

func (c streamConn) LocalAddr() net.Addr  { return Addr(c.Conn().LocalPeer()) }
func (c streamConn) RemoteAddr() net.Addr { return Addr(c.Conn().RemotePeer()) }

// Relayed reports whether the stream runs over the relay.
func (c streamConn) Relayed() bool { return isCircuit(c.Conn().RemoteMultiaddr()) }

// Relayed reports whether conn is a libp2p stream carried by the relay, which
// a direct connection should replace. A tailnet stream changes path in place,
// so it never needs replacing.
func Relayed(conn net.Conn) bool {
	c, ok := conn.(streamConn)
	return ok && c.Relayed()
}

// StreamConnection says how conn itself travels, which Connection cannot: that
// reads direct as soon as any connection to the device is direct.
func StreamConnection(conn net.Conn) string {
	switch c := conn.(type) {
	case streamConn:
		if c.Relayed() {
			return timing.ConnectionRelayed
		}
		return timing.ConnectionDirect
	case *tailnetConn:
		switch c.t.connection(c.id) {
		case ConnectionDirect:
			return timing.ConnectionDirect
		case ConnectionRelayed:
			return timing.ConnectionRelayed
		}
	}
	return timing.ConnectionUnknown
}

// PeerOf returns the device at the other end of a stream connection.
func PeerOf(conn net.Conn) (peer.ID, bool) {
	switch c := conn.(type) {
	case streamConn:
		return c.Conn().RemotePeer(), true
	case *tailnetConn:
		return c.id, true
	}
	return "", false
}

// Listen accepts protocol streams from this account's devices as
// net.Conns. Unlike go-libp2p-gostream it keeps the allowlist check of
// Handle. stop removes the handler and closes the listener.
func (s *Service) Listen(proto protocol.ID) (net.Listener, func()) {
	l := &streamListener{addr: Addr(s.host.ID()), conns: make(chan net.Conn), done: make(chan struct{})}
	s.Handle(proto, func(st network.Stream) {
		select {
		case l.conns <- streamConn{st}:
		case <-l.done:
			_ = st.Reset()
		}
	})
	if s.tailnet != nil {
		s.tailnet.setRoute(proto, func(c net.Conn) {
			select {
			case l.conns <- c:
			case <-l.done:
				_ = c.Close()
			}
		})
	}
	return l, func() {
		s.host.RemoveStreamHandler(proto)
		if s.tailnet != nil {
			s.tailnet.setRoute(proto, nil)
		}
		_ = l.Close()
	}
}

type streamListener struct {
	addr  net.Addr
	conns chan net.Conn
	done  chan struct{}
	once  sync.Once
}

func (l *streamListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *streamListener) Close() error {
	l.once.Do(func() { close(l.done) })
	return nil
}

func (l *streamListener) Addr() net.Addr { return l.addr }

// Dial uses the available path immediately: the tailnet when the device is
// online there, libp2p otherwise. Hole punching proceeds in the background;
// OnDirect lets consumers move long-lived libp2p streams afterward.
func (s *Service) Dial(ctx context.Context, p peer.ID, proto protocol.ID) (net.Conn, error) {
	if !s.allow.allowed(p) {
		return nil, ErrNotAllowed
	}
	if s.tailnet != nil {
		conn, err := s.tailnet.dial(ctx, p, proto)
		if err == nil {
			return conn, nil
		}
		if !errors.Is(err, errTailnetOffline) {
			s.logger.Debug("p2p: tailnet dial failed; using libp2p", "peer_id", p.String(), "protocol", string(proto), "error", err)
		}
	}
	st, err := s.Open(ctx, p, proto)
	if err != nil {
		return nil, err
	}
	return streamConn{st}, nil
}

// Connection is ConnectionDirect when the tailnet or any libp2p connection
// reaches p without a relay, ConnectionRelayed when only relays (DERP or the
// libp2p relay) do, and "" when p is not reachable.
func (s *Service) Connection(p peer.ID) string {
	state := s.libp2pConnection(p)
	if state == ConnectionDirect || s.tailnet == nil {
		return state
	}
	if tailnet := s.tailnet.connection(p); tailnet != "" {
		return tailnet
	}
	return state
}

func (s *Service) libp2pConnection(p peer.ID) string {
	state := ""
	for _, c := range s.host.Network().ConnsToPeer(p) {
		if !isCircuit(c.RemoteMultiaddr()) {
			return ConnectionDirect
		}
		state = ConnectionRelayed
	}
	return state
}

// Peer returns a device of this account by its ID.
func (s *Service) Peer(p peer.ID) (Peer, bool) { return s.allow.get(p) }

// SupportsProtocol reports whether a connected device announced proto.
func (s *Service) SupportsProtocol(p peer.ID, proto protocol.ID) bool {
	got, err := s.host.Peerstore().SupportsProtocols(p, proto)
	return err == nil && len(got) > 0
}

// WatchConnection invalidates a peer's connection state. Subscribe before
// reading Connection, and read again on each notification to coalesce churn.
func (s *Service) WatchConnection(id peer.ID) (<-chan struct{}, func()) {
	updates := make(chan struct{}, 1)
	notify := func(_ network.Network, c network.Conn) {
		if c.RemotePeer() == id {
			select {
			case updates <- struct{}{}:
			default:
			}
		}
	}
	bundle := &network.NotifyBundle{ConnectedF: notify, DisconnectedF: notify}
	s.host.Network().Notify(bundle)
	s.watchMu.Lock()
	if s.watchers[id] == nil {
		s.watchers[id] = map[chan struct{}]struct{}{}
	}
	s.watchers[id][updates] = struct{}{}
	s.watchMu.Unlock()
	return updates, func() {
		s.host.Network().StopNotify(bundle)
		s.watchMu.Lock()
		delete(s.watchers[id], updates)
		if len(s.watchers[id]) == 0 {
			delete(s.watchers, id)
		}
		s.watchMu.Unlock()
	}
}

// connectionChanged wakes watchers of a device whose tailnet path changed.
func (s *Service) connectionChanged(id peer.ID) {
	s.watchMu.Lock()
	defer s.watchMu.Unlock()
	for updates := range s.watchers[id] {
		select {
		case updates <- struct{}{}:
		default:
		}
	}
}

// OnDirect calls fn whenever a direct connection to a device opens, such as
// after hole punching, so relayed streams can move to it.
func (s *Service) OnDirect(fn func(peer.ID)) {
	s.watchMu.Lock()
	s.onDirect = append(s.onDirect, fn)
	s.watchMu.Unlock()
	s.host.Network().Notify(&network.NotifyBundle{ConnectedF: func(_ network.Network, c network.Conn) {
		if !isCircuit(c.RemoteMultiaddr()) && s.allow.allowed(c.RemotePeer()) {
			go fn(c.RemotePeer())
		}
	}})
}

// directOpened tells OnDirect consumers that the tailnet reaches a device
// directly, so relayed libp2p streams can move to it.
func (s *Service) directOpened(id peer.ID) {
	if !s.allow.allowed(id) {
		return
	}
	s.watchMu.Lock()
	fns := slices.Clone(s.onDirect)
	s.watchMu.Unlock()
	for _, fn := range fns {
		go fn(id)
	}
}

// peerForTailnetHost maps a tailnet hostname back to the account's device.
func (s *Service) peerForTailnetHost(host string) (peer.ID, bool) {
	for _, p := range s.allow.list() {
		if tailnetid.Hostname(p.ID.String()) == host {
			return p.ID, true
		}
	}
	return "", false
}
