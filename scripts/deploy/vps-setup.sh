#!/usr/bin/env bash
# Sets up (or updates) the live Bulwark server on a fresh Ubuntu/Debian VPS. Run as root, on the VPS:
#
#   curl -fsSL https://raw.githubusercontent.com/mrnetwork0001/Bulwark/main/scripts/deploy/vps-setup.sh | bash
#   (private repo: scp this file over and run   GITHUB_TOKEN=<read-only token> bash vps-setup.sh)
#
# Result: Bulwark on 127.0.0.1:5317 under systemd, behind Caddy with automatic HTTPS at
# https://<ip-with-dashes>.sslip.io (or DOMAIN=…). Put that URL in Vercel as BULWARK_API_URL and redeploy.
#
# Keys: none by default (playbook fixer, neatlogs local only). To enable them, edit /opt/bulwark/.env on
# the VPS and run `systemctl restart bulwark`. They stay on the server; browsers never see them.
# Options (env): DOMAIN, FIXER=playbook|auto (default playbook), ORIGINS (default the Vercel site), BRANCH.
set -euo pipefail

REPO=https://github.com/mrnetwork0001/Bulwark.git
DIR=/opt/bulwark
BRANCH=${BRANCH:-main}
FIXER=${FIXER:-playbook}
ORIGINS=${ORIGINS:-https://usebulwark.vercel.app}
IP=$(curl -fsS4 https://api.ipify.org)
DOMAIN=${DOMAIN:-${IP//./-}.sslip.io}

echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https ufw >/dev/null
if ! node -v 2>/dev/null | grep -q '^v26'; then
  curl -fsSL https://deb.nodesource.com/setup_26.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
id bulwark >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/bulwark --shell /usr/sbin/nologin bulwark

echo "==> code"
# The token (private repo only) is passed per command and never written to the git config.
auth=()
[ -n "${GITHUB_TOKEN:-}" ] && auth=(-c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)")
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
git config --system --add safe.directory $DIR
(cd $DIR && sudo -u bulwark npm ci --no-audit --no-fund --loglevel=error)

echo "==> service"
cat > /etc/systemd/system/bulwark.service <<EOF
[Unit]
Description=Bulwark (live chaos-engineering server for the hosted app)
After=network-online.target

[Service]
User=bulwark
WorkingDirectory=$DIR
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=5317
Environment=BULWARK_PUBLIC=1
Environment=BULWARK_FIXER=$FIXER
Environment=BULWARK_CORS_ORIGINS=$ORIGINS
ExecStart=$DIR/node_modules/.bin/tsx bulwark/server.ts
Restart=always
RestartSec=2
MemoryMax=1500M
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q bulwark
systemctl restart bulwark

echo "==> https"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:5317 {
    flush_interval -1
  }
}
EOF
systemctl reload caddy || systemctl restart caddy
ufw allow 22/tcp >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw --force enable >/dev/null

echo "==> check"
for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:5317/api/meta && break; sleep 1; done
curl -fsS http://127.0.0.1:5317/api/meta | head -c 160; echo
echo
echo "Bulwark is live at: https://$DOMAIN   (HTTPS can take a minute while Caddy gets the certificate)"
echo "Next: Vercel → useBulwark → Settings → Environment Variables → BULWARK_API_URL = https://$DOMAIN → Redeploy"
