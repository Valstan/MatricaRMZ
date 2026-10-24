#!/usr/bin/env bash
# Устанавливает сторож эгресса движка (контур A) на прод-бокс.
#
# Раскладывает скрипты в /usr/local/lib/neural и юниты в /etc/systemd/system,
# включает таймеры. Ничего не рестартует: движок и ВПН работают как работали.
#
#   bash deploy/neural/install.sh            # установить
#   DRY_RUN=1 bash deploy/neural/install.sh  # только показать, что будет сделано
#
# Запускать на боксе от root (sudo bash deploy/neural/install.sh).
# Почему сторож нужен и что он делает — README.md рядом.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR=/usr/local/lib/neural
UNIT_DIR=/etc/systemd/system
DRY_RUN="${DRY_RUN:-0}"

log() { printf '%s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = "1" ]; then log "  [dry-run] $*"; else "$@"; fi
}

[ "$(id -u)" = "0" ] || { log "нужен root: sudo bash $0"; exit 1; }

log "→ скрипты в $LIB_DIR"
run install -d -m 755 -o root -g root "$LIB_DIR"
for file in tunnel-watchdog.sh engine-probe.py; do
  run install -m 755 -o root -g root "$SCRIPT_DIR/$file" "$LIB_DIR/$file"
  log "  $file"
done

if [ ! -x "$LIB_DIR/refresh-subscription.sh" ]; then
  log "! $LIB_DIR/refresh-subscription.sh не найден — недельный таймер обновления подписки упадёт."
  log "  Скрипт приходит из установки ВПН (neural-vpn), в этом репозитории его нет."
fi

log "→ юниты в $UNIT_DIR"
for unit in tunnel-watchdog.service tunnel-watchdog.timer \
            neural-subscription-refresh.service neural-subscription-refresh.timer; do
  run install -m 644 -o root -g root "$SCRIPT_DIR/$unit" "$UNIT_DIR/$unit"
  log "  $unit"
done

run systemctl daemon-reload
run systemctl enable --now tunnel-watchdog.timer neural-subscription-refresh.timer

log "→ проверка"
if [ "$DRY_RUN" = "1" ]; then log "  [dry-run] дальше не идём"; exit 0; fi
systemctl list-timers tunnel-watchdog.timer neural-subscription-refresh.timer --no-pager | head -3
log "→ один прогон сторожа (провайдера не спрашивает, квоту не тратит)"
systemctl start tunnel-watchdog.service
tail -3 /var/log/neural/tunnel-watchdog.log 2>/dev/null || log "  журнала ещё нет"
log "→ проверка доставки алертов"
"$LIB_DIR/tunnel-watchdog.sh" --test-alert
log "готово. Если тестовое сообщение в Telegram не пришло — смотреть MATRICA_TELEGRAM_* в /etc/matricarmz/matricarmz.env (GOTCHAS M171)."
