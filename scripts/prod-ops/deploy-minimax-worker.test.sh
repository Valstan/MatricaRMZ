#!/usr/bin/env bash
# Приёмка deploy-minimax-worker.sh — раскатки воркера MiniMax на проде.
#
# Что тут ловится: раскатка по умолчанию не должна менять НИЧЕГО, а включение звена
# раньше времени сжигает аккаунты пула Кармана впустую (каждый вопрос ИИваныча уходит
# в MiniMax, не доходит и уходит на платного страхователя). Поэтому главная гарантия
# смоука — «по умолчанию sudo/systemctl не вызываются вообще».
#
# Гоняет НАСТОЯЩИЙ скрипт с шимами `curl` / `sudo` / `systemctl` / `python3` / `mcode` /
# `sleep` — ни сети, ни systemd, ни реального прода тут нет.
#
#   bash scripts/prod-ops/deploy-minimax-worker.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SCRIPT_DIR/deploy-minimax-worker.sh"
[[ -r "$SUT" ]] || { echo "FAIL: $SUT not found"; exit 1; }

ROOT="$(mktemp -d -t deploy-minimax-worker-test.XXXXXX)"
trap 'rm -rf "$ROOT"' EXIT
PASS=0
FAILED=0
ok() { PASS=$((PASS + 1)); echo "  ok: $1"; }
fail() { FAILED=$((FAILED + 1)); echo "  FAIL: $1"; }

BIN="$ROOT/bin"
mkdir -p "$BIN"
CALLS="$ROOT/calls.log"

# --- Шимы. Поведением управляют переменные окружения, выставляемые каждым случаем. -----------

# `curl` — ответ воркера на /health. Маткарь: сам curl пишет в отдельный файл, чтобы
# маркер «звонили в систему» оставался чистым.
cat > "$BIN/curl" <<'SH'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "${MATRICA_TEST_CALLS:-/dev/null}.curl"
[[ "${MATRICA_TEST_HEALTH_FAIL:-0}" == "1" ]] && exit 22
DEFAULT_HEALTH='{"ok":true,"service":"minimax-worker","pool":"configured","cli":"mcode","model":"minimax/MiniMax-M3.1-Flash","paused":false,"account":null,"agentsActive":0,"agentsQueued":0}'
printf '%s' "${MATRICA_TEST_HEALTH:-$DEFAULT_HEALTH}"
exit 0
SH

