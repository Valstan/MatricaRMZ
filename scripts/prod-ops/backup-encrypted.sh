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
# MATRICA_BACKUP_DUMP_EST_BYTES (128 MiB — see below), MATRICA_BACKUP_LOCK
# (/var/lib/matricarmz/backup.lock), TMPDIR (/tmp).
#
# Alerts read MATRICA_OPS_TELEGRAM_ENABLED, falling back to MATRICA_TELEGRAM_ENABLED.
# The ops-scoped name exists so a box can alert on backup failures without also enabling
# the product's Telegram bot polling and critical-event pushes, which read the shared flag.

set -euo pipefail

ENV_FILE="${MATRICA_ENV_FILE:-}"
if [[ -z "$ENV_FILE" ]]; then
  # backend-api/.env on prod is a symlink to the secret file and `git clean -fdx` removes it;
  # without an env file the script cannot even alert, so take the real file when the link is gone.
  for candidate in "${MATRICA_REPO_DIR:-$HOME/MatricaRMZ}/backend-api/.env" /etc/matricarmz/matricarmz.env; do
    if [[ -r "$candidate" ]]; then ENV_FILE="$candidate"; break; fi
  done
  ENV_FILE="${ENV_FILE:-${MATRICA_REPO_DIR:-$HOME/MatricaRMZ}/backend-api/.env}"
fi
PASSPHRASE_FILE="${MATRICA_BACKUP_PASSPHRASE_FILE:-/etc/matricarmz/backup.passphrase}"
RETENTION="${MATRICA_BACKUP_RETENTION:-14}"
RATIO_PCT="${MATRICA_BACKUP_ZSTD_RATIO_PCT:-50}"
FLOOR_BYTES="${MATRICA_BACKUP_FLOOR_BYTES:-$((1024 * 1024 * 1024))}"
LOCK_FILE="${MATRICA_BACKUP_LOCK:-/var/lib/matricarmz/backup.lock}"
# Only used by the pre-flight BEFORE pg_dump runs; the gate right after it re-checks with the
# real size, so an under-estimate costs at most one wasted dump. An over-estimate is the
# expensive mistake: it refuses to start on a box where the backup would have succeeded.
# 128 MiB is ~2x the measured prod dump (70.8 MB on 2026-09-03) — that dump is compressed
# inside pg_dump (--compress=zstd:3), so it is nowhere near the multi-GB uncompressed dumps
# the retired --compress=0 script used to write.
DUMP_EST_BYTES="${MATRICA_BACKUP_DUMP_EST_BYTES:-$((128 * 1024 * 1024))}"
[[ "$DUMP_EST_BYTES" =~ ^[0-9]+$ ]] || { echo "MATRICA_BACKUP_DUMP_EST_BYTES must be an integer (got '$DUMP_EST_BYTES')" >&2; exit 2; }
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
  if [[ "${MATRICA_OPS_TELEGRAM_ENABLED:-${MATRICA_TELEGRAM_ENABLED:-false}}" != "true" ]]; then
    log "telegram alert suppressed (MATRICA_OPS_TELEGRAM_ENABLED != true): ${msg:0:120}"
    return 0
  fi
  if [[ -z "${MATRICA_TELEGRAM_BOT_TOKEN:-}" || -z "${MATRICA_TELEGRAM_ALERT_CHAT_ID:-}" ]]; then
    log "telegram alert suppressed (token or chat id missing): ${msg:0:120}"
    return 0
  fi
  curl -fsS --connect-timeout 4 --retry 6 --retry-delay 1 --retry-all-errors -m 15 -o /dev/null \
    -d "chat_id=${MATRICA_TELEGRAM_ALERT_CHAT_ID}" \
    --data-urlencode "text=${msg}" \
    "https://api.telegram.org/bot${MATRICA_TELEGRAM_BOT_TOKEN}/sendMessage" \
    || log "WARN: telegram delivery failed (curl exit $?)"
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

# The env file carries the Telegram credentials, so nothing that can fail may run before it is
# sourced: an alert is impossible until then. Its own absence is the one unalertable case.
if [[ ! -r "$ENV_FILE" ]]; then
  log "ERROR: env file not readable: $ENV_FILE (ALERT IMPOSSIBLE: Telegram credentials live in it)"
  ALERTED=1
  exit 1
fi

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

