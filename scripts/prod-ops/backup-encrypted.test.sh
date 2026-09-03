#!/usr/bin/env bash
# Smoke test for backup-encrypted.sh — the only backup of the ledger, and the one script
# whose failure mode is silence. Runs the real script against a fixture ledger with shimmed
# pg_dump and curl; `--no-upload` keeps it off the network.
#
#   bash scripts/prod-ops/backup-encrypted.test.sh
#
# Needs GNU tar/du/df/find, gpg, zstd, flock, python3, sha256sum. Exits 0 with SKIP when a
# tool is missing (Windows dev boxes), so it is a CI gate, not a local obstacle.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SCRIPT_DIR/backup-encrypted.sh"
[[ -r "$SUT" ]] || { echo "FAIL: $SUT not found"; exit 1; }

for tool in gpg zstd flock python3 sha256sum tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "SKIP: $tool not available — this test needs a Linux-like toolchain"
    exit 0
  fi
done

ROOT="$(mktemp -d -t backup-test.XXXXXX)"
trap 'rm -rf "$ROOT"' EXIT
PASS=0
FAILED=0

# ---- fixture -------------------------------------------------------------------------
# A ledger with everything the excludes are supposed to drop: rotated and corrupt copies of
# the projection, and the archive/ subtree.
LEDGER="$ROOT/ledger"
mkdir -p "$LEDGER/blocks" "$LEDGER/archive" "$ROOT/bin" "$ROOT/tmp" "$ROOT/lock"
for i in 1 2 3; do printf '{"height":%d,"txs":[]}' "$i" > "$LEDGER/blocks/0000000$i.json"; done
printf '{"lastHeight":3}' > "$LEDGER/index.json"
printf '{"k":"data"}' > "$LEDGER/data-key.json"
printf '{"k":"server"}' > "$LEDGER/server-key.json"
printf '{"projection":true}' > "$LEDGER/state.json"
printf 'stale' > "$LEDGER/state.json.bak.123.before-rotate"
printf 'corrupt' > "$LEDGER/state.json.corrupt.456"
printf 'old' > "$LEDGER/archive/old.json"

# Same ledger without the keyring — a restore from such an archive cannot read a single block.
LEDGER_NOKEY="$ROOT/ledger-nokey"
cp -r "$LEDGER" "$LEDGER_NOKEY"
rm -f "$LEDGER_NOKEY/data-key.json"

PASSPHRASE="$ROOT/pass.txt"
printf 'test-passphrase' > "$PASSPHRASE"

ENVF="$ROOT/env"
cat > "$ENVF" <<EOF
PGUSER=u
PGPASSWORD=p
PGDATABASE=d
YANDEX_DISK_TOKEN=t
YANDEX_DISK_BASE_PATH=/backups
MATRICA_LEDGER_DIR=$LEDGER
MATRICA_TELEGRAM_ENABLED=true
MATRICA_TELEGRAM_BOT_TOKEN=bot
MATRICA_TELEGRAM_ALERT_CHAT_ID=chat
EOF

# The env file wins over the process environment (on prod it is the source of truth), so a case
# that needs a different ledger needs its own file, not an exported variable.
sed "s|^MATRICA_LEDGER_DIR=.*|MATRICA_LEDGER_DIR=$LEDGER_NOKEY|" "$ENVF" > "$ROOT/env-nokey"
sed "s|^MATRICA_LEDGER_DIR=.*|MATRICA_LEDGER_DIR=$ROOT/tmp|" "$ENVF" > "$ROOT/env-noblocks"

# pg_dump shim: writes a file where --file points, or fails when told to.
cat > "$ROOT/bin/pg_dump" <<'EOF'
#!/usr/bin/env bash
[[ -n "${FAKE_PGDUMP_FAIL:-}" ]] && { echo "pg_dump: simulated failure" >&2; exit 1; }
out=""
for a in "$@"; do [[ "$a" == --file=* ]] && out="${a#--file=}"; done
[[ -n "$out" ]] || exit 2
head -c 4096 /dev/zero > "$out"
EOF
# curl shim: records every alert attempt instead of talking to Telegram.
cat > "$ROOT/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FAKE_CURL_LOG:?}"
EOF
chmod +x "$ROOT/bin/pg_dump" "$ROOT/bin/curl"

