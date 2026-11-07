package p2p

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/logtail"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"

	"github.com/multica-ai/multica/server/internal/tailnetid"
)

// ErrTailnetUnavailable is returned by a TailnetFunc when the registry has no
// control server; the link then stays on libp2p.
var ErrTailnetUnavailable = errors.New("p2p: tailnet unavailable")

// TailnetCredentials register this device's tailnet node.
type TailnetCredentials struct {
	ControlURL string
	AuthKey    string
}

// TailnetFunc asks the registry for tailnet credentials.
type TailnetFunc func(ctx context.Context) (TailnetCredentials, error)

const (
	// tailnetPort carries device streams inside the tailnet.
	tailnetPort = 4100
	// tailnetDialTimeout bounds a tailnet attempt before Dial falls back to
	// libp2p.
	tailnetDialTimeout = 5 * time.Second
	tailnetUpTimeout   = time.Minute
	tailnetPollEvery   = 2 * time.Second
	tailnetRetryMin    = 5 * time.Second
	tailnetRetryMax    = 5 * time.Minute
	// tailnetUnconfiguredRetry is how often a registry without a control
	// server is asked again.
	tailnetUnconfiguredRetry = time.Hour
	tailnetSettingsFile      = "multica-tailnet.json"
	maxTailnetProtocolLen    = 256
)

var tailnetMagic = [4]byte{'M', 'L', 'T', '1'}

const (
	tailnetAccepted    byte = 0
	tailnetUnsupported byte = 1
)

var (
	errTailnetOffline     = errors.New("p2p: device is not online in the tailnet")
	errTailnetUnsupported = errors.New("p2p: device does not serve this protocol over the tailnet")
)

type tailnetPeer struct {
	addr   netip.Addr
	online bool
	direct bool
}

// tailnet is this device's embedded Tailscale node. It runs beside the libp2p
// host and carries the same protocols.
type tailnet struct {
	svc      *Service
	dir      string
	hostname string
	creds    TailnetFunc
	logger   *slog.Logger

	mu      sync.Mutex
	srv     *tsnet.Server
	lc      *local.Client
	peers   map[string]tailnetPeer // by hostname
	routes  map[protocol.ID]func(net.Conn)
	relogin chan struct{}
}

type tailnetSettings struct {
	ControlURL string `json:"control_url"`
}

func newTailnet(svc *Service, dir string, creds TailnetFunc, logger *slog.Logger) *tailnet {
	// tsnet uploads logs to Tailscale unless told not to.
	logtail.Disable()
	return &tailnet{
		svc:      svc,
		dir:      dir,
		hostname: tailnetid.Hostname(svc.host.ID().String()),
		creds:    creds,
		logger:   logger,
		peers:    map[string]tailnetPeer{},
		routes:   map[protocol.ID]func(net.Conn){},
		relogin:  make(chan struct{}, 1),
	}
}

