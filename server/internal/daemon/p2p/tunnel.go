package p2p

import (
	"context"
	"net"
	"net/http"
	"net/http/httptrace"
	"sync"

	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
)

// Tunnel is the http.RoundTripper for one device's HTTP and upgraded WebSocket
// traffic. It remembers which streams it dialed so relayed WebSockets can move
// to a direct connection without interrupting requests still in flight.
type Tunnel struct {
	svc       *Service
	id        peer.ID
	transport *http.Transport

	mu    sync.Mutex
	conns map[*tunnelConn]struct{}
}

// tunnelConn embeds the raw stream connection, which Relayed inspects.
type tunnelConn struct {
	net.Conn
	tunnel   *Tunnel
	upgraded bool // guarded by tunnel.mu
	once     sync.Once
}

func (c *tunnelConn) Close() error {
	c.once.Do(func() {
		c.tunnel.mu.Lock()
		delete(c.tunnel.conns, c)
		c.tunnel.mu.Unlock()
	})
	return c.Conn.Close()
}

// NewTunnel dials through svc using transport, whose DialContext it replaces.
func (s *Service) NewTunnel(id peer.ID, proto protocol.ID, transport *http.Transport) *Tunnel {
	t := &Tunnel{svc: s, id: id, transport: transport, conns: map[*tunnelConn]struct{}{}}
	transport.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
		raw, err := s.Dial(ctx, id, proto)
		if err != nil {
			return nil, err
		}
		conn := &tunnelConn{Conn: raw, tunnel: t}
		t.mu.Lock()
		t.conns[conn] = struct{}{}
		t.mu.Unlock()
		return conn, nil
	}
	return t
}

func (t *Tunnel) RoundTrip(req *http.Request) (*http.Response, error) {
	t.dropIdleRelayed()
	var conn *tunnelConn
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{
		GotConn: func(info httptrace.GotConnInfo) { conn, _ = info.Conn.(*tunnelConn) },
	}))
	res, err := t.transport.RoundTrip(req)
	if err == nil && conn != nil && res.StatusCode == http.StatusSwitchingProtocols {
		t.markUpgraded(conn)
	}
	return res, err
}

// dropIdleRelayed keeps a request from reusing a relayed stream that went idle
// after the direct connection appeared; such a stream was in flight during
// MoveToDirect, and a WebSocket upgraded on it would otherwise stay on the relay.
func (t *Tunnel) dropIdleRelayed() {
	if t.svc.Connection(t.id) != ConnectionDirect {
		return
	}
	relayed := false
	t.mu.Lock()
	for c := range t.conns {
		if !c.upgraded && Relayed(c.Conn) {
			relayed = true
			break
		}
	}
	t.mu.Unlock()
	if relayed {
		t.transport.CloseIdleConnections()
	}
}

// markUpgraded also covers an upgrade still in flight during MoveToDirect: it
// marks before reading the connection state, so one of the two always closes it.
func (t *Tunnel) markUpgraded(conn *tunnelConn) {
	t.mu.Lock()
	conn.upgraded = true
	t.mu.Unlock()
	if Relayed(conn.Conn) && t.svc.Connection(t.id) == ConnectionDirect {
		_ = conn.Close()
	}
}

// MoveToDirect closes idle connections and relayed WebSocket streams so their
// clients reconnect over the direct connection. Requests in flight finish on
// the relay.
func (t *Tunnel) MoveToDirect() {
	t.transport.CloseIdleConnections()
	t.mu.Lock()
	var relayed []*tunnelConn
	for c := range t.conns {
		if c.upgraded && Relayed(c.Conn) {
			relayed = append(relayed, c)
		}
	}
	t.mu.Unlock()
	for _, c := range relayed {
		_ = c.Close()
	}
}

// CloseIdleConnections leaves requests in flight and WebSockets open.
func (t *Tunnel) CloseIdleConnections() { t.transport.CloseIdleConnections() }

// Close closes every stream, including hijacked WebSockets, which the
// transport no longer owns.
func (t *Tunnel) Close() {
	t.transport.CloseIdleConnections()
	t.mu.Lock()
	conns := make([]*tunnelConn, 0, len(t.conns))
	for c := range t.conns {
		conns = append(conns, c)
	}
	t.mu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
}
