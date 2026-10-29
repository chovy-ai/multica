// Package p2p runs a go-libp2p host that links the daemons of one Multica
// account directly.
//
// libp2p owns transports (TCP, QUIC), encryption (Noise/TLS), stream
// multiplexing, LAN discovery (mDNS) and, later, NAT traversal and relaying.
// This package only adds Multica's trust rule: a connection is allowed when
// the remote peer's key was registered on the server by a device of the same
// account.
package p2p

import (
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
)

// LoadOrCreateKey reads the libp2p private key stored at path, creating an
// ed25519 key with owner-only permissions on first use.
func LoadOrCreateKey(path string) (crypto.PrivKey, error) {
	data, err := os.ReadFile(path)
	if err == nil {
		key, err := crypto.UnmarshalPrivateKey(data)
		if err != nil {
			return nil, fmt.Errorf("p2p: key file %s is corrupt: %w", path, err)
		}
		return key, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("p2p: read key: %w", err)
	}

	key, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		return nil, err
	}
	encoded, err := crypto.MarshalPrivateKey(key)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("p2p: create key dir: %w", err)
	}
	// O_EXCL keeps two daemons racing on first start from overwriting each
	// other's key; the loser reads the winner's file.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return LoadOrCreateKey(path)
	}
	if err != nil {
		return nil, fmt.Errorf("p2p: create key file: %w", err)
	}
	if _, err := f.Write(encoded); err != nil {
		f.Close()
		os.Remove(path)
		return nil, fmt.Errorf("p2p: write key file: %w", err)
	}
	if err := f.Close(); err != nil {
		return nil, fmt.Errorf("p2p: close key file: %w", err)
	}
	return key, nil
}

// MarshalPublicKey encodes pub in libp2p's protobuf form, the format the
// server stores and returns.
func MarshalPublicKey(pub crypto.PubKey) ([]byte, error) {
	return crypto.MarshalPublicKey(pub)
}

// PeerIDFromPublicKey decodes a key returned by the server.
func PeerIDFromPublicKey(data []byte) (peer.ID, error) {
	pub, err := crypto.UnmarshalPublicKey(data)
	if err != nil {
		return "", err
	}
	return peer.IDFromPublicKey(pub)
}