// run keeps the node up until ctx ends, retrying with backoff.
func (t *tailnet) run(ctx context.Context) {
	delay := tailnetRetryMin
	for {
		err := t.up(ctx)
		if err == nil {
			delay = tailnetRetryMin
			select {
			case <-ctx.Done():
				t.down()
				return
			case <-t.relogin:
				t.logger.Info("p2p: tailnet node signed out; registering again")
				t.down()
				t.forgetState()
				continue
			}
		}
		wait := delay
		if errors.Is(err, ErrTailnetUnavailable) {
			wait = tailnetUnconfiguredRetry
		} else {
			delay = min(delay*2, tailnetRetryMax)
			t.logger.Info("p2p: tailnet unavailable; staying on libp2p", "error", err, "retry_in", wait)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

// up starts the node, registering it first when it has no saved identity.
func (t *tailnet) up(ctx context.Context) error {
	settings := t.loadSettings()
	_, statErr := os.Stat(filepath.Join(t.dir, "tailscaled.state"))
	registered := statErr == nil && settings.ControlURL != ""
	var authKey string
	if !registered {
		creds, err := t.creds(ctx)
		if err != nil {
			return err
		}
		settings.ControlURL, authKey = creds.ControlURL, creds.AuthKey
		if err := t.saveSettings(settings); err != nil {
			return err
		}
	}
	srv := &tsnet.Server{
		Dir:        t.dir,
		Hostname:   t.hostname,
		ControlURL: settings.ControlURL,
		AuthKey:    authKey,
		UserLogf:   func(format string, args ...any) { t.logger.Debug("tailnet: " + fmt.Sprintf(format, args...)) },
	}
	upCtx, cancel := context.WithTimeout(ctx, tailnetUpTimeout)
	defer cancel()
	if _, err := srv.Up(upCtx); err != nil {
		if registered && t.needsLogin(srv) {
			srv.Close()
			t.forgetState()
			return fmt.Errorf("saved tailnet identity was signed out: %w", err)
		}
		srv.Close()
		return err
	}
	lc, err := srv.LocalClient()
	if err != nil {
		srv.Close()
		return err
	}
	ln, err := srv.Listen("tcp", fmt.Sprintf(":%d", tailnetPort))
	if err != nil {
		srv.Close()
		return err
	}
	t.mu.Lock()
	t.srv, t.lc = srv, lc
	t.mu.Unlock()
	t.logger.Info("p2p: tailnet up", "hostname", t.hostname, "control_url", settings.ControlURL)
	go t.accept(ln, lc)
	go t.poll(srv, lc)
	return nil
}

func (t *tailnet) needsLogin(srv *tsnet.Server) bool {
	lc, err := srv.LocalClient()
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	st, err := lc.StatusWithoutPeers(ctx)
	return err == nil && st.BackendState == ipn.NeedsLogin.String()
}

func (t *tailnet) down() {
	t.mu.Lock()
	srv := t.srv
	changed := t.peers
	t.srv, t.lc, t.peers = nil, nil, map[string]tailnetPeer{}
	t.mu.Unlock()
	if srv != nil {
		srv.Close()
	}
	for host := range changed {
		if id, ok := t.svc.peerForTailnetHost(host); ok {
			t.svc.connectionChanged(id)
		}
	}
}

func (t *tailnet) forgetState() {
	entries, err := os.ReadDir(t.dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		os.RemoveAll(filepath.Join(t.dir, e.Name()))
	}
}

func (t *tailnet) loadSettings() tailnetSettings {
	var s tailnetSettings
	if raw, err := os.ReadFile(filepath.Join(t.dir, tailnetSettingsFile)); err == nil {
		json.Unmarshal(raw, &s)
	}
	return s
}

func (t *tailnet) saveSettings(s tailnetSettings) error {
	if err := os.MkdirAll(t.dir, 0o700); err != nil {
		return err
	}
	raw, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(t.dir, tailnetSettingsFile), raw, 0o600)
}

// poll mirrors the node's view of the account's devices, which Dial and
// Connection read, until the node stops.
func (t *tailnet) poll(srv *tsnet.Server, lc *local.Client) {
	ticker := time.NewTicker(tailnetPollEvery)
	defer ticker.Stop()
	for {
		t.mu.Lock()
		current := t.srv == srv
		t.mu.Unlock()
		if !current {
			return
		}
		ctx, cancel := context.WithTimeout(t.svc.ctx, tailnetPollEvery)
		st, err := lc.Status(ctx)
		cancel()
		if err == nil {
			if st.BackendState == ipn.NeedsLogin.String() {
				select {
				case t.relogin <- struct{}{}:
				default:
				}
			}
			t.update(srv, lc, st)
		}
		select {
		case <-t.svc.ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (t *tailnet) update(srv *tsnet.Server, lc *local.Client, st *ipnstate.Status) {
	next := make(map[string]tailnetPeer, len(st.Peer))
	for _, ps := range st.Peer {
		if len(ps.TailscaleIPs) == 0 {
			continue
		}
		next[ps.HostName] = tailnetPeer{addr: ps.TailscaleIPs[0], online: ps.Online, direct: ps.CurAddr != ""}
	}
	t.mu.Lock()
	if t.srv != srv {
		t.mu.Unlock()
		return
	}
	prev := t.peers
	t.peers = next
	t.mu.Unlock()

	for host, p := range next {
		old, seen := prev[host]
		if seen && old == p {
			continue
		}
		id, ok := t.svc.peerForTailnetHost(host)
		if !ok {
			continue
		}
		if p.online && (!seen || !old.online) {
			// A disco ping starts path discovery before the first stream needs it.
			go func(addr netip.Addr) {
				ctx, cancel := context.WithTimeout(t.svc.ctx, 10*time.Second)
				defer cancel()
				lc.Ping(ctx, addr, tailcfg.PingDisco)
			}(p.addr)
		}
		if p.direct && !old.direct {
			t.logger.Info("p2p: tailnet path is direct", "peer_id", id.String())
			t.svc.directOpened(id)
		}
		t.svc.connectionChanged(id)
	}
	for host := range prev {
		if _, ok := next[host]; !ok {
			if id, ok := t.svc.peerForTailnetHost(host); ok {
				t.svc.connectionChanged(id)
			}
		}
	}
}

func (t *tailnet) peer(id peer.ID) (*tsnet.Server, tailnetPeer, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	p, ok := t.peers[tailnetid.Hostname(id.String())]
	return t.srv, p, ok && t.srv != nil
}

// connection is the device's tailnet path: direct, relayed through DERP, or
// "" when it is not online there.
func (t *tailnet) connection(id peer.ID) string {
	_, p, ok := t.peer(id)
	switch {
	case !ok || !p.online:
		return ""
	case p.direct:
		return ConnectionDirect
	}
	return ConnectionRelayed
}

func (t *tailnet) setRoute(proto protocol.ID, deliver func(net.Conn)) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if deliver == nil {
		delete(t.routes, proto)
		return
	}
	t.routes[proto] = deliver
}

func (t *tailnet) route(proto protocol.ID) func(net.Conn) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.routes[proto]
}

func (t *tailnet) dial(ctx context.Context, id peer.ID, proto protocol.ID) (net.Conn, error) {
	srv, p, ok := t.peer(id)
	if !ok || !p.online {
		return nil, errTailnetOffline
	}
	ctx, cancel := context.WithTimeout(ctx, tailnetDialTimeout)
	defer cancel()
	conn, err := srv.Dial(ctx, "tcp", netip.AddrPortFrom(p.addr, tailnetPort).String())
	if err != nil {
		return nil, err
	}
	if deadline, ok := ctx.Deadline(); ok {
		conn.SetDeadline(deadline)
	}
	if err := writeTailnetHeader(conn, proto); err != nil {
		conn.Close()
		return nil, err
	}
	var status [1]byte
	if _, err := io.ReadFull(conn, status[:]); err != nil {
		conn.Close()
		return nil, err
	}
	if status[0] != tailnetAccepted {
		conn.Close()
		return nil, errTailnetUnsupported
	}
	conn.SetDeadline(time.Time{})
	return &tailnetConn{Conn: conn, id: id, local: t.svc.host.ID(), t: t}, nil
}

func (t *tailnet) accept(ln net.Listener, lc *local.Client) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go t.handle(conn, lc)
	}
}

// handle admits a stream only from a device on this account's allowlist,
// identified by the hostname its node registered.
func (t *tailnet) handle(conn net.Conn, lc *local.Client) {
	conn.SetDeadline(time.Now().Add(tailnetDialTimeout))
	ctx, cancel := context.WithTimeout(t.svc.ctx, tailnetDialTimeout)
	who, err := lc.WhoIs(ctx, conn.RemoteAddr().String())
	cancel()
	if err != nil || who.Node == nil || !who.Node.Hostinfo.Valid() {
		conn.Close()
		return
	}
	id, ok := t.svc.peerForTailnetHost(who.Node.Hostinfo.Hostname())
	if !ok {
		conn.Close()
		return
	}
	reader := bufio.NewReader(conn)
	proto, err := readTailnetHeader(reader)
	if err != nil {
		conn.Close()
		return
	}
	deliver := t.route(proto)
	if deliver == nil {
		conn.Write([]byte{tailnetUnsupported})
		conn.Close()
		return
	}
	if _, err := conn.Write([]byte{tailnetAccepted}); err != nil {
		conn.Close()
		return
	}
	conn.SetDeadline(time.Time{})
	// The header is the only thing the dialer sends before the status byte.
	deliver(&tailnetConn{Conn: conn, id: id, local: t.svc.host.ID(), t: t})
}

func writeTailnetHeader(w io.Writer, proto protocol.ID) error {
	if len(proto) == 0 || len(proto) > maxTailnetProtocolLen {
		return fmt.Errorf("p2p: invalid protocol %q", proto)
	}
	buf := append([]byte{}, tailnetMagic[:]...)
	buf = binary.AppendUvarint(buf, uint64(len(proto)))
	buf = append(buf, proto...)
	_, err := w.Write(buf)
	return err
}

func readTailnetHeader(r *bufio.Reader) (protocol.ID, error) {
	var magic [4]byte
	if _, err := io.ReadFull(r, magic[:]); err != nil {
		return "", err
	}
	if magic != tailnetMagic {
		return "", errors.New("p2p: not a tailnet stream")
	}
	n, err := binary.ReadUvarint(r)
	if err != nil {
		return "", err
	}
	if n == 0 || n > maxTailnetProtocolLen {
		return "", errors.New("p2p: invalid protocol length")
	}
	if r.Buffered() > int(n) {
		return "", errors.New("p2p: data before the stream was accepted")
	}
	proto := make([]byte, n)
	if _, err := io.ReadFull(r, proto); err != nil {
		return "", err
	}
	return protocol.ID(proto), nil
}

// tailnetConn is a device stream carried by the tailnet. WireGuard moves it
// between DERP and a direct path without breaking it.
type tailnetConn struct {
	net.Conn
	id    peer.ID
	local peer.ID
	t     *tailnet
}

func (c *tailnetConn) LocalAddr() net.Addr  { return Addr(c.local) }
func (c *tailnetConn) RemoteAddr() net.Addr { return Addr(c.id) }
