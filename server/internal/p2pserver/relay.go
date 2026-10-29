package p2pserver

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	pbv2 "github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/pb"
	"github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/proto"
	"github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/relay"
	ma "github.com/multiformats/go-multiaddr"
)

const (
	// DefaultMaxCircuitsPerUser caps concurrent relayed connections per
	// account. Relayed connections have no duration or data limit, so this
	// and the global reservation caps bound the relay's load.
	DefaultMaxCircuitsPerUser = 8

	ownerCacheTTL = 30 * time.Second
)

// RelayConfig configures the libp2p relay node.
type RelayConfig struct {
	Key crypto.PrivKey
	// ListenAddrs are the libp2p listen multiaddrs.
	ListenAddrs []string
	// AnnounceAddrs replace the addresses the node advertises. Cloud VMs
	// only see their private address, so the public one is configured.
	AnnounceAddrs      []string
	Store              *Store
	DeviceTTL          time.Duration
	MaxCircuitsPerUser int
	Logger             *slog.Logger
	Now                func() time.Time
}

// RelayInfo is what daemons need to reach the relay.
type RelayInfo struct {
	PeerID string   `json:"peer_id"`
	Addrs  []string `json:"addrs"`
}

// Relay is a circuit relay v2 node that only serves registered devices and
// only links devices of the same account.
type Relay struct {
	host   host.Host
	relay  *relay.Relay
	acl    *accountACL
	stats  *relayStats
	info   RelayInfo
	logger *slog.Logger
}

// StartRelay starts the relay node.
func StartRelay(cfg RelayConfig) (*Relay, error) {
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	announce := make([]ma.Multiaddr, 0, len(cfg.AnnounceAddrs))
	for _, s := range cfg.AnnounceAddrs {
		a, err := ma.NewMultiaddr(s)
		if err != nil {
			return nil, fmt.Errorf("invalid announce address %q: %w", s, err)
		}
		announce = append(announce, a)
	}
	opts := []libp2p.Option{
		libp2p.Identity(cfg.Key),
		libp2p.ListenAddrStrings(cfg.ListenAddrs...),
		libp2p.DisableMetrics(),
		// The relay is the public endpoint others relay through; it never
		// needs a relay itself.
		libp2p.DisableRelay(),
		libp2p.ForceReachabilityPublic(),
	}
	if len(announce) > 0 {
		opts = append(opts, libp2p.AddrsFactory(func([]ma.Multiaddr) []ma.Multiaddr { return announce }))
	}
	h, err := libp2p.New(opts...)
	if err != nil {
		return nil, fmt.Errorf("p2pserver: start relay host: %w", err)
	}

	maxPerUser := cfg.MaxCircuitsPerUser
	if maxPerUser <= 0 {
		maxPerUser = DefaultMaxCircuitsPerUser
	}
	ttl := cfg.DeviceTTL
	if ttl <= 0 {
		ttl = DefaultDeviceTTL
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	acl := &accountACL{
		host:       h,
		store:      cfg.Store,
		ttl:        ttl,
		maxPerUser: maxPerUser,
		now:        now,
		logger:     logger,
		cache:      map[peer.ID]ownerEntry{},
	}
	stats := &relayStats{}
	rc := relay.DefaultResources()
	// Relayed connections are a lasting fallback when hole punching fails,
	// not just a handshake channel.
	rc.Limit = nil
	rc.MaxReservations = 1024
	rc.MaxReservationsPerIP = 16
	rc.MaxCircuits = 16
	svc, err := relay.New(h, relay.WithResources(rc), relay.WithACL(acl), relay.WithMetricsTracer(stats))
	if err != nil {
		h.Close()
		return nil, fmt.Errorf("p2pserver: start relay service: %w", err)
	}

	info := RelayInfo{PeerID: h.ID().String(), Addrs: []string{}}
	for _, a := range h.Addrs() {
		info.Addrs = append(info.Addrs, a.String())
	}
	sort.Strings(info.Addrs)
	logger.Info("p2pserver: relay started", "peer_id", info.PeerID, "addrs", info.Addrs, "max_circuits_per_user", maxPerUser)
	return &Relay{host: h, relay: svc, acl: acl, stats: stats, info: info, logger: logger}, nil
}

// Info returns the relay's peer ID and advertised addresses.
func (r *Relay) Info() RelayInfo { return r.info }

// Host exposes the libp2p host for tests.
func (r *Relay) Host() host.Host { return r.host }

// Healthy reports whether the node is still listening.
func (r *Relay) Healthy() bool { return len(r.host.Network().ListenAddresses()) > 0 }

// Forget drops a removed device: its cached owner and every connection,
// which also ends its reservation and relayed connections.
func (r *Relay) Forget(peerID string) {
	id, err := peer.Decode(peerID)
	if err != nil {
		return
	}
	r.acl.forget(id)
	r.host.Network().ClosePeer(id)
}

// Close stops the relay.
func (r *Relay) Close() error {
	r.relay.Close()
	return r.host.Close()
}

// RunSummary logs relay usage every interval until ctx ends.
func (r *Relay) RunSummary(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			perUser := r.acl.circuitsByUser()
			type usage struct {
				user string
				n    int
			}
			var top []usage
			for u, n := range perUser {
				top = append(top, usage{u, n})
			}
			sort.Slice(top, func(i, j int) bool { return top[i].n > top[j].n })
			if len(top) > 3 {
				top = top[:3]
			}
			attrs := []any{
				"reservations", r.stats.reservations.Load(),
				"circuits", r.stats.circuits.Load(),
				"connected_peers", len(r.host.Network().Peers()),
			}
			for i, u := range top {
				attrs = append(attrs, "top"+strconv.Itoa(i+1), u.user+"="+strconv.Itoa(u.n))
			}
			r.logger.Info("p2pserver: relay usage", attrs...)
		}
	}
}