run_case() {
  # run_case <name> <expect-rc: 0|nonzero> <expect-telegram-calls> <grep-pattern> [VAR=value...]
  local name="$1" expect_rc="$2" expect_curl="$3" pattern="$4"; shift 4
  local out="$ROOT/out.txt" curl_log="$ROOT/curl.txt"
  : > "$curl_log"
  ( export PATH="$ROOT/bin:$PATH" \
      FAKE_CURL_LOG="$curl_log" \
      TMPDIR="$ROOT/tmp" \
      MATRICA_ENV_FILE="$ENVF" \
      MATRICA_BACKUP_PASSPHRASE_FILE="$PASSPHRASE" \
      MATRICA_BACKUP_LOCK="$ROOT/lock/backup.lock" \
      "$@"
    bash "$SUT" --no-upload ) > "$out" 2>&1
  local rc=$?
  local calls; calls="$(awk 'END{print NR}' "$curl_log")"
  local ok=1
  if [[ "$expect_rc" == "0" ]]; then (( rc == 0 )) || ok=0; else (( rc != 0 )) || ok=0; fi
  [[ "$calls" == "$expect_curl" ]] || ok=0
  grep -qE "$pattern" "$out" || ok=0
  if (( ok )); then
    PASS=$((PASS + 1)); echo "ok   — $name"
  else
    FAILED=$((FAILED + 1))
    echo "FAIL — $name (rc=$rc want ${expect_rc}, telegram=$calls want $expect_curl, pattern: $pattern)"
    sed 's/^/       /' "$out" | tail -12
  fi
}

echo "== backup-encrypted.sh smoke =="

# Happy path. The counts are the assertion on the excludes: the fixture has 6 root files, of
# which the rotated and the corrupt copy must not be archived — so exactly 4 may appear.
run_case "builds and verifies the archive, excluding *.bak.* / *.corrupt.* / archive/" \
  0 0 'verified: db\.dump \+ 4 root file\(s\) \+ 3 block\(s\)'

# Every failure must alert exactly once — that is the whole point of the rewrite.
run_case "pg_dump failure alerts once" 1 1 'ERROR: pg_dump failed' FAKE_PGDUMP_FAIL=1
run_case "unreadable passphrase alerts once" 1 1 'passphrase file not readable' \
  MATRICA_BACKUP_PASSPHRASE_FILE="$ROOT/no-such-pass"
run_case "no room refuses before touching anything, and alerts" 1 1 'not enough free space' \
  MATRICA_BACKUP_FLOOR_BYTES=999999999999999
run_case "bad retention alerts once" 1 1 'RETENTION must be an integer' MATRICA_BACKUP_RETENTION=0
run_case "ledger without the keyring is refused" 1 1 'data-key\.json' MATRICA_ENV_FILE="$ROOT/env-nokey"
run_case "ledger without blocks is refused" 1 1 'has no blocks' MATRICA_ENV_FILE="$ROOT/env-noblocks"

# A missing env file cannot alert (the credentials live in it) but must say exactly that.
run_case "missing env file says the alert is impossible" 1 0 'ALERT IMPOSSIBLE' \
  MATRICA_ENV_FILE="$ROOT/no-such-env"

# Second instance must refuse rather than double the disk footprint. The lock is held here, in
# the test's own shell; the script opens the same file on its own fd and must be denied.
exec 8>"$ROOT/lock/backup.lock"
if flock -n 8; then
  run_case "second instance refuses while the lock is held" 1 1 'another backup run holds'
  exec 8>&-
else
  echo "FAIL — could not take the test lock"; FAILED=$((FAILED + 1))
fi

echo "== $PASS passed, $FAILED failed =="
(( FAILED == 0 )) || exit 1
