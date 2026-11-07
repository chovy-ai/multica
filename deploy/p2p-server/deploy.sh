#!/usr/bin/env bash
# Runs as root on the relay host, sent by the Deploy p2p-server workflow
# through Tencent Cloud Automation Tools (TAT). The workflow prepends
# P2P_IMAGE, P2P_TAG, P2P_PUBLIC_IP and HEADSCALE_IMAGE. Idempotent: the
# first run installs Docker and creates the data directories and
# configuration; every run pulls the tag, replaces the container,
# health-checks it and rolls back to the previous tag if the check fails,
# then keeps the Headscale control server running on its pinned image.
set -euo pipefail

: "${P2P_IMAGE:?}" "${P2P_TAG:?}" "${P2P_PUBLIC_IP:?}" "${HEADSCALE_IMAGE:?}"
[[ "$P2P_IMAGE" =~ ^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+$ ]] || { echo "invalid P2P_IMAGE" >&2; exit 2; }
[[ "$HEADSCALE_IMAGE" =~ ^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+:[0-9A-Za-z._-]+$ ]] || { echo "invalid HEADSCALE_IMAGE" >&2; exit 2; }
[[ "$P2P_TAG" =~ ^[0-9a-f]{7,40}$ ]] || { echo "invalid P2P_TAG" >&2; exit 2; }
[[ "$P2P_PUBLIC_IP" =~ ^[0-9a-fA-F.:]+$ ]] || { echo "invalid P2P_PUBLIC_IP" >&2; exit 2; }

NAME=multica-p2p
DATA=/var/lib/multica-p2p
CONF=/etc/multica-p2p/env
STATE=/var/lib/multica-p2p-deploy
HEALTH_URL=http://127.0.0.1:8090/healthz
KEEP=5
# The image runs as this uid; it owns the data directory.
APP_UID=10001

HS_NAME=multica-headscale
HS_DATA=/var/lib/multica-headscale
HS_CONF_DIR=/etc/multica-headscale
HS_HEALTH_URL=http://127.0.0.1:8091/health
HS_UID=10002

if ! command -v docker >/dev/null || ! command -v curl >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q docker.io curl
fi
systemctl enable --now docker >/dev/null

# QUIC (the relay's UDP transport) wants larger socket buffers than the
# kernel default.
cat > /etc/sysctl.d/90-multica-p2p.conf <<'SYSCTL'
net.core.rmem_max=7500000
net.core.wmem_max=7500000
SYSCTL
sysctl -q -p /etc/sysctl.d/90-multica-p2p.conf || true

# The uid has no account on the host, so set ownership numerically.
install -d -m 0700 "$DATA"
chown "$APP_UID:$APP_UID" "$DATA"
install -d -m 0755 /etc/multica-p2p
install -d -m 0700 "$STATE"
if [[ ! -f "$CONF" ]]; then
  cat > "$CONF" <<CONF
MULTICA_API_URL=https://api.multica.ai
MULTICA_P2P_PUBLIC_IP=$P2P_PUBLIC_IP
MULTICA_P2P_LISTEN=:8090
MULTICA_P2P_LIBP2P_PORT=4001
MULTICA_P2P_DB=$DATA/p2p.db
MULTICA_P2P_KEY=$DATA/p2p-server.key
MULTICA_P2P_RELAY_MAX_CIRCUITS_PER_USER=8
CONF
  chmod 0600 "$CONF"
  echo "created $CONF"
elif ! grep -qx "MULTICA_P2P_PUBLIC_IP=$P2P_PUBLIC_IP" "$CONF"; then
  { grep -v '^MULTICA_P2P_PUBLIC_IP=' "$CONF" || true; echo "MULTICA_P2P_PUBLIC_IP=$P2P_PUBLIC_IP"; } > "$CONF.new"
  chmod 0600 "$CONF.new"
  mv -f "$CONF.new" "$CONF"
  echo "updated MULTICA_P2P_PUBLIC_IP in $CONF"
fi

# Tailnet settings are added once, so an existing host gains them and later
# edits on the host are kept. The Headscale API key is added further down,
# after Headscale can issue it.
add_setting() {
  if ! grep -q "^$1=" "$CONF"; then
    echo "$1=$2" >> "$CONF"
    echo "added $1 to $CONF"
  fi
}
add_setting MULTICA_P2P_HEADSCALE_URL http://127.0.0.1:8091
add_setting MULTICA_P2P_TAILNET_CONTROL_URL "http://$P2P_PUBLIC_IP:8091"
add_setting MULTICA_P2P_DERP_PORT 8443
add_setting MULTICA_P2P_STUN_PORT 3478
add_setting MULTICA_P2P_DERP_KEY "$DATA/derp.key"
add_setting MULTICA_P2P_DERP_CERT "$DATA/derp.pem"

previous=$(cat "$STATE/current" 2>/dev/null || true)

run() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # Host networking: the relay needs UDP 4001 and the clients' real
  # addresses, which Docker's port publishing would hide.
  docker run -d --name "$NAME" \
    --restart unless-stopped \
    --network host \
    --env-file "$CONF" \
    -v "$DATA:$DATA" \
    --read-only --cap-drop ALL --security-opt no-new-privileges \
    --log-opt max-size=20m --log-opt max-file=5 \
    "$P2P_IMAGE:$1" >/dev/null
}

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null --max-time 2 "$HEALTH_URL"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

