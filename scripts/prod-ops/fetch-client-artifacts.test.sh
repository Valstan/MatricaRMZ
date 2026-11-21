#!/usr/bin/env bash
# Приёмка fetch-client-artifacts.sh — выкат артефактов клиента на прод.
#
# Что тут ловится: скрипт кладёт на прод то, что потом раздаёт ВСЕМ машинам парка,
# и старая версия сверяла размеры манифеста и blockmap КОНСТАНТАМИ ПРЕДЫДУЩЕГО
# релиза (355 и 145234) — то есть на любом новом релизе сверка была ложной, а
# blockmap не сверялся вообще: старый blockmap рядом с новым exe проходил как
# «согласованная тройка», и клиент ловил битое delta-обновление.
#
# Проверяем на фикстурах ровно те решения, которые принимает скрипт:
#   - exe по размеру и sha512 из МАНИФЕСТА;
#   - exe, манифест и blockmap по sha256 из ЦИФР РЕЛИЗА (digest ассетов);
#   - никаких констант в самом скрипте;
#   - перенос в DEST только после успешной сверки.
#
#   bash scripts/prod-ops/fetch-client-artifacts.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SCRIPT_DIR/fetch-client-artifacts.sh"
[[ -r "$SUT" ]] || { echo "FAIL: $SUT not found"; exit 1; }

ROOT="$(mktemp -d -t fetch-artifacts-test.XXXXXX)"
trap 'rm -rf "$ROOT"' EXIT
PASS=0
FAILED=0

ok() { PASS=$((PASS + 1)); echo "  ok: $1"; }
fail() { FAILED=$((FAILED + 1)); echo "  FAIL: $1"; }

TAG="v9.9.9"
VERSION="9.9.9"
EXE_NAME="MatricaRMZ-Setup-${VERSION}.exe"
BLOCKMAP_NAME="${EXE_NAME}.blockmap"

# Фикстура релиза: «инсталлятор» нужного размера, манифест с его size/sha512,
# blockmap и цифры релиза (sha256 всех трёх, формат sha256sum).
make_fixture() {
  local dir="$1" size="${2:-4096}"
  mkdir -p "$dir"
  head -c "$size" /dev/zero | tr '\0' 'M' > "$dir/$EXE_NAME"
  printf '{"version":"2","files":[{"name":"file","offset":0,"checksums":[]}]}' | gzip > "$dir/$BLOCKMAP_NAME"
  local real_size sha
  real_size="$(stat -c%s "$dir/$EXE_NAME")"
  sha="$(openssl dgst -sha512 -binary "$dir/$EXE_NAME" | base64 -w0)"
  # Манифест повторяет настоящий latest.yml electron-builder: size/sha512 лежат
  # ВНУТРИ files: (с отступом), а sha512 продублирован ещё и на верхнем уровне.
  cat > "$dir/latest.yml" <<YML
version: ${VERSION}
files:
  - url: ${EXE_NAME}
    sha512: ${sha}
    size: ${real_size}
path: ${EXE_NAME}
sha512: ${sha}
releaseDate: '2026-11-21T18:01:02.253Z'
YML
  ( cd "$dir" && sha256sum "$EXE_NAME" "$BLOCKMAP_NAME" latest.yml > digests.txt )
}

# Подмена curl: по URL кладёт нужную фикстуру (сеть в тесте не нужна).
make_fake_curl() {
  local path="$1" fixdir="$2"
  cat > "$path" <<CURL
#!/usr/bin/env bash
dest=""
url=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -o) dest="\$2"; shift 2 ;;
    -*) shift ;;
    *) url="\$1"; shift ;;
  esac
done
case "\$url" in
  */latest.yml) src="$fixdir/latest.yml" ;;
  *.blockmap) src="$fixdir/$BLOCKMAP_NAME" ;;
  *.exe) src="$fixdir/$EXE_NAME" ;;
  *) echo "fake-curl: unknown url \$url" >&2; exit 22 ;;
esac
cp "\$src" "\$dest"
CURL
  chmod +x "$path"
}

# Прогон скрипта на фикстуре. Фикстуры лежат в $1 (файлы релиза), $2 — куда
# скрипт качает (staging), $3 — куда переносит (DEST). Печатает вывод.
run_sut() {
  local fixdir="$1" stage="$2" dest="$3"; shift 3
  local fake_curl="$fixdir/fake-curl.sh"
  make_fake_curl "$fake_curl" "$fixdir"
  TAG="$TAG" STAGE="$stage" DEST="$dest" \
    DIGESTS_FILE="${DIGESTS_OVERRIDE:-$fixdir/digests.txt}" \
    CURL="$fake_curl" ROUNDS=1 RETRY_SLEEP=0 \
    bash "$SUT" "$@" 2>&1
}

