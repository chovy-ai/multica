package p2p

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/peerstore"
	"github.com/libp2p/go-libp2p/core/protocol"
	"github.com/libp2p/go-libp2p/p2p/discovery/mdns"
	"github.com/libp2p/go-libp2p/p2p/protocol/ping"
)

// DefaultMDNSServiceName keeps Multica's LAN announcements apart from other
// libp2p applications on the same network.
const DefaultMDNSServiceName = "_multica-p2p._udp"

const (
	defaultRefreshInterval = time.Minute
	// minKickInterval rate-limits refreshes triggered by unknown peers, so a
	// stranger repeatedly connecting cannot turn into server load. A request
	// inside the window is deferred, not dropped: the unknown peer is often
	// a device that registered seconds after our last refresh.
	minKickInterval = 5 * time.Second
	connectTimeout  = 10 * time.Second
)

// ErrNotAllowed means the peer is not a device of this account.
var ErrNotAllowed = errors.New("p2p: peer is not a device of this account")

// Config configures a Service.
type Config struct {
	Key   crypto.PrivKey
	Fetch FetchFunc
	// Port is used for both TCP and QUIC on every interface; 0 picks a random
	// port per transport. Ignored when ListenAddrs is set.
	Port int
	// ListenAddrs overrides the listen multiaddrs (tests bind to loopback).
	ListenAddrs []string
	// MDNSServiceName enables LAN discovery under this service name; empty
	// disables it.
	MDNSServiceName string
	RefreshInterval time.Duration
	Logger          *slog.Logger
}

// Service is this device's endpoint on the account's peer-to-peer network.
type Service struct {
	host     host.Host
	allow    *allowlist
	fetch    FetchFunc
	logger   *slog.Logger
	interval time.Duration
	mdns     mdns.Service

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
	kick   chan struct{}

	refreshMu   sync.Mutex
	lastRefresh time.Time

	discoveredMu sync.Mutex
	discovered   map[peer.ID]peer.AddrInfo
}

