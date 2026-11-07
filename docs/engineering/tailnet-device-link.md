# Tailnet path for the device link

The device link runs over libp2p: devices dial each other directly when they
can and otherwise go through the libp2p relay in p2p-server. Two conditions
keep phones on the relay in practice:

- Phones on mobile data sit behind carrier-grade NAT, which libp2p's hole
  punching rarely gets through.
- A Mac running a proxy in TUN mode (Clash Verge and similar) routes all
  public IPv4 through the proxy, which rewrites source ports. The addresses
  other devices observe never accept connections, and hole punching fails.

The tailnet path embeds a Tailscale node (`tailscale.com/tsnet`) in the daemon
and in the phone's link. Tailscale's NAT traversal is stronger than libp2p's,
and on macOS and iOS its sockets bind to the default route's interface
(`IP_BOUND_IF`), so a proxy that only adds more specific routes does not
capture them. When no direct path exists, traffic goes through a DERP relay
that p2p-server runs.

libp2p stays: devices whose app predates the tailnet, or whose tailnet node
is not up yet, keep using it.

## Components

| Component | Where | Role |
| --- | --- | --- |
| Headscale | container next to p2p-server | Tailscale control server: node registration, keys, netmaps |
| DERP and STUN | inside p2p-server | relay and address discovery for tailnet nodes |
| Tailnet credentials | p2p-server `POST /v1/tailnet` | issues a single-use Headscale pre-auth key to a registered device |
| tsnet node | `internal/daemon/p2p` | one userspace node per daemon or phone link |

### Accounts and isolation

Each Multica account is one Headscale user. The policy only accepts traffic
from a user's nodes to the same user's nodes (`autogroup:self`), so a node
can reach only its own account's devices. A device obtains a pre-auth key by
presenting its registry session and its libp2p peer ID, which must already be
registered for that account. The key is single use and expires after ten
minutes; the node keeps its identity in its state directory afterwards.

### Identity

A node's hostname is derived from its libp2p peer ID: `m` followed by the
first 20 hex digits of SHA-256 of the peer ID. The receiving side resolves an
incoming connection with `WhoIs` and maps the reported hostname back to a peer
ID on its allowlist; anything else is refused. This rests on the same trust
as the registry: only the account's devices hold its credentials.

### Streams

The node listens on tailnet TCP port 4100. A connection starts with a header
naming the libp2p protocol it carries; the listener answers with one status
byte and then hands the connection to the handler registered through
`Service.Listen`. Callers of `Service.Dial` and `Service.Listen` do not change.

`Service.Dial` uses the tailnet when the device is online there and falls back
to libp2p otherwise. WireGuard moves a tailnet connection from DERP to a
direct path without breaking it, so tailnet connections never need the
relayed-to-direct WebSocket migration that libp2p connections use.

`Service.Connection` reports direct when either path is direct, and relayed
when the best path is a relay (DERP or libp2p circuit). The relay transfer
limit therefore applies to DERP too.

### DERP without a domain

p2p-server serves DERP over TLS on the host's public IP with a self-signed
certificate. The DERP map pins it with `CertName: "sha256-raw:<hex>"`, so no
domain, CA certificate or ICP filing is needed. The map lists only this
region; Tailscale's public DERP servers are not used. DERP admits only node
keys Headscale knows.

### Logs

tsnet uploads logs to Tailscale by default. The link disables log upload for
the whole process before starting the node.

## Compatibility

- A p2p-server without Headscale configured answers `POST /v1/tailnet` with
  404; devices then stay on libp2p.
- An older phone app talking to a newer daemon, or the reverse, is not online
  in the other's tailnet, so `Dial` uses libp2p.
