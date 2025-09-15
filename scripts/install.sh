#!/usr/bin/env bash
set -euo pipefail

# SillyTavern Remote Backup (8787) one-click installer
# Usage examples:
#   sudo bash install.sh -p 8787 -d '/root/sillytavern/data' -b '/opt/st-remote-backup/backups' -u st -w 2025 --cron "0 8 * * *" --keep 5

PORT=8787
DATA_DIR="/root/sillytavern/data"
BACKUP_DIR="/opt/st-remote-backup/backups"
BASIC_USER="st"
BASIC_PASS="2025"
CRON_EXPR=""
KEEP_NUM=5
NO_FIREWALL=0

# detect sudo (some environments like Termux may not have it)
if command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  SUDO=""
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port) PORT="$2"; shift 2;;
    -d|--data) DATA_DIR="$2"; shift 2;;
    -b|--backup-dir) BACKUP_DIR="$2"; shift 2;;
    -u|--user) BASIC_USER="$2"; shift 2;;
    -w|--pass) BASIC_PASS="$2"; shift 2;;
    --cron) CRON_EXPR="$2"; shift 2;;
    --keep) KEEP_NUM="$2"; shift 2;;
    --no-firewall) NO_FIREWALL=1; shift;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="/opt/st-remote-backup"
PUBLIC_DIR="$APP_DIR/public"

echo "[i] Installing to $APP_DIR (PORT=$PORT, DATA_DIR=$DATA_DIR, BACKUP_DIR=$BACKUP_DIR)"

$SUDO mkdir -p "$APP_DIR" "$PUBLIC_DIR"
$SUDO cp -f "$REPO_DIR/files/server.js" "$APP_DIR/server.js"
$SUDO cp -f "$REPO_DIR/files/public/index.html" "$PUBLIC_DIR/index.html"

cd "$APP_DIR"
if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js is required. Please install Node.js >= 18 and rerun."; exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[!] npm is required. Please install npm and rerun."; exit 1
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "[i] Installing pm2 globally..."
  $SUDO npm i -g pm2 >/dev/null 2>&1 || $SUDO npm i -g pm2
fi

if [[ ! -f package.json ]]; then
  $SUDO npm init -y >/dev/null 2>&1 || true
fi

echo "[i] Installing service dependencies (express tar basic-auth) ..."
$SUDO npm i express tar basic-auth >/dev/null 2>&1 || $SUDO npm i express tar basic-auth

echo "[i] Starting service with pm2 ..."
PORT="$PORT" DATA_DIR="$DATA_DIR" BACKUP_DIR="$BACKUP_DIR" BASIC_USER="$BASIC_USER" BASIC_PASS="$BASIC_PASS" \
  pm2 start "$APP_DIR/server.js" --name st-backup --update-env || pm2 restart st-backup --update-env
pm2 save

if [[ "$NO_FIREWALL" -eq 0 ]]; then
  echo "[i] Trying to open firewall port $PORT (best-effort) ..."
  if command -v ufw >/dev/null 2>&1; then
    $SUDO ufw allow "$PORT"/tcp || true
    $SUDO ufw reload || true
  elif command -v firewall-cmd >/dev/null 2>&1; then
    $SUDO firewall-cmd --permanent --add-port=$PORT/tcp || true
    $SUDO firewall-cmd --reload || true
  else
    echo "[i] No ufw/firewalld detected, skip firewall step."
  fi
fi

if [[ -n "$CRON_EXPR" ]]; then
  echo "[i] Installing daily backup cron ($CRON_EXPR, keep $KEEP_NUM) ..."
  $SUDO tee /usr/local/bin/st-backup.sh >/dev/null <<EOS
#!/usr/bin/env bash
set -euo pipefail
AUTH='$BASIC_USER:$BASIC_PASS'
BASE='http://127.0.0.1:$PORT'
BACKUP_DIR='$BACKUP_DIR'
KEEP=$KEEP_NUM
curl -sS --fail -u "$AUTH" -X POST "$BASE/backup" >/dev/null
mkdir -p "$BACKUP_DIR"
mapfile -t _FILES < <(ls -1t "$BACKUP_DIR"/st-data-*.tar.gz 2>/dev/null || true)
if (( \${#_FILES[@]} > KEEP )); then
  printf '%s\0' "\${_FILES[@]:KEEP}" | xargs -0 -r rm -f --
fi
EOS
  $SUDO chmod +x /usr/local/bin/st-backup.sh
  # install crontab line (append if absent)
  (crontab -l 2>/dev/null || true; echo "$CRON_EXPR /usr/local/bin/st-backup.sh >> /var/log/st-backup.cron.log 2>&1") | crontab -
fi

echo "[ok] Done. Open: http://YOUR_SERVER_IP:$PORT/ (first visit will prompt Basic Auth: $BASIC_USER / $BASIC_PASS)"