# `sudo` — пишет вызов в маркер и выполняет остаток команды (тогда срабатывает и шим
# `systemctl`, и видно, что именно ушло в систему).
cat > "$BIN/sudo" <<'SH'
#!/usr/bin/env bash
printf 'sudo %s\n' "$*" >> "${MATRICA_TEST_CALLS:-/dev/null}"
shift
if [[ $# -gt 0 ]]; then exec "$@"; fi
exit 0
SH

# `systemctl` — принимает и молчит, вызов в маркер.
cat > "$BIN/systemctl" <<'SH'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "${MATRICA_TEST_CALLS:-/dev/null}"
exit 0
SH

# `python3` — проверка пина адресов: код возврата задаёт случай (0 — пин на месте).
cat > "$BIN/python3" <<'SH'
#!/usr/bin/env bash
printf 'python3 %s\n' "$*" >> "${MATRICA_TEST_CALLS:-/dev/null}.py"
exit "${MATRICA_TEST_PIN_RC:-0}"
SH

# `sleep` — мгновенный: тест держит ширину окна ожидания, а не ждёт её.
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/sleep"
# `mcode` — CLI MiniMax Code на месте (иначе проверка «CLI доступен» мигала бы).
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/mcode"

chmod +x "$BIN"/*

# Фикстуры репозитория, env-файла и каталога профилей.
make_repo() { # repo есть_код(0/1) роль_worker(0/1)
  local repo="$1"
  rm -rf "$repo"
  mkdir -p "$repo/backend-api/dist/minimaxWorker" "$repo/scripts/prod-ops" "$repo/deploy/systemd"
  [[ "$2" == "1" ]] && echo "// worker" > "$repo/backend-api/dist/minimaxWorker/index.js"
  echo "# pin" > "$repo/scripts/prod-ops/minimax-dns-pin.py"
  # Юнит в клоне — всегда свой (скрипт берёт его из клона, а не из соседнего каталога).
  if [[ "$3" == "1" ]]; then
    cat > "$repo/deploy/systemd/matricarmz-minimax-worker.service" <<'EOF'
[Service]
Environment=MATRICA_INSTANCE_ROLE=worker
EOF
  else
    cat > "$repo/deploy/systemd/matricarmz-minimax-worker.service" <<'EOF'
[Service]
Environment=HOST=127.0.0.1
EOF
  fi
  return 0
}

make_env() { # path провайдер
  printf 'MATRICA_AI_PROVIDER=%s\nKARMAN_MINIMAX_TOKEN=skm_что-то\nMINIMAX_CLI=mcode\n' "$2" > "$1"
}

REPO=""
ENVF=""
ACCOUNTS=""

run_sut() {
  (
    export PATH="$BIN:$PATH"
    export MATRICA_REPO_DIR="$REPO"
    export MATRICA_ENV_FILE="$ENVF"
    export MINIMAX_ACCOUNTS_DIR="$ACCOUNTS"
    export MINIMAX_CLI="mcode"
    export MATRICA_MINIMAX_WORKER_URL="http://127.0.0.1:3010/v1/messages"
    export MATRICA_TEST_CALLS="$CALLS"
    bash "$SUT" "$@"
  ) 2>&1
}

echo "deploy-minimax-worker.sh smoke"

# --- 1. Dry-run по умолчанию НИЧЕГО не меняет ---------------------------------------------
REPO="$ROOT/repo1"; make_repo "$REPO" 1 1
ENVF="$ROOT/env1"; make_env "$ENVF" minimax
ACCOUNTS="$ROOT/accounts1"; mkdir -p "$ACCOUNTS"
rm -f "$CALLS"
out="$(run_sut)"
rc=$?
if [[ ! -f "$CALLS" ]]; then
  ok "dry-run не звал ни sudo, ни systemctl (маркера вызовов нет)"
else
  fail "dry-run звал систему: $(tr '\n' ';' < "$CALLS")"
fi
if [[ "$rc" -eq 0 ]]; then
  ok "dry-run с зелёными проверками — код возврата 0"
else
  fail "dry-run с зелёными проверками — код возврата $rc (ожидался 0)"
fi

# --- 2. Dry-run печатает план и перечисленные проверки -------------------------------------
if [[ "$out" == *"План раскатки"* ]]; then
  ok "в dry-run напечатан план раскатки"
else
  fail "в dry-run нет плана раскатки"
fi
if [[ "$out" == *"Проверки"* && "$out" == *"OK:"* ]]; then
  ok "в dry-run перечислены проверки с результатом OK"
else
  fail "в dry-run нет перечисления проверок: $(printf '%s' "$out" | head -5)"
fi
if [[ "$out" == *"matricarmz-minimax-worker.service"* ]]; then
  ok "в плане назван юнит воркера"
else
  fail "в плане не назван юнит воркера"
fi

# --- 3. Блокер: нет кода воркера → раскатывать нечего -------------------------------------
REPO="$ROOT/repo3"; make_repo "$REPO" 0 1
ENVF="$ROOT/env3"; make_env "$ENVF" minimax
ACCOUNTS="$ROOT/accounts3"; mkdir -p "$ACCOUNTS"
out="$(run_sut)"
rc=$?
if [[ "$rc" -eq 1 ]]; then
  ok "нет backend-api/dist/minimaxWorker/index.js — код возврата 1"
else
  fail "нет кода воркера — код возврата $rc (ожидался 1)"
fi
if [[ "$out" == *"deploy-backend.sh"* ]]; then
  ok "в блокере есть подсказка про deploy-backend.sh"
else
  fail "в блокере нет подсказки про deploy-backend.sh"
fi

# --- 4. --apply включает и поднимает воркер -----------------------------------------------
REPO="$ROOT/repo4"; make_repo "$REPO" 1 1
ENVF="$ROOT/env4"; make_env "$ENVF" minimax
ACCOUNTS="$ROOT/accounts4"; mkdir -p "$ACCOUNTS"
rm -f "$CALLS"
out="$(run_sut --apply)"
rc=$?
if [[ -f "$CALLS" ]] && grep -q "sudo systemctl enable --now matricarmz-minimax-worker.service" "$CALLS"; then
  ok "--apply вызвал sudo systemctl enable --now для юнита воркера"
else
  fail "--apply не включил юнит воркера: $(tr '\n' ';' < "$CALLS" 2>/dev/null)"
fi
if [[ "$out" == *"воркер поднят"* && "$out" == *"matricarmz-minimax-worker.service"* ]]; then
  ok "в выводе --apply видно, что воркер включён и поднят"
else
  fail "в выводе --apply нет отметки о поднятом воркере"
fi
if [[ "$rc" -eq 0 ]]; then
  ok "--apply с отвечающим воркером — код возврата 0"
else
  fail "--apply с отвечающим воркером — код возврата $rc (ожидался 0)"
fi
if grep -q "install-backend.sh" "$CALLS" 2>/dev/null; then
  fail "--apply выполнил install-backend.sh — юниты ставит отдельный шаг"
else
  ok "--apply не трогал systemd-юниты (install-backend.sh только напечатан)"
fi

# --- 5. Ответ /health от шимы curl попадает в вывод ----------------------------------------
if [[ "$out" == *"minimax-worker"* && "$out" == *"pool"* ]]; then
  ok "ответ /health от шимы curl попал в вывод"
else
  fail "ответа /health в выводе нет"
fi
if [[ "$out" == *"agentsActive"* && "$out" == *"agentsQueued"* ]]; then
  ok "в выводе зафиксированы agentsActive/agentsQueued"
else
  fail "в выводе нет agentsActive/agentsQueued"
fi

# --- 6. Токен пула не печатается ------------------------------------------------------------
if [[ "$out" != *"skm_"* ]]; then
  ok "значение токена пула в выводе нет"
else
  fail "токен пула утёк в вывод: $(printf '%s' "$out" | grep -a 'skm_' | head -1)"
fi

# --- 7. Коды возврата dry-run: мягкие замечания — 2, зелёные проверки — 0 -------------------
# Звено не включено и каталога профилей нет — это НЕ блокер.
REPO="$ROOT/repo7"; make_repo "$REPO" 1 1
ENVF="$ROOT/env7"; make_env "$ENVF" deepseek
ACCOUNTS="$ROOT/accounts7-missing"
out="$(run_sut)"
rc=$?
if [[ "$rc" -eq 2 ]]; then
  ok "мягкие замечания в dry-run — код возврата 2"
else
  fail "мягкие замечания в dry-run — код возврата $rc (ожидался 2)"
fi
if [[ "$out" == *"звено не включено"* ]]; then
  ok "в отчёте сказано, что звено не включено"
else
  fail "в отчёте нет отметки о невключённом звене"
fi
if [[ "$out" == *"каталог профилей не создан"* ]]; then
  ok "в отчёте назван отсутствующий каталог профилей"
else
  fail "в отчёте не назван отсутствующий каталог профилей"
fi
# Роль worker в юните тоже мягкое замечание (юнит не второй раз поднимет фоновые задачи).
REPO="$ROOT/repo7b"; make_repo "$REPO" 1 0
ENVF="$ROOT/env7"; make_env "$ENVF" minimax
ACCOUNTS="$ROOT/accounts7"; mkdir -p "$ACCOUNTS"
out="$(run_sut)"
rc=$?
if [[ "$rc" -eq 2 && "$out" == *"MATRICA_INSTANCE_ROLE=worker"* ]]; then
  ok "юнит без MATRICA_INSTANCE_ROLE=worker — мягкое замечание, код 2"
else
  fail "юнит без роли worker: код возврата $rc (ожидался 2), роль в отчёте: $(printf '%s' "$out" | grep -ac 'MATRICA_INSTANCE_ROLE=worker')"
fi
# Всё зелёное — снова 0.
REPO="$ROOT/repo7c"; make_repo "$REPO" 1 1
ENVF="$ROOT/env7c"; make_env "$ENVF" minimax
ACCOUNTS="$ROOT/accounts7c"; mkdir -p "$ACCOUNTS"
out="$(run_sut --dry-run)"
rc=$?
if [[ "$rc" -eq 0 ]]; then
  ok "явный --dry-run с зелёными проверками — код возврата 0"
else
  fail "явный --dry-run с зелёными проверками — код возврата $rc (ожидался 0)"
fi

# --- 8. Сломанный пин: --apply включает юниты пина ----------------------------------------
REPO="$ROOT/repo8"; make_repo "$REPO" 1 1
ENVF="$ROOT/env8"; make_env "$ENVF" minimax
ACCOUNTS="$ROOT/accounts8"; mkdir -p "$ACCOUNTS"
rm -f "$CALLS"
out="$(MATRICA_TEST_PIN_RC=1 run_sut --apply)"
rc=$?
if [[ "$out" == *"пин адресов MiniMax не на месте"* ]]; then
  ok "сломанный пин назван в отчёте"
else
  fail "сломанный пин не назван в отчёте"
fi
if grep -q "matricarmz-minimax-dns-pin.timer" "$CALLS" 2>/dev/null \
   && grep -q "matricarmz-minimax-dns-pin.service" "$CALLS" 2>/dev/null; then
  ok "--apply включил таймер пина и прогнал сам пин"
else
  fail "--apply не включил юниты пина: $(tr '\n' ';' < "$CALLS" 2>/dev/null)"
fi

# --- 9. Воркер не поднялся: --apply честно падает ------------------------------------------
REPO="$ROOT/repo9"; make_repo "$REPO" 1 1
ENVF="$ROOT/env9"; make_env "$ENVF" minimax
ACCOUNTS="$ROOT/accounts9"; mkdir -p "$ACCOUNTS"
out="$(MATRICA_TEST_HEALTH_FAIL=1 run_sut --apply)"
rc=$?
if [[ "$rc" -ne 0 ]]; then
  ok "воркер не поднялся — --apply выходит с ненулевым кодом ($rc)"
else
  fail "воркер не поднялся, а --apply вернул 0"
fi
if [[ "$out" == *"journalctl -u matricarmz-minimax-worker.service"* ]]; then
  ok "в отчёте сказано, где смотреть журнал"
else
  fail "в отчёте нет подсказки про journalctl"
fi

# --- 10. Справка печатается и ничего не меняет ---------------------------------------------
rm -f "$CALLS"
out="$(run_sut --help)"
rc=$?
if [[ "$rc" -eq 0 && "$out" == *"Коды возврата"* ]]; then
  ok "--help печатает справку и выходит с 0"
else
  fail "--help вернул $rc или справка пустая"
fi
if [[ ! -f "$CALLS" ]]; then
  ok "--help ничего не менял"
else
  fail "--help звал систему: $(tr '\n' ';' < "$CALLS")"
fi

echo
echo "Итог: PASS=$PASS FAIL=$FAILED"
[[ "$FAILED" -eq 0 ]] || exit 1
