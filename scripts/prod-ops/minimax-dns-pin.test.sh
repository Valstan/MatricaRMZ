#!/usr/bin/env bash
# Приёмка minimax-dns-pin.py — пина адресов MiniMax в /etc/hosts.
#
# Что тут ловится: скрипт пишет в системный /etc/hosts на боксе, и ошибка в нём
# выглядит как «агент не доходит до MiniMax» — без всякого сообщения об ошибке.
# Именно так и случилось: прежняя версия выкидывала только ЗАГОЛОВОК своей секции,
# но не её строки, поэтому каждый прогон таймера оставлял свои 5 адресов НАД свежими.
# Резолв отдаёт адреса в порядке файла, Node пробует IPv4-адреса по порядку — и мёртвый
# первый адрес съедал весь таймаут агента (120 с) при живом аккаунте из пула.
#
# Проверяем на фикстуре (сеть не нужна): чужие строки целы, секция пина ровно одна,
# повторный прогон ничего не дублирует, `--check` не пишет вовсе.
#
#   bash scripts/prod-ops/minimax-dns-pin.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SCRIPT_DIR/minimax-dns-pin.py"
[[ -r "$SUT" ]] || { echo "FAIL: $SUT not found"; exit 1; }

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 не доступен"; exit 0; }

ROOT="$(mktemp -d -t minimax-pin-test.XXXXXX)"
trap 'rm -rf "$ROOT"' EXIT
PASS=0
FAILED=0
ok() { PASS=$((PASS + 1)); echo "  ok: $1"; }
fail() { FAILED=$((FAILED + 1)); echo "  FAIL: $1"; }

HOSTS_FILE="$ROOT/hosts"
FIXTURE="agent.minimax.io=10.0.0.1,account.minimax.io=10.0.0.2,platform.minimax.io=10.0.0.3,api.minimax.io=10.0.0.4,www.minimax.io=10.0.0.5"

# Пины наших хостов в файле (сколько строк на наши хосты).
our_lines() {
  grep -cE '(^|[[:space:]])(agent|account|platform|api|www)\.minimax\.io([[:space:]]|$)' "$1" 2>/dev/null || echo 0
}

run_pin() {
  MATRICA_MINIMAX_PIN_HOSTS="$HOSTS_FILE" MATRICA_MINIMAX_PIN_FIXTURE="$FIXTURE" python3 "$SUT" "$@" 2>&1
}

# 1. Утечка прежних прогонов: в файле лежат два старых блока (без заголовка) и
#    блок с заголовком — все они на наши хосты. После прогона должен остаться ОДИН блок.
cat > "$HOSTS_FILE" <<'EOF'
127.0.0.1	localhost
10.9.9.9 agent.minimax.io
10.9.9.8 account.minimax.io
10.9.9.7 platform.minimax.io
10.9.9.6 api.minimax.io
10.9.9.5 www.minimax.io
# minimax-pin (обновляется скриптом minimax-dns-pin.py)
10.8.8.9 agent.minimax.io
10.8.8.8 account.minimax.io
10.8.8.7 platform.minimax.io
10.8.8.6 api.minimax.io
10.8.8.5 www.minimax.io
10.7.7.9 agent.minimax.io
192.168.1.10 nas.local
EOF
out="$(run_pin)"
if [[ $? -eq 0 ]]; then
  ok "прогон завершился успешно"
else
  fail "прогон вернул ошибку: $out"
fi
n="$(our_lines "$HOSTS_FILE")"
if [[ "$n" == "5" ]]; then
  ok "после прогона остался ровно один блок из 5 строк (было 15)"
else
  fail "строк на наши хосты: $n (ожидалось 5)"
fi
if [[ "$(grep -c 'minimax-pin' "$HOSTS_FILE")" == "1" ]]; then
  ok "заголовок секции один"
else
  fail "заголовков секции: $(grep -c 'minimax-pin' "$HOSTS_FILE") (ожидался 1)"
fi
if grep -q '10.9.9.9 agent.minimax.io' "$HOSTS_FILE" || grep -q '10.8.8.9 agent.minimax.io' "$HOSTS_FILE"; then
  fail "старые адреса остались в файле"
else
  ok "старые адреса вычищены"
fi
if grep -q '127.0.0.1	localhost' "$HOSTS_FILE" && grep -q '192.168.1.10 nas.local' "$HOSTS_FILE"; then
  ok "чужие строки не тронуты"
