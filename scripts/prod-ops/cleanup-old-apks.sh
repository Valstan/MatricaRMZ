#!/usr/bin/env bash
# Чистка старых APK планшетного клиента: в каталоге остаётся только свежайший.
#
# Почему это отдельный шаг, а не «само разберётся»:
#   - `/updates/file/:name` отдаёт ТОЛЬКО свежайший по версии в имени APK
#     (`getLatestAndroidApkMeta`), старый файл на диске отвечает 404 — ни планшетам,
#     ни откату он не служит (откат планшета — ручная установка APK);
#   - копится он по 48 МБ на каждый релиз: за 3.76–3.84 накопилось 9 файлов ≈434 МБ
#     при 3,2 ГБ свободных, чистка вернула ~386 МБ;
#   - решение владельца от 10.11.2026: старые APK удаляются АВТОМАТИЧЕСКИ, каждый
#     выкат, без подтверждения — чтобы не спрашивать каждый раз.
#
# Сравнение версий — ТО ЖЕ, что у сервера (`compareAppVersion` в
# shared/src/domain/appVersion.ts): сначала эпоха (1.x/2.x → CalVer 2026.x → поколение
# 3.x), внутри эпохи — числа слева направо. Простое числовое сравнение врёт на границе
# схем: 3 < 2026, и «свежий» файл решился бы старым.
#
#   bash scripts/prod-ops/cleanup-old-apks.sh                 # /opt/matricarmz/updates/android
#   bash scripts/prod-ops/cleanup-old-apks.sh <каталог>       # другой каталог
#   bash scripts/prod-ops/cleanup-old-apks.sh --dry-run <каталог>
#
# Что скрипт НЕ делает (никогда):
#   - не трогает ничего, кроме файлов `MatricaRMZ-*.apk`;
#   - не удаляет тот файл, который сервер считает свежайшим;
#   - если версию определить не удалось — не удаляет НИЧЕГО (лучше лишний файл, чем
#     удалённый нужный).
set -euo pipefail

DRY_RUN=0
DIR=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) DIR="$arg" ;;
  esac
done

if [ -z "$DIR" ]; then
  DIR="${MATRICA_UPDATES_DIR:-/opt/matricarmz/updates}/android"
fi

if [ ! -d "$DIR" ]; then
  echo "Каталога нет: $DIR — нечего чистить."
  exit 0
fi

# Эпоха версии: 0 — допоколенная (1.x/2.x), 1 — CalVer (2026.x), 2 — поколение (3.x+).
version_epoch() {
  local major="${1%%.*}"
  case "$major" in
    ''|*[!0-9]*) echo -1; return ;;
  esac
  if [ "$major" -ge 2000 ]; then echo 1; elif [ "$major" -ge 3 ]; then echo 2; else echo 0; fi
}

# Сравнение двух версий: -1 / 0 / 1 (a против b). Неразобранная строка → 0.
version_cmp() {
  local a="$1" b="$2"
  local ea eb
  ea="$(version_epoch "$a")"
  eb="$(version_epoch "$b")"
  if [ "$ea" -lt 0 ] || [ "$eb" -lt 0 ]; then echo 0; return; fi
  if [ "$ea" -ne "$eb" ]; then
    if [ "$ea" -gt "$eb" ]; then echo 1; else echo -1; fi
    return
  fi
  local -a as bs
  IFS='.' read -r -a as <<<"$a"
  IFS='.' read -r -a bs <<<"$b"
  local n=${#as[@]}
  [ "${#bs[@]}" -gt "$n" ] && n=${#bs[@]}
  local i x y
  for (( i = 0; i < n; i++ )); do
    x="${as[i]:-0}"; y="${bs[i]:-0}"
    x="${x//[!0-9]/0}"; y="${y//[!0-9]/0}"
    if [ "$x" -ne "$y" ]; then
      if [ "$x" -gt "$y" ]; then echo 1; else echo -1; fi
      return
    fi
  done
  echo 0
}

# Версия из имени файла: первая тройка чисел (как extractVersionFromFileName).
version_of() {
  local name="$1"
  [[ "$name" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]] && echo "${BASH_REMATCH[1]}" || echo ""
}

KEEP=""
KEEP_VER=""
for f in "$DIR"/MatricaRMZ-*.apk; do
  [ -f "$f" ] || continue
  ver="$(version_of "$(basename "$f")")"
  if [ -z "$ver" ]; then
    echo "ВНИМАНИЕ: не понял версию из имени $(basename "$f") — не трогаю его."
    continue
  fi
  if [ -z "$KEEP" ]; then
    KEEP="$f"; KEEP_VER="$ver"; continue
  fi
  if [ "$(version_cmp "$ver" "$KEEP_VER")" -gt 0 ]; then
    KEEP="$f"; KEEP_VER="$ver"
  fi
done

if [ -z "$KEEP" ]; then
  echo "В $DIR нет ни одного MatricaRMZ-*.apk — нечего чистить."
  exit 0
fi

echo "Оставляю: $(basename "$KEEP") (версия $KEEP_VER)"

freed=0
removed=0
for f in "$DIR"/MatricaRMZ-*.apk; do
  [ -f "$f" ] || continue
  [ "$f" = "$KEEP" ] && continue
  # Файл без разобранной версии удалять НЕЛЬЗЯ: непонятно, свежее он или нет, а
  # цена ошибки — удалённый нужный APK (планшеты не обновятся). Оставляем и говорим.
  ver="$(version_of "$(basename "$f")")"
  if [ -z "$ver" ]; then
    echo "  ВНИМАНИЕ: $(basename "$f") — версия не разобрана, оставляю."
    continue
  fi
  size="$(stat -c%s "$f" 2>/dev/null || echo 0)"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  УДАЛИЛ БЫ: $(basename "$f") ($size байт)"
  else
    rm -f "$f"
    echo "  удалил: $(basename "$f") ($size байт)"
  fi
  freed=$((freed + size))
  removed=$((removed + 1))
done

if [ "$removed" -eq 0 ]; then
  echo "Старых APK нет — каталог уже чистый."
  exit 0
fi

echo "Освобождено: $freed байт (удалено файлов: $removed)."
if [ "$DRY_RUN" -eq 1 ]; then
  echo "Это был пробный прогон — ничего не удалено."
fi
