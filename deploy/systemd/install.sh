#!/usr/bin/env bash
# Устанавливает systemd-таймер еженедельной очистки /opt/matricarmz/updates/
# от старых .exe-установщиков. См. README.md рядом.
#
# Шаги:
#   1. копирование cleanup-updates.sh в /usr/local/bin/
#   2. копирование .service и .timer в /etc/systemd/system/
#   3. systemctl daemon-reload
#   4. systemctl enable --now matricarmz-cleanup-updates.timer
#   5. systemctl list-timers + status (smoke-check)
#
# Запускать на проде:
#   bash deploy/systemd/install.sh
#
# Требует sudo (запись в /usr/local/bin, /etc/systemd/system, systemctl).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_SRC="$SCRIPT_DIR/cleanup-updates.sh"
SERVICE_SRC="$SCRIPT_DIR/matricarmz-cleanup-updates.service"
TIMER_SRC="$SCRIPT_DIR/matricarmz-cleanup-updates.timer"

BIN_DST="/usr/local/bin/matricarmz-cleanup-updates.sh"
SERVICE_DST="/etc/systemd/system/matricarmz-cleanup-updates.service"
TIMER_DST="/etc/systemd/system/matricarmz-cleanup-updates.timer"

for f in "$BIN_SRC" "$SERVICE_SRC" "$TIMER_SRC"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: missing source file $f" >&2
    exit 1
  fi
done

echo "==> Installing cleanup script to $BIN_DST"
sudo install -m 0755 "$BIN_SRC" "$BIN_DST"

echo "==> Installing systemd units"
sudo install -m 0644 "$SERVICE_SRC" "$SERVICE_DST"
sudo install -m 0644 "$TIMER_SRC" "$TIMER_DST"

echo "==> systemctl daemon-reload"
sudo systemctl daemon-reload

echo "==> Enabling and starting timer"
sudo systemctl enable --now matricarmz-cleanup-updates.timer

echo "==> Smoke check: dry-run одного прогона скрипта"
sudo "$BIN_DST" --dry-run

echo
echo "==> Timer status:"
sudo systemctl status matricarmz-cleanup-updates.timer --no-pager --lines=0 || true

echo
echo "==> Next scheduled runs:"
sudo systemctl list-timers matricarmz-cleanup-updates.timer --no-pager || true

echo
echo "Done. Скрипт будет запускаться еженедельно по воскресеньям в 03:00."
echo "Логи: sudo journalctl -u matricarmz-cleanup-updates.service"
echo "Ручной прогон: sudo systemctl start matricarmz-cleanup-updates.service"
