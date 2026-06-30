#!/usr/bin/env bash
# Удаляет старые установщики `MatricaRMZ-Setup-*.exe` из /opt/matricarmz/updates/,
# оставляя только N последних по mtime (по умолчанию 3).
#
# Запускается systemd-таймером `matricarmz-cleanup-updates.timer` (см. рядом),
# либо вручную:
#
#   bash deploy/systemd/cleanup-updates.sh            # обычный запуск
#   bash deploy/systemd/cleanup-updates.sh --dry-run  # только показать, без удаления
#   KEEP_COUNT=5 bash deploy/systemd/cleanup-updates.sh
#
# Переменные окружения:
#   UPDATES_DIR — путь к каталогу с установщиками (default: /opt/matricarmz/updates)
#   KEEP_COUNT  — сколько последних .exe оставить (default: 3)

set -euo pipefail

UPDATES_DIR="${UPDATES_DIR:-/opt/matricarmz/updates}"
KEEP_COUNT="${KEEP_COUNT:-3}"
PATTERN="MatricaRMZ-Setup-*.exe"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      sed -n '1,15p' "$0"
      exit 0
      ;;
  esac
done

# Safety: запрещаем чистить что-либо вне /opt/*. Защита от опечатки или
# подмены env'а, которая могла бы превратить скрипт в `rm -rf /home/...`.
case "$UPDATES_DIR" in
  /opt/*) : ;;
  *)
    echo "ERROR: refusing to clean directory outside /opt/* (got: $UPDATES_DIR)" >&2
    exit 1
    ;;
esac

if [[ ! -d "$UPDATES_DIR" ]]; then
  echo "ERROR: $UPDATES_DIR does not exist" >&2
  exit 1
fi

if ! [[ "$KEEP_COUNT" =~ ^[0-9]+$ ]] || (( KEEP_COUNT < 1 )); then
  echo "ERROR: KEEP_COUNT must be a positive integer (got: $KEEP_COUNT)" >&2
  exit 1
fi

cd "$UPDATES_DIR"

# `ls -t` сортирует по mtime, новые в начале. Если файлов нет — pattern
# возвращается буквально; ловим это и работаем с пустым массивом.
mapfile -t all_files < <(ls -1t $PATTERN 2>/dev/null | grep -v '^MatricaRMZ-Setup-\*\.exe$' || true)
total=${#all_files[@]}

if (( total <= KEEP_COUNT )); then
  echo "OK: found $total file(s), keep=$KEEP_COUNT, nothing to remove"
  exit 0
fi

to_remove=("${all_files[@]:$KEEP_COUNT}")
kept=("${all_files[@]:0:$KEEP_COUNT}")

echo "Found $total file(s). Will keep newest $KEEP_COUNT, remove $((total - KEEP_COUNT)):"
echo "  kept:"
for f in "${kept[@]}"; do echo "    + $f"; done
echo "  remove:"
for f in "${to_remove[@]}"; do echo "    - $f"; done

if (( DRY_RUN == 1 )); then
  echo "DRY-RUN: nothing actually removed."
  exit 0
fi

removed=0
freed_bytes=0
for f in "${to_remove[@]}"; do
  size=$(stat -c %s "$f" 2>/dev/null || echo 0)
  if rm -f -- "$f"; then
    removed=$((removed + 1))
    freed_bytes=$((freed_bytes + size))
  else
    echo "WARN: failed to remove $f" >&2
  fi
done

freed_mb=$((freed_bytes / 1024 / 1024))
echo "OK: removed $removed file(s), freed ${freed_mb} MB. Kept newest $KEEP_COUNT."
