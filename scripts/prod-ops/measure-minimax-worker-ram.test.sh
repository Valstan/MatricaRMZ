#!/usr/bin/env bash
# Приёмка measure-minimax-worker-ram.sh — замера пика памяти агента MiniMax Code.
#
# Что тут ловится: скрипт шлёт ЖИВОЙ запрос к воркеру на боксе, а бокс — это
# 1536 МБ без swap, где два агента разом = OOM-killer снимает крупнейший процесс.
# Значит цена ошибки — либо «замер ничего не измерил и это выглядит как успех»,
# либо «замер сообщил зелёное, а ядро кого-то сняло». Проверяем ровно эти исходы
# на фикстурах: пик считается по сэмплам, пустой пул отличается от ответа агента,
# а снятый процесс виден в отчёте.
#
# Гоняет НАСТОЯЩИЙ скрипт с шимами `ps` / `curl` / `sleep` / `dmesg` — ни сети,
# ни systemd, ни реального ожидания здесь нет.
#
#   bash scripts/prod-ops/measure-minimax-worker-ram.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SCRIPT_DIR/measure-minimax-worker-ram.sh"
[[ -r "$SUT" ]] || { echo "FAIL: $SUT not found"; exit 1; }

ROOT="$(mktemp -d -t minimax-ram-test.XXXXXX)"
trap 'rm -rf "$ROOT"' EXIT
PASS=0
FAILED=0
ok() { PASS=$((PASS + 1)); echo "  ok: $1"; }
fail() { FAILED=$((FAILED + 1)); echo "  FAIL: $1"; }

BIN="$ROOT/bin"
WORK="$ROOT/work"
mkdir -p "$BIN" "$WORK"

# --- Шимы. Поведением управляют переменные окружения, выставляемые каждым случаем. -----------

# `ps` — строки процессов: агент (`mcode exec`) и воркер (`minimaxWorker/index.js`).
cat > "$BIN/ps" <<'SH'
#!/usr/bin/env bash
args=""
for a in "$@"; do args="$args $a"; done
[[ "$args" == *"-eo"* ]] || exit 0
if [[ "${MATRICA_TEST_AGENT_KB:-0}" != "0" ]]; then
  echo "4242 ${MATRICA_TEST_AGENT_KB:-0} node /home/valstan/.local/bin/mcode exec --permission off"
fi
echo "4243 ${MATRICA_TEST_WORKER_KB:-240000} node /home/valstan/MatricaRMZ/backend-api/dist/minimaxWorker/index.js"
exit 0
SH

# `curl` — ответ воркера; код и тело задаёт случай. Считает вызовы: отдельно запросы
# к /v1/messages (они и есть «замер») и прочие (health в dry-run).
cat > "$BIN/curl" <<'SH'
#!/usr/bin/env bash
out=""
url=""
prev=""
for a in "$@"; do
  [[ "$prev" == "-o" ]] && out="$a"
  [[ "$a" == http* ]] && url="$a"
  prev="$a"
done
if [[ "$url" == *"/v1/messages"* ]]; then
  n=0
  [[ -f "$MATRICA_TEST_MESSAGES_COUNT" ]] && n="$(cat "$MATRICA_TEST_MESSAGES_COUNT")"
  printf '%s' "$((n + 1))" > "$MATRICA_TEST_MESSAGES_COUNT"
fi
if [[ -n "$out" ]]; then printf '%s' "${MATRICA_TEST_BODY:-{\"ok\":true\}}" > "$out"; fi
printf '%s' "${MATRICA_TEST_CODE:-200}"
exit 0
SH

# `sleep` — короткий, чтобы сэмплер не крутился впустую. Именно абсолютный путь:
# `sleep` через PATH вёл бы в сам шим и вызвал бы рекурсию процессов.
printf '#!/usr/bin/env bash\nexec /bin/sleep 0.05\n' > "$BIN/sleep"

# `dmesg` — либо чисто, либо со строкой про снятый процесс.
cat > "$BIN/dmesg" <<'SH'
#!/usr/bin/env bash
if [[ "${MATRICA_TEST_OOM:-0}" == "1" ]]; then
  echo "Jan 22 19:00:00 box kernel: Out of memory: Killed process 4242 (node) total-vm:8123456kB"
fi
exit 0
SH

