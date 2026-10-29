# p2p-server

Device registry and relay for direct daemon-to-daemon links. It runs
separately from the Multica API server and does not use its database.

- **Authentication:** a daemon exchanges its Multica login token for a
  registry session token with `POST /v1/sessions`. The service resolves the
  login token with the API server's existing `GET /api/me` (cached by token
  hash for 5 minutes) and issues a 24-hour session; only the session's hash is
  stored. Every other `/v1` endpoint takes the session token. Neither token is
  logged.
- **Relay:** the same process runs a libp2p circuit relay v2 node for devices
  that cannot reach each other directly; daemons hole-punch through it and
  fall back to it when that fails. It only accepts reservations from
  registered devices and only links devices of the same account, at most
  `MULTICA_P2P_RELAY_MAX_CIRCUITS_PER_USER` relayed connections per account at
  a time. Relayed connections have no duration or data limit. Relayed traffic
  stays end-to-end encrypted between the daemons.
- **Storage:** one SQLite file. Devices not refreshed for 24 hours stop being
  listed and are purged hourly with expired sessions; daemons refresh every
  6 hours.

The registry may be served over plain HTTP when no domain is available. The
login token then crosses the network in clear text whenever a session is
issued (about once a day per device); put the service behind HTTPS as soon as
a domain exists.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `MULTICA_API_URL` | — (required) | Multica API server used to resolve tokens |
| `MULTICA_P2P_PUBLIC_IP` | — (required) | Public IP announced as the relay address; cloud VMs only see their private address |
| `MULTICA_P2P_LISTEN` | `:8090` | HTTP listen address |
| `MULTICA_P2P_DB` | `p2p.db` | SQLite file path |
| `MULTICA_P2P_KEY` | `p2p-server.key` | Relay identity key, created on first start; keeps the relay peer ID stable |
| `MULTICA_P2P_LIBP2P_PORT` | `4001` | Relay TCP and QUIC (UDP) port |
| `MULTICA_P2P_RELAY_MAX_CIRCUITS_PER_USER` | `8` | Concurrent relayed connections per account |

## API

| Method | Path | |
| --- | --- | --- |
| `POST` | `/v1/sessions` | `Authorization: Bearer <Multica token>` → `{"session_token", "expires_at"}`; 30 requests per IP per minute |
| `GET` | `/v1/config` | `{"relay": {"peer_id", "addrs"}}` |
| `POST` | `/v1/devices` | Register or refresh a device: `daemon_id`, `profile`, `public_key` (base64 libp2p ed25519 public key), `device_name`, `addrs` (up to 32 multiaddrs). 409 if the key belongs to another account |
| `GET` | `/v1/devices` | `{"devices": [...]}` for the caller's account |
| `DELETE` | `/v1/devices?daemon_id=&profile=` | Remove a device of the caller's account and drop its relay connections |
| `GET` | `/healthz` | 204 when the database and relay are up, 503 otherwise |

Daemons use it when `MULTICA_DAEMON_P2P_SERVER_URL` points here.
