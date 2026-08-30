#!/usr/bin/env bash
# Turns a reComputer R1025 into the restaurant's Mesero AI appliance.
#
# No packaging here, unlike the Windows build. A single executable exists so a
# restaurant with a Windows PC does not have to install Node; an appliance we
# control already has it, and running from source means an update is a git pull
# rather than a rebuild on ARM.
#
#   sudo ./install.sh
#
set -euo pipefail

APP_USER="${SUDO_USER:-$USER}"
APP_DIR="/opt/mesero-ai"
DATA_DIR="/var/lib/mesero-ai"
REPO="${MESERO_REPO:-https://github.com/gabotrix/mesero-ai.git}"

if [[ $EUID -ne 0 ]]; then
  echo "Corre con sudo." >&2
  exit 1
fi

echo "==> Node"
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "==> Código en $APP_DIR"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone --depth 1 "$REPO" "$APP_DIR"
fi
npm --prefix "$APP_DIR/backend" ci --omit=dev

echo "==> Datos en $DATA_DIR"
# Kept out of the install directory so a `git pull` never overwrites a menu
# somebody edited during service.
mkdir -p "$DATA_DIR/backend" "$DATA_DIR/web"
[[ -f "$DATA_DIR/.env" ]] || cp "$APP_DIR/.env.example" "$DATA_DIR/.env"
[[ -f "$DATA_DIR/backend/menu.json" ]] || cp "$APP_DIR/backend/menu.json" "$DATA_DIR/backend/menu.json"
cp -r "$APP_DIR/web/." "$DATA_DIR/web/"
chown -R "$APP_USER":"$APP_USER" "$DATA_DIR"

echo "==> Servicio"
install -m 644 "$APP_DIR/deploy/recomputer/mesero.service" /etc/systemd/system/mesero.service
sed -i "s/@APP_USER@/$APP_USER/" /etc/systemd/system/mesero.service
systemctl daemon-reload
systemctl enable --now mesero

sleep 2
systemctl --no-pager --lines=12 status mesero || true

IP="$(hostname -I | awk '{print $1}')"
cat <<EOF

Listo.

  Pon la llave del restaurante en   $DATA_DIR/.env      (VENUE_KEY=…)
  Reinicia con                      sudo systemctl restart mesero
  Registro en vivo                  journalctl -u mesero -f

  Esta es la direccion que va en el portal de cada gadget:

      $IP   puerto 8787

EOF
