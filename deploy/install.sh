#!/usr/bin/env bash
# One-shot install / update on Ubuntu (tested target: Oracle Cloud Ubuntu 22.04/24.04).
# Run from the project folder you copied to the server:   sudo bash deploy/install.sh
#
# What it does (safe to re-run for updates):
#   - installs python3-venv, nginx (and node, if WITH_WHATSAPP=1)
#   - creates the system user "ticketengine" and copies the code to /opt/ticket-engine
#     (an existing database/ and WhatsApp session there are never overwritten)
#   - creates the virtualenv and installs requirements.txt (includes gunicorn)
#   - writes /etc/ticket-engine/ticket-engine.env with a random SECRET_KEY (first run only)
#   - installs and starts the systemd service(s) and the nginx site
#   - opens ports 80 and 443 in the instance's iptables (Oracle images block them)
# You still have to open 80/443 in the Oracle Cloud console (VCN security list) yourself.
set -euo pipefail

APP_DIR=/opt/ticket-engine
APP_USER=ticketengine
ENV_DIR=/etc/ticket-engine
WITH_WHATSAPP=${WITH_WHATSAPP:-0}
SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [[ $EUID -ne 0 ]]; then echo "Run with sudo: sudo bash deploy/install.sh" >&2; exit 1; fi

echo "==> Packages"
apt-get update -y
apt-get install -y python3 python3-venv python3-pip nginx rsync iptables-persistent
if [[ $WITH_WHATSAPP == 1 ]]; then
  # whatsapp-web.js needs Node 18+; Ubuntu's own nodejs package is older on 22.04.
  if ! command -v node >/dev/null || (( $(node -p 'process.versions.node.split(".")[0]') < 18 )); then
    echo "    installing Node.js 20 from NodeSource"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
fi

echo "==> User and code"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR/database"
# Code only: never overwrite the live database or a paired WhatsApp session.
rsync -a --delete \
  --exclude venv/ --exclude '__pycache__/' --exclude 'database/' \
  --exclude 'notifications/node_modules/' --exclude 'notifications/.wwebjs_auth/' --exclude 'notifications/.wwebjs_cache/' \
  "$SRC_DIR/" "$APP_DIR/"
# First install: bring the existing database along, if there is one and none on the server yet.
if [[ ! -f "$APP_DIR/database/ticket_engine.db" && -f "$SRC_DIR/database/ticket_engine.db" ]]; then
  cp "$SRC_DIR/database/ticket_engine.db" "$APP_DIR/database/"
fi

echo "==> Python environment"
[[ -d "$APP_DIR/venv" ]] || python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install --upgrade pip >/dev/null
"$APP_DIR/venv/bin/pip" install -r "$APP_DIR/requirements.txt"

if [[ $WITH_WHATSAPP == 1 ]]; then
  echo "==> WhatsApp service dependencies"
  (cd "$APP_DIR/notifications" && npm install --omit=dev)
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 750 "$APP_DIR" "$APP_DIR/database"

echo "==> Environment file"
mkdir -p "$ENV_DIR"
if [[ ! -f "$ENV_DIR/ticket-engine.env" ]]; then
  key=$(python3 -c "import secrets; print(secrets.token_hex(32))")
  sed "s/^SECRET_KEY=.*/SECRET_KEY=$key/" "$APP_DIR/deploy/ticket-engine.env.example" > "$ENV_DIR/ticket-engine.env"
  echo "    wrote $ENV_DIR/ticket-engine.env (with a new random SECRET_KEY)"
else
  echo "    keeping existing $ENV_DIR/ticket-engine.env"
fi
chown root:root "$ENV_DIR/ticket-engine.env"
chmod 600 "$ENV_DIR/ticket-engine.env"

echo "==> systemd"
cp "$APP_DIR/deploy/ticket-engine.service" /etc/systemd/system/
if [[ $WITH_WHATSAPP == 1 ]]; then cp "$APP_DIR/deploy/ticket-engine-whatsapp.service" /etc/systemd/system/; fi
systemctl daemon-reload
systemctl enable ticket-engine >/dev/null
systemctl restart ticket-engine
if [[ $WITH_WHATSAPP == 1 ]]; then systemctl enable ticket-engine-whatsapp >/dev/null; systemctl restart ticket-engine-whatsapp; fi

echo "==> nginx"
cp "$APP_DIR/deploy/nginx-ticket-engine.conf" /etc/nginx/sites-available/ticket-engine
ln -sf /etc/nginx/sites-available/ticket-engine /etc/nginx/sites-enabled/ticket-engine
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx >/dev/null
systemctl reload nginx || systemctl restart nginx

echo "==> Firewall (instance iptables)"
for port in 80 443; do
  iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null \
    || iptables -I INPUT 6 -p tcp -m state --state NEW --dport "$port" -j ACCEPT
done
netfilter-persistent save >/dev/null

echo "==> Checking"
sleep 2
if curl -fsS -o /dev/null http://127.0.0.1:4044/api/settings && curl -fsS -o /dev/null http://127.0.0.1/; then
  echo "    OK: gunicorn on 127.0.0.1:4044 and nginx on port 80 are answering."
else
  echo "    Something isn't answering yet -- see: journalctl -u ticket-engine -n 50 --no-pager" >&2
fi
cat <<MSG

Done. Remaining steps:
  1. Oracle Cloud console -> your VCN -> Security List: add ingress TCP 80 and 443 from 0.0.0.0/0.
  2. Open http://<server-ip>/ and sign in; change the admin password (demo: admin / admin123).
  3. HTTPS (needs a domain pointing at this server):
       sudo apt-get install -y certbot python3-certbot-nginx
       sudo sed -i 's/server_name _;/server_name your.domain.com;/' /etc/nginx/sites-available/ticket-engine
       sudo certbot --nginx -d your.domain.com
     then set SESSION_COOKIE_SECURE=1 in $ENV_DIR/ticket-engine.env and: sudo systemctl restart ticket-engine
MSG
