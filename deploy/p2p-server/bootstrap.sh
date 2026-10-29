#!/usr/bin/env bash
# One-time (and re-runnable) server setup for p2p-server. Run as root from a
# checkout of this directory:
#
#   sudo ./bootstrap.sh "<deploy public key>"
#
# Creates the service user, the deploy user that GitHub Actions logs in as,
# the directory layout, /etc/multica-p2p/env (only if missing), the systemd
# unit, and the activate helper the deploy user may run through sudo. Re-run
# it after changing multica-p2p.service or activate.sh: deploys only replace
# the binary.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi
deploy_key=${1:-}
if [[ -z "$deploy_key" ]]; then
  echo "usage: sudo $0 \"<deploy ssh public key>\"" >&2
  exit 2
fi
here=$(cd "$(dirname "$0")" && pwd)

id multica-p2p >/dev/null 2>&1 || useradd --system --home-dir /var/lib/multica-p2p --shell /usr/sbin/nologin multica-p2p
id multica-deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash multica-deploy

install -d -m 0755 -o root -g root /opt/multica-p2p
install -d -m 0755 -o multica-deploy -g multica-deploy /opt/multica-p2p/releases
install -d -m 0700 -o multica-p2p -g multica-p2p /var/lib/multica-p2p
install -d -m 0750 -o root -g multica-p2p /etc/multica-p2p
if [[ ! -f /etc/multica-p2p/env ]]; then
  install -m 0640 -o root -g multica-p2p "$here/env.example" /etc/multica-p2p/env
  echo "created /etc/multica-p2p/env: set MULTICA_P2P_PUBLIC_IP before the first deploy"
fi

install -d -m 0700 -o multica-deploy -g multica-deploy /home/multica-deploy/.ssh
auth=/home/multica-deploy/.ssh/authorized_keys
touch "$auth"
grep -qxF "$deploy_key" "$auth" || echo "$deploy_key" >> "$auth"
chown multica-deploy:multica-deploy "$auth"
chmod 0600 "$auth"

install -m 0755 -o root -g root "$here/activate.sh" /usr/local/sbin/multica-p2p-activate
sudoers=$(mktemp)
echo "multica-deploy ALL=(root) NOPASSWD: /usr/local/sbin/multica-p2p-activate" > "$sudoers"
visudo -cf "$sudoers" >/dev/null
install -m 0440 -o root -g root "$sudoers" /etc/sudoers.d/multica-p2p-deploy
rm -f "$sudoers"

install -m 0644 -o root -g root "$here/multica-p2p.service" /etc/systemd/system/multica-p2p.service
systemctl daemon-reload
systemctl enable multica-p2p >/dev/null

command -v curl >/dev/null || echo "warning: curl is missing; the deploy health check needs it" >&2
echo "bootstrap done. Open 8090/tcp, 4001/tcp and 4001/udp in the security group, then run the deploy workflow."
