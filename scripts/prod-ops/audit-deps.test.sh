#!/usr/bin/env bash
# Smoke test for audit-deps.sh — the weekly dependency alert. Its failure mode is the one that
# already bit us: the log said "alert sent" while Telegram was disabled, four weeks running.
# Runs the real script with shimmed `pnpm` (fixture audit JSON) and shimmed `curl`, so nothing
# leaves the machine.
#
#   bash scripts/prod-ops/audit-deps.test.sh
#
# Needs python3 (the script's own parser). Exits 0 with SKIP when it is missing (Windows dev
# boxes have no python), so it is a CI gate, not a local obstacle.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SCRIPT_DIR/audit-deps.sh"
[[ -r "$SUT" ]] || { echo "FAIL: $SUT not found"; exit 1; }

# Проверяем python3 запуском, а не наличием: в Windows-окружении `command -v python3` находит
# заглушку Microsoft Store, которая существует и не работает (выходит с 49). Гейт по наличию
# здесь пропустил бы тест внутрь и дал бы каскад ложных отказов вместо честного SKIP.
if ! python3 -c 'print("ok")' >/dev/null 2>&1; then
  echo "SKIP: python3 not usable here — audit-deps.sh parses its report with it"
  exit 0
fi

ROOT="$(mktemp -d -t audit-test.XXXXXX)"
trap 'rm -rf "$ROOT"' EXIT
PASS=0
FAILED=0

ok() { PASS=$((PASS + 1)); echo "  ok: $1"; }
fail() { FAILED=$((FAILED + 1)); echo "  FAIL: $1"; }

mkdir -p "$ROOT/bin" "$ROOT/repo/scripts/prod-ops"
cp "$SUT" "$ROOT/repo/scripts/prod-ops/audit-deps.sh"

# `pnpm audit --prod --json` → фикстура; `curl` → запись «отправлено» в файл вместо сети.
cat > "$ROOT/bin/pnpm" <<'SH'
#!/usr/bin/env bash
cat "$MATRICA_TEST_AUDIT_JSON"
SH
cat > "$ROOT/bin/curl" <<'SH'
#!/usr/bin/env bash
printf 'sent\n' >> "$MATRICA_TEST_CURL_LOG"
exit "${MATRICA_TEST_CURL_EXIT:-0}"
SH
chmod +x "$ROOT/bin/pnpm" "$ROOT/bin/curl"
export PATH="$ROOT/bin:$PATH"

fixture() { # $1 — module, $2 — severity
  cat > "$ROOT/audit.json" <<JSON
{
  "advisories": {
    "1": { "module_name": "$1", "severity": "$2", "title": "test finding", "url": "https://example.invalid/a" }
  },
  "metadata": { "vulnerabilities": { "info": 0, "low": 0, "moderate": 0, "high": 1, "critical": 0 } }
}
JSON
}

accepted() { # $1 — module, $2 — until
  cat > "$ROOT/accepted.json" <<JSON
{ "accepted": [ { "module": "$1", "url": "u", "severity": "high", "path": "p", "reason": "r", "until": "$2" } ] }
JSON
}

run_audit() {
  : > "$ROOT/curl.log"
  MATRICA_TEST_AUDIT_JSON="$ROOT/audit.json" \
  MATRICA_TEST_CURL_LOG="$ROOT/curl.log" \
  MATRICA_REPO_DIR="$ROOT/repo" \
  MATRICA_ENV_FILE="$ROOT/none.env" \
  MATRICA_AUDIT_ACCEPTED_FILE="$ROOT/accepted.json" \
  MATRICA_OPS_TELEGRAM_ENABLED="${TELEGRAM_ENABLED:-true}" \
  MATRICA_TELEGRAM_BOT_TOKEN="t" \
  MATRICA_TELEGRAM_ALERT_CHAT_ID="c" \
    bash "$ROOT/repo/scripts/prod-ops/audit-deps.sh" 2>&1
}

sent_count() { wc -l < "$ROOT/curl.log" | tr -d ' '; }

echo "audit-deps.sh smoke"

# 1. Неучтённая high-находка — алерт уходит.
fixture "some-lib" "high"
accepted "other-lib" "2099-01-01"
OUT="$(run_audit)"
[[ "$(sent_count)" == "1" ]] && ok "unaccepted high alerts" || fail "unaccepted high did not alert"
grep -q "alert sent" <<<"$OUT" && ok "log says sent when it was sent" || fail "log lost the send"

# 2. Та же находка, принятая осознанно и не просроченная — алерта нет, но в отчёте она видна.
fixture "some-lib" "high"
accepted "some-lib" "2099-01-01"
OUT="$(run_audit)"
[[ "$(sent_count)" == "0" ]] && ok "accepted finding stays silent" || fail "accepted finding still alerted"
grep -q "принято до 2099-01-01" <<<"$OUT" && ok "accepted finding is still printed" || fail "accepted finding vanished from the log"

# 3. Срок принятия истёк — алерт снова уходит. Это и есть данные, при которых проверка
#    говорит «плохо»: без них список принятых был бы вечным глушителем.
fixture "some-lib" "high"
accepted "some-lib" "2000-01-01"
OUT="$(run_audit)"
[[ "$(sent_count)" == "1" ]] && ok "expired acceptance alerts again" || fail "expired acceptance stayed silent"
grep -q "ПРОСРОЧЕНО" <<<"$OUT" && ok "expired acceptance is named in the report" || fail "expired acceptance not named"

# 4. Telegram выключен — алерта нет, и лог обязан это сказать, а не рапортовать «alert sent».
fixture "some-lib" "high"
accepted "other-lib" "2099-01-01"
OUT="$(TELEGRAM_ENABLED=false run_audit)"
[[ "$(sent_count)" == "0" ]] && ok "disabled telegram sends nothing" || fail "disabled telegram still sent"
grep -q "ALERT NOT SENT" <<<"$OUT" && ok "log admits the alert did not go out" || fail "log claimed a send that never happened"
grep -q "some-lib" <<<"$OUT" && ok "findings are in the log even without telegram" || fail "findings lost with telegram off"

echo "passed: $PASS, failed: $FAILED"
[[ $FAILED -eq 0 ]] || exit 1