else
  fail "чужие строки потеряны: $(cat "$HOSTS_FILE")"
fi
if grep -q '10.0.0.4 api.minimax.io' "$HOSTS_FILE"; then
  ok "свежий адрес записан"
else
  fail "свежий адрес не записан"
fi

# 2. Повторный прогон ничего не дублирует: размер и число наших строк те же.
before="$(wc -c < "$HOSTS_FILE")"
run_pin >/dev/null
after="$(wc -c < "$HOSTS_FILE")"
n2="$(our_lines "$HOSTS_FILE")"
if [[ "$before" == "$after" && "$n2" == "5" ]]; then
  ok "повторный прогон не раздувает файл"
else
  fail "после повторного прогона: строк на наши хосты $n2, размер $before → $after"
fi

# 3. `--check` не пишет вовсе.
before="$(md5sum "$HOSTS_FILE" | cut -d' ' -f1)"
run_pin --check >/dev/null
after="$(md5sum "$HOSTS_FILE" | cut -d' ' -f1)"
if [[ "$before" == "$after" ]]; then
  ok "--check файл не меняет"
else
  fail "--check изменил файл"
fi

# 4. Пин без опознанного адреса для хоста не оставляет его в файле.
HOSTS_FILE="$ROOT/hosts2"
cat > "$HOSTS_FILE" <<'EOF'
127.0.0.1	localhost
EOF
MATRICA_MINIMAX_PIN_HOSTS="$HOSTS_FILE" MATRICA_MINIMAX_PIN_FIXTURE="api.minimax.io=10.0.0.4" python3 "$SUT" >/dev/null 2>&1
n3="$(our_lines "$HOSTS_FILE")"
if [[ "$n3" == "1" ]]; then
  ok "хост без адреса в файл не попадает"
else
  fail "строк на наши хосты: $n3 (ожидалась 1)"
fi
if grep -q '127.0.0.1	localhost' "$HOSTS_FILE"; then
  ok "чужая строка уцелела и при частичном пине"
else
  fail "чужая строка потеряна при частичном пине"
fi

# 5. Частичная проба: хост, для которого живого адреса не нашлось, остаётся на ПРОШЛОМ
#    адресе, а не выкидывается из файла (DNS-адрес для этих хостов заведомо мёртвый).
HOSTS_FILE="$ROOT/hosts3"
cat > "$HOSTS_FILE" <<'EOF'
127.0.0.1	localhost
# minimax-pin (обновляется скриптом minimax-dns-pin.py)
10.6.6.9 agent.minimax.io
10.6.6.8 account.minimax.io
10.6.6.7 platform.minimax.io
10.6.6.6 api.minimax.io
10.6.6.5 www.minimax.io
EOF
MATRICA_MINIMAX_PIN_HOSTS="$HOSTS_FILE" MATRICA_MINIMAX_PIN_FIXTURE="api.minimax.io=10.0.0.4" python3 "$SUT" >/dev/null 2>&1
n4="$(our_lines "$HOSTS_FILE")"
if [[ "$n4" == "5" ]]; then
  ok "частичная проба — все пять хостов остались в файле"
else
  fail "частичная проба — строк на наши хосты: $n4 (ожидалось 5)"
fi
if grep -q '10.6.6.9 agent.minimax.io' "$HOSTS_FILE"; then
  ok "хост без живого адреса остался на прошлом пине"
else
  fail "прошлый пин хоста без живого адреса потерян: $(grep minimax.io "$HOSTS_FILE" | tr '\n' ' ')"
fi
if grep -q '10.0.0.4 api.minimax.io' "$HOSTS_FILE"; then
  ok "хост с живым адресом обновлён"
else
  fail "свежий адрес не записан"
fi

# 6. Запись атомарная: временный файл не остаётся рядом.
if [[ -f "$HOSTS_FILE.minimax-pin.tmp" ]]; then
  fail "временный файл остался рядом с hosts"
else
  ok "временного файла рядом нет"
fi
if [[ "$(head -1 "$HOSTS_FILE" | grep -c '127.0.0.1')" == "1" ]]; then
  ok "файл hosts начинается с исходной первой строки (не с пустоты)"
else
  fail "первая строка hosts не та: $(head -1 "$HOSTS_FILE")"
fi

echo
echo "Итог: PASS=$PASS FAIL=$FAILED"
[[ "$FAILED" -eq 0 ]] || exit 1