type ownerEntry struct {
	userID  string
	ok      bool
	expires time.Time
}

// accountACL admits reservations from registered devices and relayed
// connections between devices of one account, up to maxPerUser at a time.
type accountACL struct {
	host       host.Host
	store      *Store
	ttl        time.Duration
	maxPerUser int
	now        func() time.Time
	logger     *slog.Logger

	mu    sync.Mutex
	cache map[peer.ID]ownerEntry
}

func (a *accountACL) AllowReserve(p peer.ID, _ ma.Multiaddr) bool {
	if _, ok := a.owner(p); !ok {
		a.logger.Info("p2pserver: relay reservation refused", "peer_id", p.String(), "reason", "unregistered")
		return false
	}
	return true
}

func (a *accountACL) AllowConnect(src peer.ID, _ ma.Multiaddr, dst peer.ID) bool {
	srcUser, ok := a.owner(src)
	if !ok {
		a.logger.Info("p2pserver: relay connection refused", "src", src.String(), "dst", dst.String(), "reason", "unregistered source")
		return false
	}
	dstUser, ok := a.owner(dst)
	if !ok {
		a.logger.Info("p2pserver: relay connection refused", "src", src.String(), "dst", dst.String(), "reason", "unregistered destination")
		return false
	}
	if srcUser != dstUser {
		a.logger.Info("p2pserver: relay connection refused", "src", src.String(), "dst", dst.String(), "reason", "different accounts")
		return false
	}
	// The CONNECT stream being decided is already open and counted.
	if n := a.circuitsByUser()[srcUser]; n > a.maxPerUser {
		a.logger.Info("p2pserver: relay connection refused", "src", src.String(), "dst", dst.String(), "reason", "account circuit limit", "user_id", srcUser, "limit", a.maxPerUser)
		return false
	}
	return true
}

// circuitsByUser counts open relayed connections per account. A relayed
// connection holds the source's inbound hop stream open for its lifetime,
// and both ends belong to one account, so each such stream is one circuit.
// The relay offers no close callback carrying peer IDs, so counting live
// streams avoids a counter that could drift.
func (a *accountACL) circuitsByUser() map[string]int {
	out := map[string]int{}
	for _, c := range a.host.Network().Conns() {
		n := 0
		for _, s := range c.GetStreams() {
			if s.Protocol() == proto.ProtoIDv2Hop && s.Stat().Direction == network.DirInbound {
				n++
			}
		}
		if n == 0 {
			continue
		}
		if user, ok := a.owner(c.RemotePeer()); ok {
			out[user] += n
		}
	}
	return out
}

func (a *accountACL) owner(p peer.ID) (string, bool) {
	now := a.now()
	a.mu.Lock()
	e, hit := a.cache[p]
	a.mu.Unlock()
	if hit && now.Before(e.expires) {
		return e.userID, e.ok
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	user, ok, err := a.store.PeerOwner(ctx, p.String(), now.Add(-a.ttl))
	if err != nil {
		a.logger.Warn("p2pserver: relay owner lookup failed", "peer_id", p.String(), "error", err)
		return "", false
	}
	a.mu.Lock()
	for k, v := range a.cache {
		if !now.Before(v.expires) {
			delete(a.cache, k)
		}
	}
	a.cache[p] = ownerEntry{userID: user, ok: ok, expires: now.Add(ownerCacheTTL)}
	a.mu.Unlock()
	return user, ok
}

func (a *accountACL) forget(p peer.ID) {
	a.mu.Lock()
	delete(a.cache, p)
	a.mu.Unlock()
}

// relayStats implements relay.MetricsTracer to keep live totals for the
// usage summary.
type relayStats struct {
	reservations atomic.Int64
	circuits     atomic.Int64
}

func (s *relayStats) RelayStatus(bool)                      {}
func (s *relayStats) ConnectionOpened()                     { s.circuits.Add(1) }
func (s *relayStats) ConnectionClosed(time.Duration)        { s.circuits.Add(-1) }
func (s *relayStats) ConnectionRequestHandled(pbv2.Status)  {}
func (s *relayStats) ReservationRequestHandled(pbv2.Status) {}
func (s *relayStats) BytesTransferred(int)                  {}
func (s *relayStats) ReservationClosed(cnt int)             { s.reservations.Add(-int64(cnt)) }
func (s *relayStats) ReservationAllowed(isRenewal bool) {
	if !isRenewal {
		s.reservations.Add(1)
	}
}