docker pull -q "$P2P_IMAGE:$P2P_TAG"
run "$P2P_TAG"
if ! healthy; then
  echo "tag $P2P_TAG failed its health check" >&2
  docker logs --tail 50 "$NAME" >&2 || true
  if [[ -n "$previous" && "$previous" != "$P2P_TAG" ]]; then
    echo "rolling back to $previous" >&2
    run "$previous"
    healthy || echo "previous tag is unhealthy too" >&2
  fi
  exit 1
fi
echo "$P2P_TAG" > "$STATE/current"
echo "tag $P2P_TAG is live"
docker logs --tail 5 "$NAME" 2>&1 || true

# Headscale, the tailnet control server. It reads the DERP map from
# p2p-server, so it starts after it.
install -d -m 0700 "$HS_DATA"
chown "$HS_UID:$HS_UID" "$HS_DATA"
install -d -m 0755 "$HS_CONF_DIR"
cat > "$HS_CONF_DIR/config.yaml" <<HSCONF
server_url: http://$P2P_PUBLIC_IP:8091
listen_addr: 0.0.0.0:8091
metrics_listen_addr: 127.0.0.1:9091
grpc_listen_addr: 127.0.0.1:50443
grpc_allow_insecure: false
noise:
  private_key_path: /var/lib/headscale/noise_private.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential
derp:
  server:
    enabled: false
  urls:
    - http://127.0.0.1:8090/v1/tailnet/derpmap
  paths: []
  auto_update_enabled: true
  update_frequency: 1h
disable_check_updates: true
node:
  expiry: 0
  ephemeral:
    inactivity_timeout: 30m
database:
  type: sqlite
  sqlite:
    path: /var/lib/headscale/db.sqlite
    write_ahead_log: true
log:
  level: info
  format: text
policy:
  mode: file
  path: /etc/headscale/policy.json
dns:
  magic_dns: false
  base_domain: tailnet.multica.internal
  override_local_dns: false
  nameservers:
    global: []
unix_socket: /var/run/headscale/headscale.sock
unix_socket_permission: "0770"
logtail:
  enabled: false
taildrop:
  enabled: false
HSCONF
# Each account is one Headscale user; its devices reach only each other.
cat > "$HS_CONF_DIR/policy.json" <<'HSPOLICY'
{
  "grants": [
    {"src": ["autogroup:member"], "dst": ["autogroup:self"], "ip": ["*"]}
  ]
}
HSPOLICY
chmod 0644 "$HS_CONF_DIR/config.yaml" "$HS_CONF_DIR/policy.json"

docker pull -q "$HEADSCALE_IMAGE"
running=$(docker inspect -f '{{.Config.Image}}' "$HS_NAME" 2>/dev/null || true)
config_sum=$(cat "$HS_CONF_DIR"/config.yaml "$HS_CONF_DIR"/policy.json | sha256sum | cut -d ' ' -f 1)
if [[ "$running" != "$HEADSCALE_IMAGE" || "$(cat "$STATE/headscale-config" 2>/dev/null || true)" != "$config_sum" ]]; then
  docker rm -f "$HS_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$HS_NAME" \
    --restart unless-stopped \
    --network host \
    --user "$HS_UID:$HS_UID" \
    -v "$HS_CONF_DIR:/etc/headscale:ro" \
    -v "$HS_DATA:/var/lib/headscale" \
    --tmpfs "/var/run/headscale:uid=$HS_UID,gid=$HS_UID,mode=0770" \
    --read-only --cap-drop ALL --security-opt no-new-privileges \
    --log-opt max-size=20m --log-opt max-file=5 \
    "$HEADSCALE_IMAGE" serve >/dev/null
  echo "$config_sum" > "$STATE/headscale-config"
fi
headscale_up=false
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null --max-time 2 "$HS_HEALTH_URL"; then
    headscale_up=true
    break
  fi
  sleep 1
done
if [[ "$headscale_up" != true ]]; then
  echo "headscale failed its health check; devices stay on libp2p" >&2
  docker logs --tail 50 "$HS_NAME" >&2 || true
  exit 1
fi

# p2p-server needs an API key to issue credentials and admit DERP clients.
if ! grep -q '^MULTICA_P2P_HEADSCALE_API_KEY=.' "$CONF"; then
  api_key=$(docker exec "$HS_NAME" headscale apikeys create --expiration 87600h --output json | tr -d '"[:space:]')
  [[ "$api_key" =~ ^[A-Za-z0-9._-]{20,}$ ]] || { echo "headscale returned no API key" >&2; exit 1; }
  { grep -v '^MULTICA_P2P_HEADSCALE_API_KEY=' "$CONF" || true; echo "MULTICA_P2P_HEADSCALE_API_KEY=$api_key"; } > "$CONF.new"
  chmod 0600 "$CONF.new"
  mv -f "$CONF.new" "$CONF"
  echo "created the Headscale API key"
  run "$P2P_TAG"
  healthy || { echo "p2p-server unhealthy after adding the API key" >&2; exit 1; }
fi
echo "headscale $HEADSCALE_IMAGE is live"

# Keep the newest images, always including the live and previous tags. The
# repository also holds the Headscale image under headscale- tags.
docker image ls "$P2P_IMAGE" --format '{{.Tag}}' | { grep -v '^headscale-' || true; } | tail -n +$((KEEP + 1)) | while read -r t; do
  [[ "$t" == "$P2P_TAG" || "$t" == "$previous" ]] && continue
  docker image rm "$P2P_IMAGE:$t" >/dev/null 2>&1 || true
done
