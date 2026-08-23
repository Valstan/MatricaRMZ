#!/usr/bin/env bash
# Installs MatricaRMZ prod-ops scripts and cron jobs on this server.
# Run as the service user (the one that owns the repo clone and runs the cron jobs); uses sudo for /etc/* writes.
# MATRICA_USER defaults to the invoking user; MATRICA_PROD_OPS_SRC defaults to this script's directory.

set -euo pipefail

MATRICA_USER_SET="${MATRICA_USER:-}"
MATRICA_USER="${MATRICA_USER:-$(id -un)}"
SRC_DIR="${MATRICA_PROD_OPS_SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

if [[ "$(id -u)" == 0 && -z "${MATRICA_USER_SET:-}" ]]; then
  echo "run this as the service user (it calls sudo itself), or pass MATRICA_USER=<user> explicitly" >&2
  exit 1
fi

BIN_DIR="/usr/local/sbin"
ETC_DIR="/etc/matricarmz"
PASSPHRASE_FILE="$ETC_DIR/backup.passphrase"
LOG_DIR="/var/log/matricarmz"
STATE_DIR="/var/lib/matricarmz"
CRON_FILE="/etc/cron.d/matricarmz-ops"

log() { printf '[install] %s\n' "$*"; }

[[ -d "$SRC_DIR" ]] || { echo "source dir not found: $SRC_DIR" >&2; exit 1; }

log "creating directories"
sudo install -d -m 750 -o root -g "$MATRICA_USER" "$ETC_DIR"
sudo install -d -m 755 -o "$MATRICA_USER" -g adm "$LOG_DIR"
sudo install -d -m 700 -o "$MATRICA_USER" -g "$MATRICA_USER" "$STATE_DIR"

log "installing scripts to $BIN_DIR"
for f in backup-encrypted.sh audit-deps.sh watch-failed-auth.sh; do
  sudo install -m 0755 "$SRC_DIR/$f" "$BIN_DIR/matricarmz-${f%.sh}"
  log "  $BIN_DIR/matricarmz-${f%.sh}"
done

if [[ ! -s "$PASSPHRASE_FILE" ]]; then
  log "generating backup passphrase (32 random bytes, base64)"
  TMP_PASS="$(mktemp)"
  openssl rand -base64 32 > "$TMP_PASS"
  sudo install -m 640 -o root -g "$MATRICA_USER" "$TMP_PASS" "$PASSPHRASE_FILE"
  shred -u "$TMP_PASS"
  echo
  echo "=================================================================="
  echo "  BACKUP PASSPHRASE (save this OFF-SERVER, e.g. in password mgr):"
  echo
  sudo cat "$PASSPHRASE_FILE"
  echo "=================================================================="
  echo
else
  log "passphrase already exists at $PASSPHRASE_FILE — keeping"
fi

log "writing cron file: $CRON_FILE"
sudo tee "$CRON_FILE" > /dev/null <<EOF
# MatricaRMZ prod ops cron — managed by scripts/prod-ops/install-prod-ops.sh
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=""

# Encrypted backup of PG + ledger to Yandex.Disk — daily at 03:17 MSK
17 3 * * * $MATRICA_USER /usr/local/sbin/matricarmz-backup-encrypted >> $LOG_DIR/backup.log 2>&1

# Weekly pnpm audit of prod deps — Monday 04:23 MSK
23 4 * * 1 $MATRICA_USER /usr/local/sbin/matricarmz-audit-deps >> $LOG_DIR/audit-deps.log 2>&1

# Failed-auth watcher — every 5 minutes
*/5 * * * * $MATRICA_USER /usr/local/sbin/matricarmz-watch-failed-auth >> $LOG_DIR/watch-failed-auth.log 2>&1
EOF
sudo chmod 644 "$CRON_FILE"

log "ensuring log files exist + group adm readable"
for n in backup.log audit-deps.log watch-failed-auth.log; do
  sudo touch "$LOG_DIR/$n"
  sudo chown "$MATRICA_USER:adm" "$LOG_DIR/$n"
  sudo chmod 640 "$LOG_DIR/$n"
done

# the service user needs read access to nginx log (group adm)
if ! id -nG "$MATRICA_USER" | tr ' ' '\n' | grep -qx adm; then
  log "adding $MATRICA_USER to group 'adm' (for nginx log access)"
  sudo usermod -aG adm "$MATRICA_USER"
  log "  NOTE: re-login required for new group to take effect (or use 'newgrp adm')"
fi

log "done. summary:"
ls -la "$BIN_DIR"/matricarmz-* 2>/dev/null || true
ls -la "$CRON_FILE"
echo
echo "Next:"
echo "  1. Save the passphrase printed above OFF-SERVER."
echo "  2. Test each script manually before relying on cron:"
echo "       sudo -Hu $MATRICA_USER /usr/local/sbin/matricarmz-watch-failed-auth"
echo "       sudo -Hu $MATRICA_USER /usr/local/sbin/matricarmz-audit-deps"
echo "       sudo -Hu $MATRICA_USER /usr/local/sbin/matricarmz-backup-encrypted"
echo "  3. systemctl reload cron  (or wait — cron picks /etc/cron.d/* automatically)"
