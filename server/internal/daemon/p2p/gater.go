package p2p

import (
	"github.com/libp2p/go-libp2p/core/control"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"
)

// accountGater admits only devices on the allowlist. The decision is made in
// InterceptSecured, after the security handshake has proven the remote owns
// its peer ID, so every path (mDNS, inbound, explicit dial) passes through
// the same check.
type accountGater struct {
	allow *allowlist
	// isRelay admits the registry's relay node, which is not a device but
	// carries relayed connections and hole-punch coordination.
	isRelay func(peer.ID) bool
	// onUnknown is called when an unlisted peer completes a handshake, so a
	// device that registered moments ago is picked up without waiting for
	// the periodic refresh. It must not block.
	onUnknown func(peer.ID)
}

func (g *accountGater) admitted(p peer.ID) bool {
	return g.allow.allowed(p) || (g.isRelay != nil && g.isRelay(p))
}

func (g *accountGater) InterceptPeerDial(p peer.ID) bool { return g.admitted(p) }

func (g *accountGater) InterceptAddrDial(peer.ID, ma.Multiaddr) bool { return true }

func (g *accountGater) InterceptAccept(network.ConnMultiaddrs) bool { return true }

func (g *accountGater) InterceptSecured(_ network.Direction, p peer.ID, _ network.ConnMultiaddrs) bool {
	if g.admitted(p) {
		return true
	}
	if g.onUnknown != nil {
		g.onUnknown(p)
	}
	return false
}

func (g *accountGater) InterceptUpgraded(network.Conn) (bool, control.DisconnectReason) {
	return true, 0
}
