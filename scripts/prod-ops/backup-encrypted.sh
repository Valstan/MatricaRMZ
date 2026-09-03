#!/usr/bin/env bash
# Encrypted daily backup of PostgreSQL + ledger to Yandex.Disk.
#
# Reads PG creds and YANDEX_DISK_TOKEN from MATRICA_ENV_FILE (default backend-api/.env).
# Encrypts with GPG symmetric AES-256 using passphrase from PASSPHRASE_FILE.
# Rotates older copies on Yandex.Disk, keeping RETENTION newest.
# Sends Telegram alert on ANY outcome but success — aborts under `set -e` and signals
# included (EXIT/TERM traps). Single-instance via flock.
#
# Disk footprint dictates the layout. The box has little free space, so the archive is
# built as ONE stream — tar(ledger tree + db.dump) | zstd | gpg — staged to a single
# encrypted file. Peak usage ≈ compressed db.dump + encrypted archive (≈ 0.4 × ledger).
# A pre-flight check (and a second one after pg_dump, with the real dump size) refuses
# to start below that estimate plus a floor for the co-tenants of the partition: a backup
# that dies half-way leaves nothing behind but a silent night.
#
# Archive layout (restore — README.md §Восстановление из шифрованного бэкапа):
#   db.dump             pg_dump custom format (zstd-compressed inside; pg_restore >= 17)
#   <root files>        ledger root: index/state/keys — archived BEFORE blocks/, so the
#                       index can never be ahead of the blocks it names
#   blocks/*.json       ledger blocks (archive/, *.bak.*, *.corrupt.*, *.tmp-*, .ledger.lock excluded)
#
# Flags:
#   --no-upload   build and verify the archive, skip upload and rotation (acceptance run)
#
# Env knobs: MATRICA_BACKUP_RETENTION (14), MATRICA_BACKUP_ZSTD_RATIO_PCT (50 — expected
# archive size as % of the ledger), MATRICA_BACKUP_FLOOR_BYTES (1 GiB left for others),
# MATRICA_BACKUP_LOCK (/var/lib/matricarmz/backup.lock), TMPDIR (/tmp).

set -euo pipefail

ENV_FILE="${MATRICA_ENV_FILE:-${MATRICA_REPO_DIR:-$HOME/MatricaRMZ}/backend-api/.env}"
PASSPHRASE_FILE="${MATRICA_BACKUP_PASSPHRASE_FILE:-/etc/matricarmz/backup.passphrase}"
RETENTION="${MATRICA_BACKUP_RETENTION:-14}"
RATIO_PCT="${MATRICA_BACKUP_ZSTD_RATIO_PCT:-50}"
FLOOR_BYTES="${MATRICA_BACKUP_FLOOR_BYTES:-$((1024 * 1024 * 1024))}"
LOCK_FILE="${MATRICA_BACKUP_LOCK:-/var/lib/matricarmz/backup.lock}"
DUMP_EST_BYTES=$((512 * 1024 * 1024))
LISTING_RESERVE_BYTES=$((64 * 1024 * 1024))
NO_UPLOAD=0
for arg in "$@"; do
  case "$arg" in
    --no-upload) NO_UPLOAD=1 ;;
    --help|-h) sed -n '2,/^$/p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

WORK_DIR=""
ALERTED=0

log() { printf '[%s] %s\n' "$(date +%FT%T%z)" "$*"; }

telegram_alert() {
  local msg="$1"
  if [[ "${MATRICA_TELEGRAM_ENABLED:-false}" != "true" ]]; then
    log "telegram disabled (MATRICA_TELEGRAM_ENABLED != true) — alert not sent: $msg"
    return 0
  fi
  [[ -n "${MATRICA_TELEGRAM_BOT_TOKEN:-}" ]] || return 0
  [[ -n "${MATRICA_TELEGRAM_ALERT_CHAT_ID:-}" ]] || return 0
  curl -fsS -m 15 -o /dev/null \
    -d "chat_id=${MATRICA_TELEGRAM_ALERT_CHAT_ID}" \
    --data-urlencode "text=${msg}" \
    "https://api.telegram.org/bot${MATRICA_TELEGRAM_BOT_TOKEN}/sendMessage" || true
}

fail() {
  log "ERROR: $*"
  ALERTED=1
  telegram_alert "❌ Backup failed: $*" || true
  exit 1
}

