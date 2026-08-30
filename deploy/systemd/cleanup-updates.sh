#!/usr/bin/env bash
# Удаляет старые сборки клиентов из /opt/matricarmz/updates/, оставляя только
# N последних по mtime: установщики `MatricaRMZ-Setup-*.exe` в корне каталога и
# APK планшетного клиента `MatricaRMZ-*.apk` в подкаталоге `android/`.
#
# Запускается systemd-таймером `matricarmz-cleanup-updates.timer` (см. рядом),
# либо вручную:
#
#   bash deploy/systemd/cleanup-updates.sh            # обычный запуск
#   bash deploy/systemd/cleanup-updates.sh --dry-run  # только показать, без удаления
#   KEEP_COUNT=5 bash deploy/systemd/cleanup-updates.sh
#
# Переменные окружения:
#   UPDATES_DIR    — путь к каталогу со сборками (default: /opt/matricarmz/updates)
#   KEEP_COUNT     — сколько последних .exe оставить (default: 3)
#   KEEP_COUNT_APK — сколько последних .apk оставить (default: KEEP_COUNT)

set -euo pipefail

UPDATES_DIR="${UPDATES_DIR:-/opt/matricarmz/updates}"
KEEP_COUNT="${KEEP_COUNT:-3}"
KEEP_COUNT_APK="${KEEP_COUNT_APK:-$KEEP_COUNT}"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      sed -n '1,17p' "$0"
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

for name in KEEP_COUNT KEEP_COUNT_APK; do
  value="${!name}"
  if ! [[ "$value" =~ ^[0-9]+$ ]] || (( value < 1 )); then
    echo "ERROR: $name must be a positive integer (got: $value)" >&2
    exit 1
  fi
done

# Чистит один каталог по одному шаблону. Каталога нет — не ошибка: APK-канал
# появляется только после первого android-релиза.
prune_dir() {
  local dir="$1" pattern="$2" keep="$3" label="$4"

  if [[ ! -d "$dir" ]]; then
    echo "OK [$label]: $dir отсутствует, чистить нечего"
    return 0
  fi

  cd "$dir"

  # `ls -t` сортирует по mtime, новые в начале. Если файлов нет — pattern
  # возвращается буквально; ловим это и работаем с пустым массивом.
  local all_files=()
  mapfile -t all_files < <(ls -1t $pattern 2>/dev/null | grep -vFx "$pattern" || true)
  local total=${#all_files[@]}

  if (( total <= keep )); then
    echo "OK [$label]: found $total file(s), keep=$keep, nothing to remove"
    return 0
  fi

  local to_remove=("${all_files[@]:$keep}")
  local kept=("${all_files[@]:0:$keep}")

  echo "[$label] Found $total file(s). Will keep newest $keep, remove $((total - keep)):"
  echo "  kept:"
  for f in "${kept[@]}"; do echo "    + $f"; done
  echo "  remove:"
  for f in "${to_remove[@]}"; do echo "    - $f"; done

  if (( DRY_RUN == 1 )); then
    echo "DRY-RUN [$label]: nothing actually removed."
    return 0
  fi

  local removed=0 freed_bytes=0 size
  for f in "${to_remove[@]}"; do
    size=$(stat -c %s "$f" 2>/dev/null || echo 0)
    if rm -f -- "$f"; then
      removed=$((removed + 1))
      freed_bytes=$((freed_bytes + size))
    else
      echo "WARN [$label]: failed to remove $f" >&2
    fi
  done

  echo "OK [$label]: removed $removed file(s), freed $((freed_bytes / 1024 / 1024)) MB. Kept newest $keep."
}

prune_dir "$UPDATES_DIR" "MatricaRMZ-Setup-*.exe" "$KEEP_COUNT" "installers"
prune_dir "$UPDATES_DIR/android" "MatricaRMZ-*.apk" "$KEEP_COUNT_APK" "android"
