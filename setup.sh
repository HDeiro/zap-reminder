#!/usr/bin/env bash
# Installs this project as a systemd service on a Raspberry Pi/Linux host.
# Run from the project directory: ./setup.sh
set -Eeuo pipefail

SERVICE_NAME="whatsapp-bot"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SERVICE_USER="${SUDO_USER:-$(id -un)}"
NODE_BINARY="$(command -v node || true)"
NPM_BINARY="$(command -v npm || true)"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

[[ "$(uname -s)" == "Linux" ]] || fail "This setup script requires Linux with systemd."
command -v systemctl >/dev/null || fail "systemctl was not found."
[[ -n "$NODE_BINARY" ]] || fail "Node.js 20 or newer is required. Install it before running this script."
[[ -n "$NPM_BINARY" ]] || fail "npm was not found."
[[ "$PROJECT_DIR" != *" "* ]] || fail "Install the project in a path without spaces (for example /opt/whatsapp-bot)."

NODE_VERSION="$($NODE_BINARY -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_VERSION" =~ ^[0-9]+$ && "$NODE_VERSION" -ge 20 ]] || fail "Node.js 20 or newer is required (found $($NODE_BINARY --version))."

id "$SERVICE_USER" >/dev/null 2>&1 || fail "The service user '$SERVICE_USER' does not exist."
[[ -f "$PROJECT_DIR/package-lock.json" ]] || fail "package-lock.json is required."
[[ -f "$PROJECT_DIR/config.json" ]] || fail "config.json is required. Copy config.example.json and edit it first."

echo "Installing dependencies and building in $PROJECT_DIR"
cd "$PROJECT_DIR"
"$NPM_BINARY" ci
"$NPM_BINARY" run build

echo "Giving $SERVICE_USER ownership of the project state"
sudo chown -R "$SERVICE_USER":"$(id -gn "$SERVICE_USER")" "$PROJECT_DIR"

echo "Installing systemd service: $UNIT_PATH"
sudo tee "$UNIT_PATH" >/dev/null <<EOF
[Unit]
Description=WhatsApp Campaign Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=$NODE_BINARY $PROJECT_DIR/dist/src/index.js
Restart=always
RestartSec=5
User=$SERVICE_USER
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"

if [[ -d "$PROJECT_DIR/auth" ]] && find "$PROJECT_DIR/auth" -type f -print -quit | grep -q .; then
  sudo systemctl restart "$SERVICE_NAME"
  echo "Service installed, enabled, and started."
  echo "Follow logs with: journalctl -u $SERVICE_NAME -f"
else
  echo "Service installed and enabled, but not started because WhatsApp has not been paired yet."
  echo "Run this once in a terminal to scan the QR code:"
  echo "  cd $PROJECT_DIR && npm start"
  echo "After pairing, start it with: sudo systemctl start $SERVICE_NAME"
fi