# Every abort must be loud. Commands dying under `set -e` (tar/gpg on ENOSPC) used to exit
# without a word — twenty nights in a row in August 2026, noticed by reading the log.
on_exit() {
  local rc=$?
  if (( rc != 0 && ALERTED == 0 )); then
    log "ERROR: aborted with exit $rc"
    telegram_alert "❌ Backup aborted: exit $rc — see backup.log" || true
  fi
  [[ -n "$WORK_DIR" ]] && rm -rf "$WORK_DIR"
}
trap on_exit EXIT
# An operator's Ctrl-C or `kill` must count as a failed night too, not as a clean exit.
trap 'fail "terminated by signal"' INT TERM HUP

[[ -r "$ENV_FILE" ]] || fail "env file not readable: $ENV_FILE"
[[ -r "$PASSPHRASE_FILE" ]] || fail "passphrase file not readable: $PASSPHRASE_FILE"

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

# Resolved AFTER sourcing the env file so MATRICA_LEDGER_DIR from .env wins.
# Default = the canonical relocated ledger (H8 2026-06-30), NOT the repo-local
# ./ledger — that one is a stale parasite regrown by scripts run without the var.
LEDGER_DIR="${MATRICA_LEDGER_DIR:-$HOME/matricarmz-ledger}"

[[ -n "${PGUSER:-}" && -n "${PGPASSWORD:-}" && -n "${PGDATABASE:-}" ]] || fail "PG env vars missing"
[[ -n "${YANDEX_DISK_TOKEN:-}" ]] || fail "YANDEX_DISK_TOKEN missing"
[[ -d "$LEDGER_DIR/blocks" ]] || fail "ledger dir has no blocks/: $LEDGER_DIR"
YANDEX_BASE="${YANDEX_DISK_BASE_PATH:-/matricarmz-backups}"
# Normalize: must start with /, no trailing slash
YANDEX_BASE="/${YANDEX_BASE#/}"
YANDEX_BASE="${YANDEX_BASE%/}"
[[ "$YANDEX_BASE" == "/" ]] && fail "YANDEX_DISK_BASE_PATH cannot be root"

# Single instance: a second run (cron + a manual acceptance run) would double the disk
# footprint. flock releases on any exit, so no staleness handling is needed.
LOCK_DIR="$(dirname "$LOCK_FILE")"
[[ -d "$LOCK_DIR" && -w "$LOCK_DIR" ]] || fail "lock dir not writable: $LOCK_DIR (set MATRICA_BACKUP_LOCK)"
exec 9>"$LOCK_FILE"
flock -n 9 || fail "another backup run holds $LOCK_FILE"

# Leftovers of a run that was SIGKILLed (OOM, reboot) — the lock proves nobody owns them.
TMP_ROOT="${TMPDIR:-/tmp}"
while IFS= read -r stale; do
  log "removing stale work dir: $stale"
  rm -rf "$stale"
done < <(find "$TMP_ROOT" -maxdepth 1 -type d -name 'matricarmz-backup.*' -user "$(id -un)" 2>/dev/null)
WORK_DIR="$(mktemp -d -t matricarmz-backup.XXXXXX)"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
BASE_NAME="matricarmz-backup-${STAMP}"
DB_DUMP="$WORK_DIR/db.dump"
ENCRYPTED="$WORK_DIR/${BASE_NAME}.tar.zst.gpg"
EXCLUDES=(--exclude='archive' --exclude='*.bak.*' --exclude='*.corrupt.*' --exclude='*.tmp-*' --exclude='.ledger.lock')

log "start backup -> $YANDEX_BASE/${BASE_NAME}.tar.zst.gpg"

# 0. Pre-flight: refuse to start without room for the archive AND a floor for the other
# tenants of the partition (PostgreSQL WAL, uploads, journald). The estimate counts the
# dump twice — staged file plus its copy inside the archive.
LEDGER_BYTES="$(du -sb "${EXCLUDES[@]}" "$LEDGER_DIR" | cut -f1)"
free_bytes() { df -B1 --output=avail "$TMP_ROOT" | tail -1 | tr -d ' '; }
need_bytes() { echo $(( LEDGER_BYTES * RATIO_PCT / 100 + 2 * $1 + LISTING_RESERVE_BYTES + FLOOR_BYTES )); }
FREE_BYTES="$(free_bytes)"
NEED_BYTES="$(need_bytes "$DUMP_EST_BYTES")"
log "pre-flight: ledger $((LEDGER_BYTES / 1048576)) MB, need ~$((NEED_BYTES / 1048576)) MB (incl. floor $((FLOOR_BYTES / 1048576)) MB), free $((FREE_BYTES / 1048576)) MB"
if (( FREE_BYTES < NEED_BYTES )); then
  fail "not enough free space for the archive: need ~$((NEED_BYTES / 1048576)) MB, free $((FREE_BYTES / 1048576)) MB"
