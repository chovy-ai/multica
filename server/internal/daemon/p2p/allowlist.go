package p2p

import (
	"context"
	"sort"
	"sync"

	"github.com/libp2p/go-libp2p/core/peer"
)

// Peer is one device of the account, as registered on the server.
type Peer struct {
	ID         peer.ID `json:"peer_id"`
	DaemonID   string  `json:"daemon_id"`
	Profile    string  `json:"profile"`
	DeviceName string  `json:"device_name"`
}

// FetchFunc returns the authoritative set of devices allowed to connect.
type FetchFunc func(ctx context.Context) ([]Peer, error)

// allowlist is the in-memory view of the account's devices.
type allowlist struct {
	self  peer.ID
	mu    sync.RWMutex
	peers map[peer.ID]Peer
}

func newAllowlist(self peer.ID) *allowlist {
	return &allowlist{self: self, peers: map[peer.ID]Peer{}}
}

func (a *allowlist) allowed(id peer.ID) bool {
	if id == a.self {
		return false
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	_, ok := a.peers[id]
	return ok
}

func (a *allowlist) get(id peer.ID) (Peer, bool) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	p, ok := a.peers[id]
	return p, ok
}

// replace swaps the set and reports which peers were added and removed.
func (a *allowlist) replace(peers []Peer) (added, removed []peer.ID) {
	next := make(map[peer.ID]Peer, len(peers))
	for _, p := range peers {
		if p.ID == "" || p.ID == a.self {
			continue
		}
		next[p.ID] = p
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for id := range next {
		if _, ok := a.peers[id]; !ok {
			added = append(added, id)
		}
	}
	for id := range a.peers {
		if _, ok := next[id]; !ok {
			removed = append(removed, id)
		}
	}
	a.peers = next
	return added, removed
}

func (a *allowlist) list() []Peer {
	a.mu.RLock()
	out := make([]Peer, 0, len(a.peers))
	for _, p := range a.peers {
		out = append(out, p)
	}
	a.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
