# Deploying p2p-server

p2p-server (device registry and relay, see
[server/cmd/p2p-server/README.md](../../server/cmd/p2p-server/README.md)) runs
as a single binary under systemd. The
[Deploy p2p-server](../../.github/workflows/deploy-p2p.yml) workflow builds it
and ships it over SSH on every push to `main` that touches it, or on demand
from the Actions tab.

## Layout on the server

```
/opt/multica-p2p/releases/<sha>/p2p-server   uploaded builds (newest five kept)
/opt/multica-p2p/current -> releases/<sha>   live build
/var/lib/multica-p2p/                        p2p.db, p2p-server.key (relay identity)
/etc/multica-p2p/env                         configuration (see env.example)
/usr/local/sbin/multica-p2p-activate         switch, restart, health check, rollback
```

The service runs as the unprivileged `multica-p2p` user. GitHub Actions logs in
as `multica-deploy`, which can upload releases and run only
`multica-p2p-activate` through sudo.

## First-time setup

1. **Deploy key.** Generate a key pair used only for deploys:

   ```sh
   ssh-keygen -t ed25519 -N "" -C multica-p2p-deploy -f multica-p2p-deploy
   ```

2. **Bootstrap.** Copy this directory to the server and run:

   ```sh
   sudo ./bootstrap.sh "$(cat multica-p2p-deploy.pub)"
   ```

3. **Configure.** Edit `/etc/multica-p2p/env` and set `MULTICA_P2P_PUBLIC_IP`
   to the instance's public IP.

4. **Security group.** Allow inbound `8090/tcp` (registry), `4001/tcp` and
   `4001/udp` (relay), and `22/tcp` for deploys. If the OS firewall is enabled
   (`ufw` / `firewalld`), open the same ports there.

5. **GitHub.** In the repository settings, create the `production`
   environment (optionally with required reviewers) and add these secrets:

   | Secret | Value |
   | --- | --- |
   | `P2P_SSH_HOST` | Server public IP |
   | `P2P_SSH_USER` | `multica-deploy` |
   | `P2P_SSH_KEY` | Contents of `multica-p2p-deploy` (the private key) |
   | `P2P_SSH_KNOWN_HOSTS` | Output of `ssh-keyscan -t ed25519 <server IP>`, checked against the server's own `/etc/ssh/ssh_host_ed25519_key.pub` |

   For an ARM instance, set the repository variable `P2P_GOARCH` to `arm64`.

6. **Deploy.** Run the workflow from the Actions tab, then check from your own
   machine:

   ```sh
   curl -i http://<server IP>:8090/healthz   # 204
   ```

Also check that the server can reach the Multica API, since every new session
is verified there:

```sh
curl -m 10 -s -o /dev/null -w '%{http_code} %{time_total}s\n' https://api.multica.ai/api/me   # 401 is expected
```

## Operations

- Logs: `journalctl -u multica-p2p -f`. A relay usage summary is logged every
  five minutes; refused relay connections are logged with their reason.
- Manual rollback: `sudo /usr/local/sbin/multica-p2p-activate <older sha>`
  (`ls /opt/multica-p2p/releases`).
- After changing `multica-p2p.service` or `activate.sh`, copy this directory to
  the server and re-run `bootstrap.sh`; deploys only replace the binary.
  `/etc/multica-p2p/env` is never overwritten.
- Keep `/var/lib/multica-p2p/p2p-server.key`: losing it changes the relay peer
  ID. Daemons fetch the relay address from the registry, so they recover on
  their next refresh, but existing relay reservations are dropped.