[[ -r "$PASSPHRASE_FILE" ]] || fail "passphrase file not readable: $PASSPHRASE_FILE"
[[ "$RETENTION" =~ ^[0-9]+$ && "$RETENTION" -ge 1 ]] || fail "MATRICA_BACKUP_RETENTION must be an integer >= 1 (got '$RETENTION')"

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
[[ "$LEDGER_BYTES" =~ ^[0-9]+$ ]] || fail "du gave no size for $LEDGER_DIR (excluded by its own pattern?)"
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
# absent. tar exit 1 is "files changed while reading" (warning) — accepted for blocks/, which
# are append-only and the source of truth.
# NOT because state.json can be regenerated: ensureLedgerStateFile (backend-api/src/ledger/
# ledgerService.ts) never reads blocks/ — it restores state.json from a state.json.bak.* copy
# or writes an EMPTY state. A state.json captured mid-write therefore restores as an empty
# ledger, not as a rebuilt projection. That is why the restore runbook's height assertion
# (README.md §Восстановление) is mandatory rather than advisory.
ROOT_FILES=()
while IFS= read -r name; do
  case "$name" in
    *.bak.*|*.corrupt.*|*.tmp-*|.ledger.lock) ;;
    db.dump) log "WARN: ledger root has a stray 'db.dump' — skipped, the name is reserved for the PG dump" ;;
    *) ROOT_FILES+=("$name") ;;
  esac
done < <(find "$LEDGER_DIR" -maxdepth 1 -type f -printf '%P\n' | LC_ALL=C sort)
for required in index.json data-key.json server-key.json; do
  [[ -f "$LEDGER_DIR/$required" ]] || fail "ledger root has no $required — a restore from this archive would be unreadable"
  printf '%s\n' "${ROOT_FILES[@]}" | grep -qxF "$required" || fail "$required is excluded from the archive by a pattern"
done
BLOCKS_BEFORE="$(find "$LEDGER_DIR/blocks" -maxdepth 1 -name '*.json' | wc -l)"
(( BLOCKS_BEFORE > 0 )) || fail "ledger has no blocks — refusing to archive an empty ledger"
log "tar(${#ROOT_FILES[@]} root files + blocks + db.dump) | zstd | gpg AES256 -> $(basename "$ENCRYPTED") ($BLOCKS_BEFORE blocks on disk)"
set +e +o pipefail
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
set -e -o pipefail
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
set +e +o pipefail
gpg --batch --quiet --passphrase-file "$PASSPHRASE_FILE" --decrypt "$ENCRYPTED" \
  | zstd -d -q \
  | tar --list --file=- > "$LISTING"
VRC=("${PIPESTATUS[@]}")
set -e -o pipefail
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
# Blocks appended between the count and the end of tar are legitimately inside the archive,
# but they are AHEAD of the index.json the same archive carries. Restoring such an archive
# over a populated blocks/ leaves heights the index does not claim: the backend then writes
# new blocks at index.lastHeight+1 and silently overwrites them with different bytes.
if (( MEMBER_BLOCKS > BLOCKS_BEFORE )); then
  log "  WARN: $((MEMBER_BLOCKS - BLOCKS_BEFORE)) block(s) are ahead of the archived index — on restore, truncate blocks/ to index.lastHeight (README.md §Восстановление)"
fi
log "  verified: db.dump + ${#ROOT_FILES[@]} root file(s) + $MEMBER_BLOCKS block(s) listed"

if (( NO_UPLOAD == 1 )); then
  log "no-upload: archive built and verified ($ENC_SIZE), not uploaded, no rotation"
  exit 0
fi

# 4. Upload to Yandex.Disk, then verify the remote copy against the local digest.
log "sha256 of the archive"
LOCAL_SHA="$(sha256sum "$ENCRYPTED" | cut -d' ' -f1)"
log "upload to Yandex.Disk ($ENC_SIZE, sha256 ${LOCAL_SHA:0:12}…)"
python3 - "$YANDEX_DISK_TOKEN" "$YANDEX_BASE" "$ENCRYPTED" "$ENC_BYTES" "$LOCAL_SHA" <<'PY' || fail "upload failed"
import json, os, ssl, sys, urllib.error, urllib.parse, urllib.request

TOKEN, BASE, LOCAL_PATH, SIZE, SHA = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5].lower()
REMOTE_FILE = f"{BASE}/{os.path.basename(LOCAL_PATH)}"
API = "https://cloud-api.yandex.net/v1/disk"
HDR = {"Authorization": f"OAuth {TOKEN}"}
CTX = ssl.create_default_context()

