#!/usr/bin/env bash
# Runs as root on the relay host, sent by the Deploy p2p-server workflow
# through Tencent Cloud Automation Tools (TAT). The workflow prepends
# P2P_IMAGE, P2P_TAG and P2P_PUBLIC_IP. Idempotent: the first run installs
# Docker and creates the data directory and configuration; every run pulls
# the tag, replaces the container, health-checks it and rolls back to the
# previous tag if the check fails.
set -euo pipefail

: "${P2P_IMAGE:?}" "${P2P_TAG:?}" "${P2P_PUBLIC_IP:?}"
[[ "$P2P_IMAGE" =~ ^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+$ ]] || { echo "invalid P2P_IMAGE" >&2; exit 2; }
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

# Keep the newest images, always including the live and previous tags.
docker image ls "$P2P_IMAGE" --format '{{.Tag}}' | tail -n +$((KEEP + 1)) | while read -r t; do
  [[ "$t" == "$P2P_TAG" || "$t" == "$previous" ]] && continue
  docker image rm "$P2P_IMAGE:$t" >/dev/null 2>&1 || true
done
