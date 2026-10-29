#!/usr/bin/env bash
# Installed as /usr/local/sbin/multica-p2p-activate by bootstrap.sh and run
# by the deploy user through sudo. Points /opt/multica-p2p/current at an
# uploaded release, restarts the service, and rolls back if the health check
# fails. Keeps the newest five releases.
set -euo pipefail

ROOT=/opt/multica-p2p
HEALTH_URL=${MULTICA_P2P_HEALTH_URL:-http://127.0.0.1:8090/healthz}
KEEP=5

release=${1:-}
if [[ ! "$release" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "usage: multica-p2p-activate <git-sha>" >&2
  exit 2
fi
bin="$ROOT/releases/$release/p2p-server"
if [[ ! -f "$bin" ]]; then
  echo "release $release not uploaded: $bin missing" >&2
  exit 1
fi
chown -R root:root "$ROOT/releases/$release"
chmod 0755 "$ROOT/releases/$release" "$bin"

previous=$(readlink "$ROOT/current" 2>/dev/null || true)

switch_to() {
  ln -sfn "$1" "$ROOT/current.tmp"
  mv -T "$ROOT/current.tmp" "$ROOT/current"
  systemctl restart multica-p2p
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

switch_to "$ROOT/releases/$release"
if ! healthy; then
  echo "release $release failed its health check" >&2
  journalctl -u multica-p2p -n 50 --no-pager >&2 || true
  if [[ -n "$previous" && "$previous" != "$ROOT/releases/$release" ]]; then
    echo "rolling back to $previous" >&2
    switch_to "$previous"
    healthy || echo "previous release is unhealthy too" >&2
  fi
  exit 1
fi
echo "release $release is live"

current=$(readlink "$ROOT/current")
ls -1dt "$ROOT"/releases/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r dir; do
  dir=${dir%/}
  [[ "$dir" == "$current" || "$dir" == "$previous" ]] && continue
  rm -rf -- "$dir"
done
