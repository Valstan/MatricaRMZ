#!/usr/bin/env bash
# Приёмка cleanup-old-apks.sh — чистки старых APK.
#
# Что тут ловится: скрипт удаляет файлы на ПРОД-е, поэтому цена ошибки — удалённый
# нужный APK (планшеты не обновятся) или оставленный мусор. Проверяем ровно эти два
# исхода на фикстурах: какой файл остаётся (свежайший по правилам сервера) и что
# трогать нельзя.
#
#   bash scripts/prod-ops/cleanup-old-apks.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SCRIPT_DIR/cleanup-old-apks.sh"
[[ -r "$SUT" ]] || { echo "FAIL: $SUT not found"; exit 1; }

ROOT="$(mktemp -d -t apk-cleanup-test.XXXXXX)"
trap 'rm -rf "$ROOT"' EXIT
PASS=0
FAILED=0

ok() { PASS=$((PASS + 1)); echo "  ok: $1"; }
fail() { FAILED=$((FAILED + 1)); echo "  FAIL: $1"; }

# Создать каталог с набором файлов. Аргументы: имя=размер_байт.
make_dir() {
  local dir="$1"; shift
  mkdir -p "$dir"
  for spec in "$@"; do
    local name="${spec%%=*}" size="${spec##*=}"
    dd if=/dev/zero of="$dir/$name" bs=1 count="$size" status=none
  done
}

run_cleanup() {
  bash "$SUT" "$1" 2>&1
}

remaining() {
  ls -1 "$1" 2>/dev/null | sort | tr '\n' ' '
}

# 1. Три поколения 3.x — остаётся свежайший, старые удалены.
D="$ROOT/case1"; make_dir "$D" "MatricaRMZ-3.111.0.apk=100" "MatricaRMZ-3.112.0.apk=200" "MatricaRMZ-3.113.0.apk=300"
out="$(run_cleanup "$D")"
if [[ "$(remaining "$D")" == "MatricaRMZ-3.113.0.apk " ]]; then
  ok "три версии — остался свежайший"
else
  fail "три версии — осталось: $(remaining "$D")"
fi
if [[ "$out" == *"удалено файлов: 2"* ]]; then
  ok "сказано, что удалено два файла"
else
  fail "не сказано про удалённые файлы: $out"
fi

# 2. Граница схем: 2026.x (CalVer) МЕНЬШЕ 3.x (поколение) — сервер отдаёт поколение.
#    Наивное числовое сравнение выбрало бы CalVer и удалило нужный файл.
D="$ROOT/case2"; make_dir "$D" "MatricaRMZ-2026.814.1503.apk=100" "MatricaRMZ-3.113.0.apk=200"
run_cleanup "$D" >/dev/null
if [[ "$(remaining "$D")" == "MatricaRMZ-3.113.0.apk " ]]; then
  ok "граница эпох — осталось поколение 3.x, а не CalVer"
else
  fail "граница эпох — осталось: $(remaining "$D")"
fi

# 3. Внутри поколения сравнение по числам: 3.9.0 < 3.10.0 (не по строкам!).
D="$ROOT/case3"; make_dir "$D" "MatricaRMZ-3.9.0.apk=100" "MatricaRMZ-3.10.0.apk=200"
run_cleanup "$D" >/dev/null
if [[ "$(remaining "$D")" == "MatricaRMZ-3.10.0.apk " ]]; then
  ok "3.10.0 новее 3.9.0 (сравнение по числам, не по строкам)"
else
  fail "3.9.0/3.10.0 — осталось: $(remaining "$D")"
fi

# 4. Один файл — ничего не удаляется.
D="$ROOT/case4"; make_dir "$D" "MatricaRMZ-3.113.0.apk=100"
run_cleanup "$D" >/dev/null
if [[ "$(remaining "$D")" == "MatricaRMZ-3.113.0.apk " ]]; then
  ok "единственный файл остался"
else
  fail "единственный файл — осталось: $(remaining "$D")"
fi

# 5. Чужой файл в каталоге не трогаем: удаляются только MatricaRMZ-*.apk.
D="$ROOT/case5"; make_dir "$D" "MatricaRMZ-3.112.0.apk=100" "MatricaRMZ-3.113.0.apk=200" "readme.txt=10" "other-1.0.0.apk=10"
run_cleanup "$D" >/dev/null
if [[ "$(remaining "$D")" == *"readme.txt"* && "$(remaining "$D")" == *"other-1.0.0.apk"* && "$(remaining "$D")" == *"MatricaRMZ-3.113.0.apk"* ]]; then
  ok "чужие файлы не тронуты"
else
  fail "чужие файлы — осталось: $(remaining "$D")"
fi

# 6. Непонятное имя (нет версии) — НЕ удаляем ничего, даже если рядом есть понятный.
D="$ROOT/case6"; make_dir "$D" "MatricaRMZ-weird.apk=100" "MatricaRMZ-3.113.0.apk=200"
out="$(run_cleanup "$D")"
if [[ "$(remaining "$D")" == *"MatricaRMZ-weird.apk"* ]]; then
  ok "файл без версии оставлен в покое"
else
  fail "файл без версии удалён — осталось: $(remaining "$D")"
fi
if [[ "$out" == *"не трогаю его"* ]]; then
  ok "о нераспознанном файле сказано вслух"
else
  fail "молчали о нераспознанном файле: $out"
fi

# 7. Пустой каталог и отсутствующий каталог — не ошибка.
D="$ROOT/case7"; mkdir -p "$D"
run_cleanup "$D" >/dev/null && ok "пустой каталог — без ошибки" || fail "пустой каталог вернул ошибку"
run_cleanup "$ROOT/нет-такого" >/dev/null && ok "нет каталога — без ошибки" || fail "нет каталога вернул ошибку"

# 8. Пробный прогон ничего не удаляет.
D="$ROOT/case8"; make_dir "$D" "MatricaRMZ-3.112.0.apk=100" "MatricaRMZ-3.113.0.apk=200"
bash "$SUT" --dry-run "$D" >/dev/null
if [[ "$(remaining "$D")" == "MatricaRMZ-3.112.0.apk MatricaRMZ-3.113.0.apk " ]]; then
  ok "--dry-run ничего не удалил"
else
  fail "--dry-run удалил файлы — осталось: $(remaining "$D")"
fi

echo
echo "Итог: $PASS ок, $FAILED провалов."
[ "$FAILED" -eq 0 ] || exit 1