placed() { ls -1 "$1" 2>/dev/null | sort | tr '\n' ' '; }

# 1. Без TAG — отказ: старый скрипт качал v3.125.0 и клал его в прод.
out="$(TAG= STAGE="$ROOT/s1-stage" DEST="$ROOT/s1-dest" bash "$SUT" 2>&1)"; code=$?
if [ "$code" -ne 0 ]; then ok "без TAG — отказ (код $code)"; else fail "без TAG — скрипт пошёл качать"; fi
if [[ "$out" == *"Нужен тег релиза"* ]]; then ok "без TAG — сказано, что нужен тег"; else fail "без TAG — непонятный отказ: $out"; fi

# 2. Согласованная тройка — выкат проходит, файлы лежат в DEST.
FIX="$ROOT/f2"; make_fixture "$FIX"; STAGE="$ROOT/s2-stage"; DEST="$ROOT/s2-dest"; mkdir -p "$DEST"
out="$(run_sut "$FIX" "$STAGE" "$DEST")"; code=$?
if [ "$code" -eq 0 ]; then ok "согласованная тройка — выкат прошёл"; else fail "согласованная тройка — отказ: $out"; fi
if [[ "$(placed "$DEST")" == *"$EXE_NAME"* && "$(placed "$DEST")" == *"$BLOCKMAP_NAME"* && "$(placed "$DEST")" == *"latest.yml"* ]]; then
  ok "все три файла перенесены в DEST"
else
  fail "в DEST: $(placed "$DEST")"
fi

# 3. exe не по размеру манифеста — отказ, в DEST ничего не попало.
FIX="$ROOT/f3"; make_fixture "$FIX"; STAGE="$ROOT/s3-stage"; DEST="$ROOT/s3-dest"; mkdir -p "$DEST"
printf 'X' >> "$FIX/$EXE_NAME"
out="$(run_sut "$FIX" "$STAGE" "$DEST")"; code=$?
if [ "$code" -ne 0 ]; then ok "exe не по размеру манифеста — отказ"; else fail "exe не по размеру — выкат прошёл: $out"; fi
if [ -z "$(placed "$DEST")" ]; then ok "при отказе в DEST ничего не попало"; else fail "при отказе в DEST: $(placed "$DEST")"; fi

# 4. exe той же длины, но другим содержимым (склейка после обрыва) — отказ по sha512.
FIX="$ROOT/f4"; make_fixture "$FIX"; STAGE="$ROOT/s4-stage"; DEST="$ROOT/s4-dest"; mkdir -p "$DEST"
size="$(stat -c%s "$FIX/$EXE_NAME")"; head -c "$size" /dev/zero | tr '\0' 'Z' > "$FIX/$EXE_NAME"
out="$(run_sut "$FIX" "$STAGE" "$DEST")"; code=$?
if [ "$code" -ne 0 ]; then ok "exe той же длины, но чужим содержимым — отказ по sha512"; else fail "подмена exe прошла: $out"; fi

# 5. blockmap чужой (старый blockmap от прошлого релиза) — отказ по цифрам релиза.
#    Раньше это ловилось константой размера, которая после нового релиза всегда ложна.
FIX="$ROOT/f5"; make_fixture "$FIX"; STAGE="$ROOT/s5-stage"; DEST="$ROOT/s5-dest"; mkdir -p "$DEST"
printf '{"version":"2","files":[{"name":"file","offset":0,"checksums":["old"]}]}' | gzip > "$FIX/$BLOCKMAP_NAME"
out="$(run_sut "$FIX" "$STAGE" "$DEST")"; code=$?
if [ "$code" -ne 0 ]; then ok "чужой blockmap — отказ"; else fail "чужой blockmap прошёл: $out"; fi

# 6. Манифест чужой (CDN отдаёт старый latest.yml) — отказ по цифрам релиза.
FIX="$ROOT/f6"; make_fixture "$FIX"; STAGE="$ROOT/s6-stage"; DEST="$ROOT/s6-dest"; mkdir -p "$DEST"
printf 'version: 9.9.8\nfiles:\n  - url: %s\n    sha512: xxx\n    size: 4096\n' "$EXE_NAME" > "$FIX/latest.yml"
out="$(run_sut "$FIX" "$STAGE" "$DEST")"; code=$?
if [ "$code" -ne 0 ]; then ok "чужой манифест — отказ"; else fail "чужой манифест прошёл: $out"; fi

