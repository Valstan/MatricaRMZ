#!/usr/bin/env bash
# Выкат артефактов клиента на прод: качаем с GitHub CDN прямо на бокс и сверяем
# ПО МАНИФЕСТУ (владелец 21.11.2026: «ну сделай по манифесту»).
#
# Почему не «скачать локально и залить scp»: с бокса CDN отдаёт нормально
# (проверено: 206 + 0.76 с на 1 КБ), а локальный канал в агентском окружении
# резал файл на 4 936 байт. Правило «качать локально» устарело.
#
# Почему нужна сверка: релиз собирался ДВАжды (две сессии нажали тег) — второй
# прогон перезаписал ассеты, и CDN какое-то время отдаёт смесь: новый exe и
# старый latest.yml. Такая пара не годится: манифест описывает другой размер и
# другой sha512, и клиент отвергнет инсталлятор.
#
# ЧТО БЫЛО НЕ ТАК в прежней версии (~/upload/fetch-client-artifacts.sh):
#   - размеры latest.yml и blockmap сверялись КОНСТАНТАМИ ПРЕДЫДУЩЕГО релиза
#     (355 и 145234) — на любом новом релизе сверка была ложной, и скрипт
#     уходил в цикл перекачивания до отказа;
#   - TAG по умолчанию был зашит на v3.125.0 — без правки скрипт качал ПРОШЛЫЙ
#     релиз (и клал его в каталог обновлений сервера);
#   - blockmap не сверялся ни с чем: старый blockmap рядом с новым exe проходил
#     как «согласованная тройка», а клиент потом ловил битое delta-обновление.
#
# Теперь сверка идёт по двум независимым источникам, и ни одной константы:
#   1. МАНИФЕСТ (latest.yml) — размер и sha512 инсталлятора: связывает exe
#      с манифестом, который его описывает;
#   2. ЦИФРЫ РЕЛИЗА (digest ассетов в GitHub API) — sha256 каждого из трёх
#      файлов: связывает каждый файл с тем релизом, который мы выкатываем.
#      Один источник не доверяем: манифест из CDN может быть старым, а цифры
#      релиза — всегда про текущий тег.
#
# Правила сохранены:
#  - staging (/home/valstan/upload) — path-юнит чистки туда не смотрит;
#  - `mv` в пределах одной ФС (stat -c %d) — атомарно, пересканирование манифеста
#    никогда не увидит полузалитый файл (ловушка M40);
#  - `touch` свежих файлов — чистка выбирает оставляемый .exe ПО ВРЕМЕНИ ФАЙЛА (M194 + M196).
#
# Запуск:
#   TAG=v3.140.0 bash scripts/prod-ops/fetch-client-artifacts.sh            # выкат
#   TAG=v3.140.0 bash scripts/prod-ops/fetch-client-artifacts.sh --dry-run  # скачать и сверить, не переносить
#   TAG=v3.140.0 bash scripts/prod-ops/fetch-client-artifacts.sh --verify-only  # только сверка готовой тройки в STAGE
set -euo pipefail

TAG="${TAG:-}"
STAGE="${STAGE:-/home/valstan/upload}"
DEST="${DEST:-/opt/matricarmz/updates}"
GITHUB_REPO="${GITHUB_REPO:-Valstan/MatricaRMZ}"
# Файл цифр релиза в формате sha256sum (`<hex>  <имя>`). Если задан — берём его,
# иначе тянем digest-ы ассетов из GitHub API.
DIGESTS_FILE="${DIGESTS_FILE:-}"
# Подмена curl (тестовая фикстура).
CURL="${CURL:-curl}"
# Сколько раундов перекачки и пауза между ними (тест ставит 0, чтобы не ждать).
ROUNDS="${ROUNDS:-8}"
RETRY_SLEEP="${RETRY_SLEEP:-20}"

DRY_RUN=0
VERIFY_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --verify-only) VERIFY_ONLY=1 ;;
    -h|--help)
      sed -n '2,45p' "$0"
      exit 0
      ;;
    *) echo "НЕПОНЯТНЫЙ АРГУМЕНТ: $arg" >&2; exit 2 ;;
  esac
done

if [ -z "$TAG" ]; then
  echo "Нужен тег релиза: TAG=v3.140.0 bash $0" >&2
  echo "Тег по умолчанию не зашит намеренно: прежняя версия качала v3.125.0 и клала его в прод." >&2
  exit 2
fi

VERSION="${TAG#v}"
EXE="MatricaRMZ-Setup-${VERSION}.exe"
BLOCKMAP="${EXE}.blockmap"
BASE="${BASE:-https://github.com/${GITHUB_REPO}/releases/download/${TAG}}"

log() { printf '[%s] %s\n' "$(date +%FT%T%z)" "$*"; }

