// Package tailnetid names a device's tailnet node after its libp2p peer ID, so
// the registry, the control server and the devices agree on it without
// storing a mapping.
package tailnetid

import (
	"crypto/sha256"
	"encoding/hex"
)

// Hostname is the tailnet hostname of the device with this libp2p peer ID: a
// DNS label, since the control server derives node names from it.
func Hostname(peerID string) string {
	sum := sha256.Sum256([]byte(peerID))
	return "m" + hex.EncodeToString(sum[:10])
}
