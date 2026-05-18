#!/usr/bin/env bash
# Installs MatricaRMZ prod-ops scripts and cron jobs on this server.
# Run as user with sudo (e.g. valstan); will use sudo for /etc/* writes.

set -euo pipefail

SRC_DIR="${MATRICA_PROD_OPS_SRC:-/home/valstan/MatricaRMZ/scripts/prod-ops}"
BIN_DIR="/usr/local/sbin"
ETC_DIR="/etc/matricarmz"
PASSPHRASE_FILE="$ETC_DIR/backup.passphrase"
LOG_DIR="/var/log/matricarmz"
STATE_DIR="/var/lib/matricarmz"
CRON_FILE="/etc/cron.d/matricarmz-ops"

log() { printf '[install] %s\n' "$*"; }

[[ -d "$SRC_DIR" ]] || { echo "source dir not found: $SRC_DIR" >&2; exit 1; }

log "creating directories"
sudo install -d -m 700 "$ETC_DIR"
sudo install -d -m 750 -o root -g adm "$LOG_DIR"
sudo install -d -m 700 "$STATE_DIR"

log "installing scripts to $BIN_DIR"
for f in backup-encrypted.sh audit-deps.sh watch-failed-auth.sh; do
  sudo install -m 0755 "$SRC_DIR/$f" "$BIN_DIR/matricarmz-${f%.sh}"
  log "  $BIN_DIR/matricarmz-${f%.sh}"
done

if [[ ! -s "$PASSPHRASE_FILE" ]]; then
  log "generating backup passphrase (32 random bytes, base64)"
  TMP_PASS="$(mktemp)"
  openssl rand -base64 32 > "$TMP_PASS"
  sudo install -m 600 -o root -g root "$TMP_PASS" "$PASSPHRASE_FILE"
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
17 3 * * * valstan /usr/local/sbin/matricarmz-backup-encrypted >> $LOG_DIR/backup.log 2>&1

# Weekly pnpm audit of prod deps — Monday 04:23 MSK
23 4 * * 1 valstan /usr/local/sbin/matricarmz-audit-deps >> $LOG_DIR/audit-deps.log 2>&1

# Failed-auth watcher — every 5 minutes
*/5 * * * * valstan /usr/local/sbin/matricarmz-watch-failed-auth >> $LOG_DIR/watch-failed-auth.log 2>&1
EOF
sudo chmod 644 "$CRON_FILE"

log "ensuring log files exist + group adm readable"
for n in backup.log audit-deps.log watch-failed-auth.log; do
  sudo touch "$LOG_DIR/$n"
  sudo chown valstan:adm "$LOG_DIR/$n"
  sudo chmod 640 "$LOG_DIR/$n"
done

# valstan needs read access to nginx log (group adm)
if ! id -nG valstan | tr ' ' '\n' | grep -qx adm; then
  log "adding valstan to group 'adm' (for nginx log access)"
  sudo usermod -aG adm valstan
  log "  NOTE: re-login required for new group to take effect (or use 'newgrp adm')"
fi

log "done. summary:"
ls -la "$BIN_DIR"/matricarmz-* 2>/dev/null || true
ls -la "$CRON_FILE"
echo
echo "Next:"
echo "  1. Save the passphrase printed above OFF-SERVER."
echo "  2. Test each script manually before relying on cron:"
echo "       sudo -u valstan /usr/local/sbin/matricarmz-watch-failed-auth"
echo "       sudo -u valstan /usr/local/sbin/matricarmz-audit-deps"
echo "       sudo -u valstan /usr/local/sbin/matricarmz-backup-encrypted"
echo "  3. systemctl reload cron  (or wait — cron picks /etc/cron.d/* automatically)"
