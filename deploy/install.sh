#!/usr/bin/env bash
# Run this on a fresh Ubuntu 22.04 / 24.04 droplet as root or via sudo.
# It installs Docker + Docker Compose, clones the repo, configures the
# environment and brings the stack up.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/jamiddd/new-groww-trade.git}"
APP_DIR="${APP_DIR:-/opt/scalpx}"
DOMAIN="${DOMAIN:-:80}"

echo "==> Updating apt + installing Docker"
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "==> Cloning repo into $APP_DIR"
if [ ! -d "$APP_DIR" ]; then
    git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR/deploy"

if [ ! -f .env ]; then
    echo "==> Creating .env"
    PEPPER=$(openssl rand -base64 48 | tr -d '\n')
    cat > .env <<EOF
DOMAIN=${DOMAIN}
DB_NAME=scalpx
SCALPX_PEPPER=${PEPPER}
EOF
    echo "  .env created. Edit deploy/.env if you need to change DOMAIN."
fi

echo "==> Building & starting ScalpX"
docker compose -f docker-compose.yml --env-file .env up -d --build

echo "==> Done"
echo
echo "Your egress IP is:"
curl -s https://api.ipify.org; echo
echo "==> Whitelist this IP at groww.in -> Profile -> Trading API -> IP Restrictions"
echo "==> Backend running at https://${DOMAIN:-<your-droplet-ip>}/api/"