def req(method, url, headers=None, data=None, expect=None, timeout=120):
    h = dict(HDR); h.update(headers or {})
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, context=CTX, timeout=timeout) as resp:
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
    req("PUT", f"{API}/resources?path={urllib.parse.quote(path)}", expect={409})

url = f"{API}/resources/upload?path={urllib.parse.quote(REMOTE_FILE)}&overwrite=true"
href = json.loads(req("GET", url)[1])["href"]

with open(LOCAL_PATH, "rb") as f:
    r = urllib.request.Request(href, data=f, method="PUT")
    r.add_header("Content-Length", str(SIZE))
    with urllib.request.urlopen(r, context=CTX, timeout=1800) as resp:
        if resp.status not in (201, 202):
            raise SystemExit(f"upload returned {resp.status}")

# The PUT status says the transfer ended, not that the bytes are right. Yandex hashes on
# ingest — compare before anything else is allowed to trust this copy.
url = f"{API}/resources?path={urllib.parse.quote(REMOTE_FILE)}&fields=type,size,sha256"
info = json.loads(req("GET", url)[1])
problems = []
if info.get("type") != "file":
    problems.append(f"type={info.get('type')}")
if info.get("size") != SIZE:
    problems.append(f"size={info.get('size')} != {SIZE}")
remote_sha = str(info.get("sha256", "")).lower()
if not remote_sha:
    problems.append("no sha256 from Yandex")
elif remote_sha != SHA:
    problems.append("sha256 mismatch")
if problems:
    req("DELETE", f"{API}/resources?path={urllib.parse.quote(REMOTE_FILE)}&permanently=true", expect={202, 204, 404})
    raise SystemExit("remote copy not verified (" + "; ".join(problems) + ") — deleted, nothing rotated")
print(f"  uploaded and verified: {REMOTE_FILE} ({SIZE} bytes, sha256 ok)")
PY

# 5. Rotation — separate from the upload so a rotation failure never reads as "the backup did
# not land", and paginated because the base folder is shared with attachments.
log "rotate: keep $RETENTION newest"
python3 - "$YANDEX_DISK_TOKEN" "$YANDEX_BASE" "$(basename "$ENCRYPTED")" "$RETENTION" <<'PY' || fail "rotation failed (upload OK, archive is on Yandex.Disk)"
import json, ssl, sys, urllib.error, urllib.parse, urllib.request

TOKEN, BASE, JUST_UPLOADED, RETENTION = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
API = "https://cloud-api.yandex.net/v1/disk"
HDR = {"Authorization": f"OAuth {TOKEN}"}
CTX = ssl.create_default_context()

def req(method, url, expect=None):
    r = urllib.request.Request(url, method=method, headers=HDR)
    try:
        with urllib.request.urlopen(r, context=CTX, timeout=120) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        if expect and e.code in expect:
            return e.code, body.encode()
        raise SystemExit(f"HTTP {e.code} {method} {url}: {body}")

# Page through the whole folder: it also holds attachments, so one page of 200 entries is not
# the backup set. Missing our own upload in the listing means the view is incomplete — refuse
# to delete anything on that basis.
names, offset, limit = [], 0, 200
while True:
    url = (f"{API}/resources?path={urllib.parse.quote(BASE)}"
           f"&limit={limit}&offset={offset}&fields=_embedded.items.name,_embedded.items.type,_embedded.items.path")
    items = json.loads(req("GET", url)[1]).get("_embedded", {}).get("items", [])
    names.extend(i for i in items if i.get("type") == "file")
    if len(items) < limit:
        break
    offset += limit

backups = sorted([i for i in names if i["name"].startswith("matricarmz-backup-")],
                 key=lambda i: i["name"], reverse=True)
if JUST_UPLOADED not in [i["name"] for i in backups]:
    raise SystemExit(f"listing does not contain the file just uploaded ({JUST_UPLOADED}) — refusing to rotate")
for old in backups[RETENTION:]:
    req("DELETE", f"{API}/resources?path={urllib.parse.quote(old['path'])}&permanently=true", expect={202, 204})
    print(f"  rotated out: {old['name']}")
print(f"  kept {min(len(backups), RETENTION)} of {len(backups)} backups")
PY

log "done: $YANDEX_BASE/${BASE_NAME}.tar.zst.gpg ($ENC_SIZE)"
