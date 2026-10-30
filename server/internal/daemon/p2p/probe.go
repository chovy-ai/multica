package p2p

import (
	"context"

	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
	msmux "github.com/multiformats/go-multistream"
)

// Bind the standard ping protocol to one existing connection. A peer-wide
// NewStream can select a healthy replacement and mask a stale original path.
type connectionProbeHost struct {
	host.Host
	conn network.Conn
}

func (h connectionProbeHost) NewStream(ctx context.Context, _ peer.ID, protocols ...protocol.ID) (network.Stream, error) {
	st, err := h.conn.NewStream(ctx)
	if err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { _ = st.Reset() })
	defer stop()
	selected, err := msmux.SelectOneOf(protocols, st)
	if err == nil {
		err = st.SetProtocol(selected)
	}
	if err != nil {
		_ = st.Reset()
		return nil, err
	}
	return st, nil
}