fetch() { # url dest
  local url="$1" dest="$2"
  # Без докачки: файл перезаписывается целиком. Иначе «уже полный» файл останется
  # прежней версии (сервер отдаёт 416 на Range за концом файла) — а нам нужен
  # именно свежий манифест, если CDN отдаёт старую сборку.
  "$CURL" -sSL --retry 5 --retry-delay 3 --max-time 1800 -o "$dest" "$url" || true
}

size_of() { [ -f "$1" ] && stat -c%s "$1" || echo 0; }

sha256_of() { sha256sum "$1" | awk '{print $1}'; }

sha512_b64_of() { openssl dgst -sha512 -binary "$1" | base64 -w0; }

# Поля манифеста (latest.yml). Формат electron-builder: `size` и `sha512` лежат
# ВНУТРИ секции files: (с отступом), а `sha512` продублирован ещё и на верхнем
# уровне. Берём верхний уровень, а если его нет — вложенный. `|| true` обязателен:
# при set -e + pipefail отсутствие поля убивало бы скрипт МОЛЧА, без объяснения.
manifest_size() {
  local v
  v="$(grep -E '^size:' "$1" | head -n1 | tr -dc '0-9' || true)"
  [ -n "$v" ] || v="$(grep -E '^[[:space:]]+size:' "$1" | head -n1 | tr -dc '0-9' || true)"
  echo "$v"
}

manifest_sha512() {
  local v
  v="$(grep -E '^sha512:' "$1" | head -n1 | awk '{print $2}' || true)"
  [ -n "$v" ] || v="$(grep -E '^[[:space:]]+sha512:' "$1" | head -n1 | awk '{print $2}' || true)"
  echo "$v"
}

# Цифра релиза (sha256) по имени ассета. Пусто — ассета нет в релизе.
digest_of() {
  [ -n "$DIGESTS_FILE" ] || return 0
  awk -v want="$1" '$2 == want { print $1; exit }' "$DIGESTS_FILE"
}

# Тянем digest-ы ассетов релиза из GitHub API. gh — если есть и авторизован;
# иначе публичный API без токена (лимит 60 запросов в час на IP — хватает).
fetch_release_digests() {
  local out="$1"
  local api="https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${TAG}"
  if command -v gh >/dev/null 2>&1 && gh api "repos/${GITHUB_REPO}/releases/tags/${TAG}" >/dev/null 2>&1; then
    gh api "repos/${GITHUB_REPO}/releases/tags/${TAG}" \
      --jq '.assets[] | select(.digest != null) | "\(.digest | sub("^sha256:"; ""))  \(.name)"' \
      > "$out" && return 0
  fi
  curl -sSL --retry 3 --max-time 60 -H 'Accept: application/vnd.github+json' "$api" \
    | python3 -c '
import json, sys
doc = json.load(sys.stdin)
for asset in doc.get("assets", []):
    digest = asset.get("digest") or ""
    if digest.startswith("sha256:"):
        print(digest[len("sha256:"):], asset["name"])
' > "$out" || return 1
  [ -s "$out" ]
}

# Сверка тройки в STAGE. Печатает, что не так, и возвращает 1 при расхождении.
verify_bundle() {
  local manifest="$STAGE/latest.yml"
  local exe_file="$STAGE/$EXE"
  local blockmap_file="$STAGE/$BLOCKMAP"
  local ok=1

  for f in "$manifest" "$exe_file" "$blockmap_file"; do
    if [ ! -f "$f" ]; then
      log "НЕТ ФАЙЛА: $f"
      ok=0
    fi
  done
  [ "$ok" -eq 1 ] || return 1

  local want_size want_sha
  want_size="$(manifest_size "$manifest")"
  want_sha="$(manifest_sha512 "$manifest")"
  if [ -z "$want_size" ] || [ -z "$want_sha" ]; then
    log "манифест не разобран: нет size/sha512 — $manifest"
    return 1
  fi

  # 1. Манифест ↔ инсталлятор: размер и sha512 из самого манифеста.
  local exe_size got_sha512
  exe_size="$(size_of "$exe_file")"
  if [ "$exe_size" != "$want_size" ]; then
    log "размер exe ($exe_size) не совпадает с манифестом ($want_size) — CDN отдаёт другую сборку"
    ok=0
  fi
  got_sha512="$(sha512_b64_of "$exe_file")"
  if [ "$got_sha512" != "$want_sha" ]; then
    log "sha512 exe не совпадает с манифестом — перекачиваем"
    ok=0
  fi

  # 2. Каждый файл ↔ цифры релиза (sha256 из GitHub API).
  local name file expect actual
  for name in "$EXE" "$BLOCKMAP" latest.yml; do
    case "$name" in
      "$EXE") file="$exe_file" ;;
      "$BLOCKMAP") file="$blockmap_file" ;;
      *) file="$manifest" ;;
    esac
    expect="$(digest_of "$name")"
    if [ -z "$expect" ]; then
      log "в релизе $TAG нет цифры (digest) для ассета $name — сверять нечем"
      ok=0
      continue
    fi
    actual="$(sha256_of "$file")"
    if [ "$actual" != "$expect" ]; then
      log "sha256 $name не совпадает с цифрой релиза (ожидали $expect, получили $actual) — перекачиваем"
      ok=0
    fi
  done

  [ "$ok" -eq 1 ] || return 1
  log "тройка согласована: exe=$exe_size, sha512 совпал с манифестом, sha256 всех трёх совпал с цифрами релиза"
  return 0
}