fi

# 1. pg_dump (custom format, zstd-compressed inside so the staged file stays small)
log "pg_dump ${PGDATABASE}@${PGHOST:-127.0.0.1}:${PGPORT:-5432}"
PGPASSWORD="$PGPASSWORD" pg_dump \
  -h "${PGHOST:-127.0.0.1}" \
  -p "${PGPORT:-5432}" \
  -U "$PGUSER" \
  -d "$PGDATABASE" \
  --format=custom --compress=zstd:3 --no-owner --no-privileges \
  --file="$DB_DUMP" || fail "pg_dump failed"
DUMP_BYTES="$(stat -c %s "$DB_DUMP")"
log "  db.dump: $((DUMP_BYTES / 1048576)) MB"
FREE_BYTES="$(free_bytes)"
NEED_BYTES="$(need_bytes "$DUMP_BYTES")"
if (( FREE_BYTES + DUMP_BYTES < NEED_BYTES )); then
  fail "not enough free space after pg_dump: need ~$((NEED_BYTES / 1048576)) MB, free $((FREE_BYTES / 1048576)) MB"
fi

# 2. One stream: tar(ledger root files, then blocks/, then db.dump) | zstd | gpg.
# Root files first so the index/state inside the archive never names a block the archive
# lacks; blocks are counted BEFORE tar starts — one appended during the run is legitimately
# absent. tar exit 1 is "files changed while reading" (warning) — accepted: blocks/ are
# append-only and the source of truth, state is a projection the backend rebuilds.
ROOT_FILES=()
while IFS= read -r name; do
  case "$name" in
    *.bak.*|*.corrupt.*|*.tmp-*|.ledger.lock) ;;
    *) ROOT_FILES+=("$name") ;;
  esac
done < <(find "$LEDGER_DIR" -maxdepth 1 -type f -printf '%P\n' | LC_ALL=C sort)
BLOCKS_BEFORE="$(find "$LEDGER_DIR/blocks" -maxdepth 1 -name '*.json' | wc -l)"
(( BLOCKS_BEFORE > 0 )) || fail "ledger has no blocks — refusing to archive an empty ledger"
log "tar(${#ROOT_FILES[@]} root files + blocks + db.dump) | zstd | gpg AES256 -> $(basename "$ENCRYPTED") ($BLOCKS_BEFORE blocks on disk)"
set +o pipefail
tar --create --file=- \
    --warning=no-file-changed \
    "${EXCLUDES[@]}" \
    -C "$LEDGER_DIR" "${ROOT_FILES[@]}" blocks \
    -C "$WORK_DIR" db.dump \
  | zstd -q -9 -T0 \
  | gpg --batch --yes --quiet \
      --cipher-algo AES256 --s2k-mode 3 --s2k-count 65011712 \
      --passphrase-file "$PASSPHRASE_FILE" \
      -c --output "$ENCRYPTED"
RCS=("${PIPESTATUS[@]}")
set -o pipefail
TAR_RC="${RCS[0]:-0}"
ZSTD_RC="${RCS[1]:-0}"
GPG_RC="${RCS[2]:-0}"
if [[ $TAR_RC -gt 1 ]]; then fail "tar failed with exit $TAR_RC"; fi
if [[ $ZSTD_RC -ne 0 ]]; then fail "zstd failed with exit $ZSTD_RC"; fi
if [[ $GPG_RC -ne 0 ]]; then fail "gpg failed with exit $GPG_RC"; fi
rm -f "$DB_DUMP"
ENC_BYTES="$(stat -c %s "$ENCRYPTED")"
ENC_SIZE="$((ENC_BYTES / 1048576)) MB"
log "  encrypted: $ENC_SIZE (archive/ledger ratio $((ENC_BYTES * 100 / LEDGER_BYTES))%, knob RATIO_PCT=$RATIO_PCT)"

# 3. Verify the archive is readable end to end before calling it a backup: decrypt,
# decompress and list — streaming, the listing is the only thing written. db.dump, every
# root file and every block that existed before tar started must be inside. Members are
# listed as "db.dump", "index.json", "blocks/00000001.json" (no "./" prefix).
log "verify: gpg -d | zstd -d | tar -t"
LISTING="$WORK_DIR/listing.txt"
set +o pipefail
gpg --batch --quiet --passphrase-file "$PASSPHRASE_FILE" --decrypt "$ENCRYPTED" \
  | zstd -d -q \
  | tar --list --file=- > "$LISTING"