# 7. В релизе нет цифры для ассета — сверять нечем, скрипт должен сказать и отказать.
FIX="$ROOT/f7"; make_fixture "$FIX"; STAGE="$ROOT/s7-stage"; DEST="$ROOT/s7-dest"; mkdir -p "$DEST"
grep -v "$BLOCKMAP_NAME" "$FIX/digests.txt" > "$FIX/digests-partial.txt"
out="$(DIGESTS_OVERRIDE="$FIX/digests-partial.txt" run_sut "$FIX" "$STAGE" "$DEST")"; code=$?
if [ "$code" -ne 0 ]; then ok "нет цифры для ассета — отказ"; else fail "отсутствие цифры прошло: $out"; fi
if [[ "$out" == *"нет цифры"* || "$out" == *"digest"* ]]; then ok "про отсутствие цифры сказано вслух"; else fail "молчали об отсутствии цифры: $out"; fi

# 8. Манифест без size/sha512 — разобран не будет, отказ.
FIX="$ROOT/f8"; make_fixture "$FIX"; STAGE="$ROOT/s8-stage"; DEST="$ROOT/s8-dest"; mkdir -p "$DEST"
printf 'version: 9.9.9\nfiles:\n  - url: %s\n' "$EXE_NAME" > "$FIX/latest.yml"
out="$(run_sut "$FIX" "$STAGE" "$DEST")"; code=$?
if [ "$code" -ne 0 ]; then ok "манифест без size/sha512 — отказ"; else fail "битый манифест прошёл: $out"; fi

# 9. Пробный прогон ничего не переносит.
FIX="$ROOT/f9"; make_fixture "$FIX"; STAGE="$ROOT/s9-stage"; DEST="$ROOT/s9-dest"; mkdir -p "$DEST"
run_sut "$FIX" "$STAGE" "$DEST" --dry-run >/dev/null
if [ -z "$(placed "$DEST")" ]; then ok "--dry-run ничего не перенёс"; else fail "--dry-run перенёс: $(placed "$DEST")"; fi

# 10. Режим сверки готовой тройки: успех — и ничего не переносится.
FIX="$ROOT/f10"; make_fixture "$FIX"; STAGE="$ROOT/s10-stage"; DEST="$ROOT/s10-dest"; mkdir -p "$DEST" "$STAGE"
cp "$FIX/$EXE_NAME" "$FIX/$BLOCKMAP_NAME" "$FIX/latest.yml" "$STAGE/"
out="$(run_sut "$FIX" "$STAGE" "$DEST" --verify-only)"; code=$?
if [ "$code" -eq 0 ]; then ok "--verify-only — тройка сошлась"; else fail "--verify-only — отказ: $out"; fi
if [ -z "$(placed "$DEST")" ]; then ok "--verify-only ничего не перенёс"; else fail "--verify-only перенёс: $(placed "$DEST")"; fi

# 11. В скрипте нет констант размеров и зашитого тега прошлого релиза.
#     Комментарии не в счёт: о них в тексте скрипта сказано прямо.
code_only="$(grep -vE '^[[:space:]]*#' "$SUT")"
if ! grep -nE '\b355\b|\b145234\b' <<<"$code_only" >/dev/null; then
  ok "в скрипте нет констант размеров манифеста/blockmap"
else
  fail "в скрипте вернулись константы размеров: $(grep -nE '\b355\b|\b145234\b' <<<"$code_only" | head -3)"
fi
if ! grep -nE 'TAG="\$\{TAG:-[^}]+' <<<"$code_only" >/dev/null; then
  ok "у тега релиза нет значения по умолчанию"
else
  fail "у тега релиза снова есть значение по умолчанию: $(grep -nE 'TAG="\$\{TAG:-[^}]+' <<<"$code_only" | head -3)"
fi

# 12. Сверка идёт по манифесту и цифрам релиза, а не по размеру файла.
if grep -q 'sha512:' "$SUT" && grep -q 'digest' "$SUT"; then
  ok "в скрипте есть сверка по манифесту (sha512) и по цифрам релиза (digest)"
else
  fail "в скрипте нет сверки по манифесту/цифрам релиза"
fi

echo
echo "Итог: $PASS ок, $FAILED провалов."
[ "$FAILED" -eq 0 ] || exit 1
