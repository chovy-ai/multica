# p2p-server

Device registry for direct daemon-to-daemon links. It runs separately from the
Multica API server and does not use its database.

- **Authentication:** clients send their Multica login token as
  `Authorization: Bearer <token>`. The service resolves it with the API
  server's existing `GET /api/me` and caches the result by token hash for
  5 minutes. The token is never stored or logged. Serve this service over
  HTTPS: it receives full-privilege login tokens.
- **Storage:** one SQLite file. Devices not refreshed for 24 hours stop being
  listed and are purged hourly; daemons refresh every 6 hours.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `MULTICA_API_URL` | — (required) | Multica API server used to resolve tokens |
| `MULTICA_P2P_LISTEN` | `:8090` | HTTP listen address |
| `MULTICA_P2P_DB` | `p2p.db` | SQLite file path |

## API

| Method | Path | |
| --- | --- | --- |
| `POST` | `/v1/devices` | Register or refresh a device: `daemon_id`, `profile`, `public_key` (base64 libp2p ed25519 public key), `device_name` |
| `GET` | `/v1/devices` | `{"devices": [...]}` for the caller's account |
| `DELETE` | `/v1/devices?daemon_id=&profile=` | Remove a device of the caller's account |
| `GET` | `/healthz` | Liveness |

Daemons use it when `MULTICA_DAEMON_P2P_SERVER_URL` points here.