VRC=("${PIPESTATUS[@]}")
set -o pipefail
if [[ "${VRC[0]:-0}" -ne 0 || "${VRC[1]:-0}" -ne 0 || "${VRC[2]:-0}" -ne 0 ]]; then
  fail "verify pipeline failed (gpg=${VRC[0]:-?} zstd=${VRC[1]:-?} tar=${VRC[2]:-?})"
fi
if (( $(grep -cx 'db.dump' "$LISTING" || true) != 1 )); then
  fail "verify: db.dump is not in the archive"
fi
for name in "${ROOT_FILES[@]}"; do
  if (( $(grep -cxF "$name" "$LISTING" || true) != 1 )); then
    fail "verify: ledger root file '$name' is not in the archive"
  fi
done
MEMBER_BLOCKS="$(grep -cE '^blocks/[^/]+\.json$' "$LISTING" || true)"
if (( MEMBER_BLOCKS < BLOCKS_BEFORE )); then
  fail "verify: archive lists $MEMBER_BLOCKS block(s), expected >= $BLOCKS_BEFORE"
fi
log "  verified: db.dump + ${#ROOT_FILES[@]} root file(s) + $MEMBER_BLOCKS block(s) listed"

if (( NO_UPLOAD == 1 )); then
  log "no-upload: archive built and verified ($ENC_SIZE), not uploaded, no rotation"
  exit 0
fi

# 4. Upload to Yandex.Disk
log "upload to Yandex.Disk"
python3 - "$YANDEX_DISK_TOKEN" "$YANDEX_BASE" "$ENCRYPTED" "$RETENTION" <<'PY' || fail "upload script failed"
import json, os, ssl, sys, time, urllib.parse, urllib.request

TOKEN, BASE, LOCAL_PATH, RETENTION = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
REMOTE_FILE = f"{BASE}/{os.path.basename(LOCAL_PATH)}"
API = "https://cloud-api.yandex.net/v1/disk"
HDR = {"Authorization": f"OAuth {TOKEN}"}
CTX = ssl.create_default_context()

def req(method, url, headers=None, data=None, expect=None):
    h = dict(HDR); h.update(headers or {})
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, context=CTX, timeout=120) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        if expect and e.code in expect:
            return e.code, body.encode()
        raise SystemExit(f"HTTP {e.code} {method} {url}: {body}")

# Ensure base folder exists (idempotent: 201 created, 409 already exists)
parts = [p for p in BASE.split("/") if p]
path = ""
for p in parts:
    path = f"{path}/{p}"
    url = f"{API}/resources?path={urllib.parse.quote(path)}"
    req("PUT", url, expect={409})

# Get upload href
url = f"{API}/resources/upload?path={urllib.parse.quote(REMOTE_FILE)}&overwrite=true"
status, body = req("GET", url)
href = json.loads(body)["href"]

# PUT file (no auth header on the upload URL — signed link)
size = os.path.getsize(LOCAL_PATH)
with open(LOCAL_PATH, "rb") as f:
    r = urllib.request.Request(href, data=f, method="PUT")
    r.add_header("Content-Length", str(size))
    with urllib.request.urlopen(r, context=CTX, timeout=600) as resp:
        if resp.status not in (201, 202):
            raise SystemExit(f"upload returned {resp.status}")
print(f"  uploaded ok: {REMOTE_FILE} ({size} bytes)")

# Rotation: list files, delete those beyond RETENTION
url = (f"{API}/resources?path={urllib.parse.quote(BASE)}"
       f"&limit=200&sort=-name")
status, body = req("GET", url)
items = json.loads(body).get("_embedded", {}).get("items", [])
files = sorted(
    [i for i in items if i.get("type") == "file" and i["name"].startswith("matricarmz-backup-")],
    key=lambda i: i["name"], reverse=True,
)
for old in files[RETENTION:]:
    url = f"{API}/resources?path={urllib.parse.quote(old['path'])}&permanently=true"
    req("DELETE", url, expect={202, 204})
    print(f"  rotated out: {old['path']}")
print(f"  kept {min(len(files), RETENTION)} of {len(files)} backups")
PY

log "done: $YANDEX_BASE/${BASE_NAME}.tar.zst.gpg ($ENC_SIZE)"
