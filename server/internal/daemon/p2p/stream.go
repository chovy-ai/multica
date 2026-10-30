package p2p

import (
	"context"
	"net"
	"sync"
	"time"

	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
)

// directWait is how long a dial over a relay-only connection waits for hole
// punching to find a direct path before it uses the relay.
const directWait = 5 * time.Second

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

// Relayed reports whether conn is a device stream carried by the relay.
func Relayed(conn net.Conn) bool {
	c, ok := conn.(streamConn)
	return ok && c.Relayed()
}

// PeerOf returns the device at the other end of a stream connection.
func PeerOf(conn net.Conn) (peer.ID, bool) {
	c, ok := conn.(streamConn)
	if !ok {
		return "", false
	}
	return c.Conn().RemotePeer(), true
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
	return l, func() {
		s.host.RemoveStreamHandler(proto)
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

// Dial opens a protocol stream to a device as net.Conn. When the device is
// reachable only through the relay, it first waits briefly for hole
// punching, so long-lived streams start on a direct connection when one is
// coming.
func (s *Service) Dial(ctx context.Context, p peer.ID, proto protocol.ID) (net.Conn, error) {
	if !s.allow.allowed(p) {
		return nil, ErrNotAllowed
	}
	if s.Connection(p) == ConnectionRelayed {
		deadline := time.NewTimer(directWait)
		tick := time.NewTicker(100 * time.Millisecond)
		defer deadline.Stop()
		defer tick.Stop()
	wait:
		for s.Connection(p) != ConnectionDirect {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-deadline.C:
				break wait
			case <-tick.C:
			}
		}
	}
	st, err := s.Open(ctx, p, proto)
	if err != nil {
		return nil, err
	}
	return streamConn{st}, nil
}

// Connection is ConnectionDirect when any connection to p avoids the relay,
// ConnectionRelayed when all go through it, and "" when not connected.
func (s *Service) Connection(p peer.ID) string {
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

// OnDirect calls fn whenever a direct connection to a device opens, such as
// after hole punching, so relayed streams can move to it.
func (s *Service) OnDirect(fn func(peer.ID)) {
	s.host.Network().Notify(&network.NotifyBundle{ConnectedF: func(_ network.Network, c network.Conn) {
		if !isCircuit(c.RemoteMultiaddr()) && s.allow.allowed(c.RemotePeer()) {
			go fn(c.RemotePeer())
		}
	}})
}