chmod +x "$BIN"/*

# Запуск скрипта под шимами. Переменные MATRICA_TEST_* приходят из окружения случая.
run_measure() {
  (
    export PATH="$BIN:$PATH"
    export MATRICA_MINIMAX_MEASURE_DIR="$WORK"
    export MATRICA_TEST_MESSAGES_COUNT="$WORK/messages-count"
    # MATRICA_TEST_TRACE=1 — прогнать сам скрипт с трассировкой (для разбора зависаний).
    # Трассировка всегда пишется в work/trace.log — если прогон завис, её видно на диске.
    bash ${MATRICA_TEST_TRACE:+-x} "$SUT" "$@" 2>&1 | tee -a "$WORK/trace.log"
  )
}

# 1. Агент ответил, процесс агента виден — пик посчитан по сэмплам.
out="$(MATRICA_TEST_AGENT_KB=400000 MATRICA_TEST_WORKER_KB=240000 MATRICA_TEST_CODE=200 \
  MATRICA_TEST_BODY='{"ok":true,"content":[{"type":"text","text":"ок"}]}' run_measure)"
rc=$?
if [[ $rc -eq 0 ]]; then
  ok "агент ответил — код возврата 0"
else
  fail "агент ответил — код возврата $rc (ожидался 0)"
fi
if [[ "$out" == *"пик RSS агента (mcode): 400000 КБ"* ]]; then
  ok "пик RSS агента посчитан по сэмплам (400000 КБ)"
else
  fail "пик RSS агента не посчитан: $(printf '%s' "$out" | grep -a 'пик RSS агента' | head -1)"
fi
if [[ "$out" == *"ядро процессы не снимало"* ]]; then
  ok "чистое состояние ядра отражено в отчёте"
else
  fail "нет отметки о чистом состоянии ядра"
fi
if [[ -f "$WORK/minimax-ram-samples.log" ]]; then
  ok "сэмплы записаны"
else
  fail "файл сэмплов не создан"
fi
if [[ "$(cat "$WORK/messages-count" 2>/dev/null || echo 0)" -ge 1 ]]; then
  ok "замер сделал запрос к воркеру"
else
  fail "замер не сделал запрос к воркеру"
fi

# 2. Пул пуст — агент не запускался: это не ошибка замера, но и не замер.
out="$(MATRICA_TEST_AGENT_KB=0 MATRICA_TEST_CODE=503 \
  MATRICA_TEST_BODY='{"error":"no_free_accounts","reason":"pool_empty"}' run_measure)"
rc=$?
if [[ $rc -eq 2 ]]; then
  ok "пустой пул отличен от ответа агента (код 2)"
else
  fail "пустой пул — код возврата $rc (ожидался 2)"
fi
if [[ "$out" == *"ПУЛ ПУСТ"* ]]; then
  ok "в отчёте сказано, что мерить было нечего"
else
  fail "нет отметки о пустом пуле"
fi

# 3. Ядро сняло процесс — замер обязан это показать и не выдать зелёный результат.
out="$(MATRICA_TEST_AGENT_KB=400000 MATRICA_TEST_CODE=200 MATRICA_TEST_BODY='{"ok":true}' \
  MATRICA_TEST_OOM=1 run_measure)"
rc=$?
if [[ $rc -eq 3 ]]; then
  ok "снятый процесс даёт ненулевой код (3), а не «успех»"
else
  fail "снятый процесс — код возврата $rc (ожидался 3)"
fi
if [[ "$out" == *"ЯДРО СНЯЛО ПРОЦЕССЫ"* ]]; then
  ok "отчёт показывает, что ядро сняло процесс"
else
  fail "в отчёте нет отметки о снятом процессе"
fi

# 4. --dry-run ничего не отправляет: аккаунт из пула не тратится.
rm -f "$WORK/minimax-ram-samples.log" "$WORK/messages-count"
out="$(run_measure --dry-run)"
rc=$?
if [[ $rc -eq 0 ]]; then
  ok "dry-run — код возврата 0"
else
  fail "dry-run — код возврата $rc (ожидался 0)"
fi
if [[ ! -f "$WORK/minimax-ram-samples.log" ]]; then
  ok "dry-run ничего не измерял"
else
  fail "dry-run запустил сэмплер"
fi
if [[ ! -f "$WORK/messages-count" ]]; then
  ok "dry-run не отправлял запрос к воркеру (аккаунт не потрачен)"
else
  fail "dry-run отправил запрос к воркеру: $(cat "$WORK/messages-count")"
fi

echo
echo "Итог: PASS=$PASS FAIL=$FAILED"
[[ "$FAILED" -eq 0 ]] || exit 1
