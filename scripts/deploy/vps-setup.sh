#!/usr/bin/env bash
# Sets up (or updates) the live Bulwark server on an Ubuntu/Debian VPS, including one already running
# other services: it brings its own Node (in $DIR/node, the system Node is left alone), adds its own Caddy
# site file instead of rewriting the Caddyfile, never touches the firewall, and runs with CPU/memory caps.
# Run as root, on the VPS:
#
#   curl -fsSL https://raw.githubusercontent.com/mrnetwork0001/Bulwark/main/scripts/deploy/vps-setup.sh | bash
#   (private repo: scp this file over and run   GITHUB_TOKEN=<read-only token> bash vps-setup.sh)
#
# Result: Bulwark on 127.0.0.1:5317 under systemd, behind Caddy with automatic HTTPS at
# https://bulwark.<ip>.sslip.io (or DOMAIN=…). Put that URL in Vercel as BULWARK_API_URL and redeploy.
#
# Keys: none by default (playbook fixer, neatlogs local only). To enable them, edit /opt/bulwark/.env on
# the VPS and run `systemctl restart bulwark`. They stay on the server; browsers never see them.
# Options (env): DOMAIN, FIXER=playbook|auto (default playbook), ORIGINS (default the Vercel site), BRANCH.
set -euo pipefail

REPO=https://github.com/mrnetwork0001/Bulwark.git
DIR=/opt/bulwark/app
NODE_DIR=/opt/bulwark/node
NODE_VERSION=v26.5.0
BRANCH=${BRANCH:-main}
FIXER=${FIXER:-playbook}
PORT=${PORT:-5317}
ORIGINS=${ORIGINS:-https://usebulwark.vercel.app}
IP=$(curl -fsS4 https://api.ipify.org)
DOMAIN=${DOMAIN:-bulwark.$IP.sslip.io}

echo "==> packages (git, curl, caddy only if missing)"
export DEBIAN_FRONTEND=noninteractive
command -v git >/dev/null && command -v curl >/dev/null && command -v xz >/dev/null || { apt-get update -qq; apt-get install -y -qq git curl xz-utils ca-certificates >/dev/null; }
if ! command -v caddy >/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
mkdir -p /opt/bulwark
if [ "$($NODE_DIR/bin/node -v 2>/dev/null)" != "$NODE_VERSION" ]; then
  rm -rf $NODE_DIR
  curl -fsSL https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz | tar -xJ -C /opt/bulwark
  mv /opt/bulwark/node-$NODE_VERSION-linux-x64 $NODE_DIR
fi
id bulwark >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/bulwark --shell /usr/sbin/nologin bulwark

echo "==> code"
# The token (private repo only) is passed per command and never written to the git config.
auth=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader
  export GIT_CONFIG_VALUE_0="Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)"
fi
if [ ! -d $DIR/.git ]; then
  git "${auth[@]}" clone -q --branch "$BRANCH" $REPO $DIR
else
  git -C $DIR "${auth[@]}" fetch -q origin "$BRANCH" && git -C $DIR reset -q --hard "origin/$BRANCH"
fi
# Entire checkpoints (sanitized on GitHub), so Red can name the session that wrote each weak link.
git -C $DIR "${auth[@]}" fetch -q origin '+refs/entire/*:refs/entire/*' || echo "   (no Entire refs fetched; provenance falls back to git blame)"
[ -f $DIR/.env ] || grep -E '^[A-Z_]+=' $DIR/.env.example | sed 's/=.*/=/' > $DIR/.env
chmod 600 $DIR/.env
chown -R bulwark:bulwark $DIR
unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
chown -R bulwark:bulwark /opt/bulwark
(cd $DIR && sudo -u bulwark env PATH=$NODE_DIR/bin:/usr/bin:/bin HOME=/home/bulwark npm ci --no-audit --no-fund --loglevel=error)

echo "==> service"
cat > /etc/systemd/system/bulwark.service <<EOF
[Unit]
Description=Bulwark (live chaos-engineering server for the hosted app)
After=network-online.target

[Service]
User=bulwark
WorkingDirectory=$DIR
Environment=PATH=$NODE_DIR/bin:/usr/bin:/bin
Environment=HOME=/home/bulwark
Environment=HOST=127.0.0.1
Environment=PORT=$PORT
Environment=BULWARK_PUBLIC=1
Environment=BULWARK_FIXER=$FIXER
Environment=BULWARK_CORS_ORIGINS=$ORIGINS
ExecStart=$NODE_DIR/bin/node $DIR/node_modules/tsx/dist/cli.mjs bulwark/server.ts
Restart=always
RestartSec=3
# Shared server: stay out of the other services' way.
Nice=10
CPUQuota=100%
MemoryMax=1G
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q bulwark
systemctl restart bulwark

echo "==> https (own site file; the Caddyfile is only created when there is none)"
SITE="$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
	}
}"
mkdir -p /etc/caddy/conf.d
if [ ! -s /etc/caddy/Caddyfile ]; then
  printf 'import /etc/caddy/conf.d/*.caddy\n' > /etc/caddy/Caddyfile
elif ! grep -q 'import /etc/caddy/conf.d/\*.caddy' /etc/caddy/Caddyfile; then
  echo "!! /etc/caddy/Caddyfile has no 'import /etc/caddy/conf.d/*.caddy' line. Add it (or paste this block), then reload caddy:"
  echo "$SITE"
fi
printf '%s\n' "# Bulwark live API (systemd: bulwark.service)" "$SITE" > /etc/caddy/conf.d/bulwark.caddy
if caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
else
  echo "!! Caddy config did not validate; removed bulwark.caddy and left Caddy as it was"; rm -f /etc/caddy/conf.d/bulwark.caddy
fi
# Ports 80/443 must be open; the firewall is not changed here.

echo "==> check"
for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:$PORT/api/meta && break; sleep 1; done
curl -fsS http://127.0.0.1:$PORT/api/meta | head -c 160; echo
echo
echo "Bulwark is live at: https://$DOMAIN   (HTTPS can take a minute while Caddy gets the certificate)"
echo "Next: Vercel → useBulwark → Settings → Environment Variables → BULWARK_API_URL = https://$DOMAIN → Redeploy"