// Start builds the libp2p host, starts LAN discovery and the allowlist
// refresh loop. The first refresh runs in the background; until it finishes
// no peer is admitted.
func Start(ctx context.Context, cfg Config) (*Service, error) {
	if cfg.Key == nil || cfg.Fetch == nil {
		return nil, errors.New("p2p: key and fetch are required")
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	self, err := peer.IDFromPrivateKey(cfg.Key)
	if err != nil {
		return nil, err
	}
	listen := cfg.ListenAddrs
	if len(listen) == 0 {
		port := strconv.Itoa(cfg.Port)
		listen = []string{
			"/ip4/0.0.0.0/udp/" + port + "/quic-v1",
			"/ip6/::/udp/" + port + "/quic-v1",
			"/ip4/0.0.0.0/tcp/" + port,
			"/ip6/::/tcp/" + port,
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	s := &Service{
		allow:      newAllowlist(self),
		fetch:      cfg.Fetch,
		logger:     logger,
		interval:   cfg.RefreshInterval,
		ctx:        ctx,
		cancel:     cancel,
		kick:       make(chan struct{}, 1),
		discovered: map[peer.ID]peer.AddrInfo{},
	}
	if s.interval <= 0 {
		s.interval = defaultRefreshInterval
	}
	gater := &accountGater{allow: s.allow, onUnknown: func(peer.ID) { s.requestRefresh() }}

	h, err := newHost(cfg.Key, listen, gater)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("p2p: start host: %w", err)
	}
	s.host = h

	if cfg.MDNSServiceName != "" {
		s.mdns = mdns.NewMdnsService(h, cfg.MDNSServiceName, s)
		if err := s.mdns.Start(); err != nil {
			s.Close()
			return nil, fmt.Errorf("p2p: start mdns: %w", err)
		}
	}

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.refreshLoop()
	}()
	logger.Info("p2p: host started", "peer_id", self.String(), "addrs", h.Addrs())
	return s, nil
}

// Close stops discovery and the host, closing every connection.
func (s *Service) Close() error {
	s.cancel()
	if s.mdns != nil {
		s.mdns.Close()
	}
	err := s.host.Close()
	s.wg.Wait()
	return err
}

// ID returns this device's peer ID.
func (s *Service) ID() peer.ID { return s.host.ID() }

// Handle serves inbound streams for protocol. Only allowed peers can reach
// it; the gater rejects everyone else before any stream opens.
func (s *Service) Handle(p protocol.ID, h network.StreamHandler) {
	s.host.SetStreamHandler(p, h)
}

// Open opens a stream to a device of this account.
func (s *Service) Open(ctx context.Context, p peer.ID, proto protocol.ID) (network.Stream, error) {
	if !s.allow.allowed(p) {
		return nil, ErrNotAllowed
	}
	return s.host.NewStream(ctx, p, proto)
}

// Ping measures the round trip to a device using libp2p's ping protocol.
func (s *Service) Ping(ctx context.Context, p peer.ID) (time.Duration, error) {
	if !s.allow.allowed(p) {
		return 0, ErrNotAllowed
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	select {
	case res := <-ping.Ping(ctx, s.host, p):
		return res.RTT, res.Error
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

// AddAddrs records addresses for a peer learned outside mDNS, e.g. from a
// future server signaling channel.
func (s *Service) AddAddrs(info peer.AddrInfo) { s.HandlePeerFound(info) }

// HandlePeerFound implements mdns.Notifee. Addresses are remembered even for
// peers not yet on the allowlist, because mDNS reports each peer once and the
// device may register on the server after it was seen.
func (s *Service) HandlePeerFound(info peer.AddrInfo) {
	if info.ID == s.host.ID() || len(info.Addrs) == 0 {
		return
	}
	s.discoveredMu.Lock()
	s.discovered[info.ID] = info
	s.discoveredMu.Unlock()
	if s.allow.allowed(info.ID) {
		s.connect(info)
	}
}

func (s *Service) connect(info peer.AddrInfo) {
	s.host.Peerstore().AddAddrs(info.ID, info.Addrs, peerstore.AddressTTL)
	if s.host.Network().Connectedness(info.ID) == network.Connected {
		return
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ctx, cancel := context.WithTimeout(s.ctx, connectTimeout)
		defer cancel()
		if err := s.host.Connect(ctx, info); err != nil && s.ctx.Err() == nil {
			s.logger.Debug("p2p: connect failed", "peer_id", info.ID.String(), "error", err)
		}
	}()
}

func (s *Service) requestRefresh() {
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

func (s *Service) refreshLoop() {
	if err := s.Refresh(s.ctx); err != nil && s.ctx.Err() == nil {
		s.logger.Warn("p2p: initial allowlist refresh failed", "error", err)
	}
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	// deferred fires a kick that arrived inside the rate-limit window.
	var deferred <-chan time.Time
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
		case <-deferred:
			deferred = nil
		case <-s.kick:
			if deferred != nil {
				continue
			}
			s.refreshMu.Lock()
			wait := minKickInterval - time.Since(s.lastRefresh)
			s.refreshMu.Unlock()
			if wait > 0 {
				deferred = time.After(wait)
				continue
			}
		}
		if err := s.Refresh(s.ctx); err != nil && s.ctx.Err() == nil {
			s.logger.Warn("p2p: allowlist refresh failed", "error", err)
		}
	}
}

// Refresh reloads the allowlist now. Devices that left the account are
// disconnected; newly listed devices already seen on the LAN are dialed.
func (s *Service) Refresh(ctx context.Context) error {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	s.lastRefresh = time.Now()
	peers, err := s.fetch(ctx)
	if err != nil {
		return err
	}
	added, removed := s.allow.replace(peers)
	for _, id := range removed {
		s.host.Network().ClosePeer(id)
	}
	if len(added) > 0 {
		s.discoveredMu.Lock()
		var infos []peer.AddrInfo
		for _, id := range added {
			if info, ok := s.discovered[id]; ok {
				infos = append(infos, info)
			}
		}
		s.discoveredMu.Unlock()
		for _, info := range infos {
			s.connect(info)
		}
	}
	return nil
}

// PeerStatus is one device of the account as seen from here.
type PeerStatus struct {
	Peer
	Connected bool     `json:"connected"`
	Addrs     []string `json:"addrs"`
}

// Status is a point-in-time snapshot for diagnostics.
type Status struct {
	PeerID      string       `json:"peer_id"`
	ListenAddrs []string     `json:"listen_addrs"`
	Peers       []PeerStatus `json:"peers"`
}

// Peers lists the account's other devices with their connection state.
func (s *Service) Peers() []PeerStatus {
	list := s.allow.list()
	out := make([]PeerStatus, 0, len(list))
	for _, p := range list {
		ps := PeerStatus{Peer: p, Addrs: []string{}}
		ps.Connected = s.host.Network().Connectedness(p.ID) == network.Connected
		for _, a := range s.host.Peerstore().Addrs(p.ID) {
			ps.Addrs = append(ps.Addrs, a.String())
		}
		sort.Strings(ps.Addrs)
		out = append(out, ps)
	}
	return out
}

// Status returns this device's identity, listen addresses and peers.
func (s *Service) Status() Status {
	st := Status{PeerID: s.host.ID().String(), ListenAddrs: []string{}, Peers: s.Peers()}
	for _, a := range s.host.Addrs() {
		st.ListenAddrs = append(st.ListenAddrs, a.String())
	}
	sort.Strings(st.ListenAddrs)
	return st
}