place_bundle() {
  local dev_stage dev_dest
  dev_stage="$(stat -c %d "$STAGE")"
  dev_dest="$(stat -c %d "$DEST")"
  if [ "$dev_stage" != "$dev_dest" ]; then
    log "ОШИБКА: $STAGE и $DEST на разных ФС"
    exit 1
  fi
  mv "$STAGE/$EXE" "$DEST/$EXE"
  mv "$STAGE/$BLOCKMAP" "$DEST/$BLOCKMAP"
  mv "$STAGE/latest.yml" "$DEST/latest.yml"
  touch "$DEST/$EXE" "$DEST/$BLOCKMAP"

  log "каталог обновлений (свежие сверху):"
  ls -lt "$DEST" | head -n 8
  local f
  for f in "$EXE" "$BLOCKMAP" latest.yml; do
    if [ -f "$DEST/$f" ]; then
      log "  есть: $f ($(stat -c%s "$DEST/$f") байт)"
    else
      log "  НЕТ: $f"
      exit 1
    fi
  done
}

mkdir -p "$STAGE"

# Цифры релиза: один раз на прогон (восемь раундов перекачки не должны выедать
# лимит GitHub API).
if [ -z "$DIGESTS_FILE" ]; then
  tmp_digests="$(mktemp -t release-digests.XXXXXX)"
  trap 'rm -f "$tmp_digests"' EXIT
  if ! fetch_release_digests "$tmp_digests"; then
    log "НЕ УДАЛОСЬ получить цифры релиза $TAG из GitHub API — сверять нечем, стоп"
    exit 1
  fi
  DIGESTS_FILE="$tmp_digests"
  log "цифры релиза получены: $(wc -l < "$DIGESTS_FILE") ассет(ов)"
fi

if [ "$VERIFY_ONLY" -eq 1 ]; then
  if verify_bundle; then
    log "сверка пройдена (файлы в $STAGE не трогаю)"
    exit 0
  fi
  log "сверка не пройдена"
  exit 1
fi

for round in $(seq 1 "$ROUNDS"); do
  # Манифест и blockmap — всегда заново (они должны соответствовать ТЕКУЩЕЙ сборке).
  fetch "$BASE/latest.yml" "$STAGE/latest.yml"
  fetch "$BASE/$BLOCKMAP" "$STAGE/$BLOCKMAP"

  want_sha="$(manifest_sha512 "$STAGE/latest.yml" 2>/dev/null || true)"
  # exe: докачка ЗАПРЕЩЕНА. Если файл уже есть, но его sha512 не совпадает с
  # манифестом, он «склеен» из двух блобов (обрыв + докачка) — длину он имеет
  # правильную, а содержимое мусорное. Такой файл сносим и качаем заново.
  if [ -f "$STAGE/$EXE" ] && [ -n "$want_sha" ]; then
    have_sha="$(sha512_b64_of "$STAGE/$EXE")"
    if [ "$have_sha" != "$want_sha" ]; then
      log "exe на диске не сходится с манифестом — сношу и качаю заново"
      rm -f "$STAGE/$EXE"
    fi
  fi
  if [ ! -f "$STAGE/$EXE" ]; then
    fetch "$BASE/$EXE" "$STAGE/$EXE"
  fi

  log "раунд $round: exe=$(size_of "$STAGE/$EXE") манифест=$(size_of "$STAGE/latest.yml") blockmap=$(size_of "$STAGE/$BLOCKMAP")"

  if verify_bundle; then
    if [ "$DRY_RUN" -eq 1 ]; then
      log "пробный прогон — в $DEST ничего не переношу"
      exit 0
    fi
    place_bundle
    log "готово"
    exit 0
  fi

  log "раунд $round не сошёлся — ждём и перекачиваем"
  sleep "$RETRY_SLEEP"
done

log "не удалось собрать согласованную тройку за $ROUNDS раундов — стоп, разбираться"
exit 1
