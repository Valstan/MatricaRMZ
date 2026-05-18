#!/usr/bin/env bash
# Encrypted daily backup of PostgreSQL + ledger to Yandex.Disk.
#
# Reads PG creds and YANDEX_DISK_TOKEN from MATRICA_ENV_FILE (default backend-api/.env).
# Encrypts with GPG symmetric AES-256 using passphrase from PASSPHRASE_FILE.
# Rotates older copies on Yandex.Disk, keeping RETENTION newest.
# Sends Telegram alert on any failure.

set -euo pipefail

ENV_FILE="${MATRICA_ENV_FILE:-/home/valstan/MatricaRMZ/backend-api/.env}"
PASSPHRASE_FILE="${MATRICA_BACKUP_PASSPHRASE_FILE:-/etc/matricarmz/backup.passphrase}"
LEDGER_DIR="${MATRICA_LEDGER_DIR:-/home/valstan/MatricaRMZ/backend-api/ledger}"
RETENTION="${MATRICA_BACKUP_RETENTION:-14}"
WORK_DIR="$(mktemp -d -t matricarmz-backup.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

log() { printf '[%s] %s\n' "$(date +%FT%T%z)" "$*"; }
fail() {
  log "ERROR: $*"
  telegram_alert "❌ Backup failed: $*" || true
  exit 1
}

telegram_alert() {
  local msg="$1"
  [[ "${MATRICA_TELEGRAM_ENABLED:-false}" == "true" ]] || return 0
  [[ -n "${MATRICA_TELEGRAM_BOT_TOKEN:-}" ]] || return 0
  [[ -n "${MATRICA_TELEGRAM_ALERT_CHAT_ID:-}" ]] || return 0
  curl -fsS -m 15 -o /dev/null \
    -d "chat_id=${MATRICA_TELEGRAM_ALERT_CHAT_ID}" \
    --data-urlencode "text=${msg}" \
    "https://api.telegram.org/bot${MATRICA_TELEGRAM_BOT_TOKEN}/sendMessage" || true
}

[[ -r "$ENV_FILE" ]] || fail "env file not readable: $ENV_FILE"
[[ -r "$PASSPHRASE_FILE" ]] || fail "passphrase file not readable: $PASSPHRASE_FILE"

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

[[ -n "${PGUSER:-}" && -n "${PGPASSWORD:-}" && -n "${PGDATABASE:-}" ]] || fail "PG env vars missing"
[[ -n "${YANDEX_DISK_TOKEN:-}" ]] || fail "YANDEX_DISK_TOKEN missing"
YANDEX_BASE="${YANDEX_DISK_BASE_PATH:-/matricarmz-backups}"
# Normalize: must start with /, no trailing slash
YANDEX_BASE="/${YANDEX_BASE#/}"
YANDEX_BASE="${YANDEX_BASE%/}"
[[ "$YANDEX_BASE" == "/" ]] && fail "YANDEX_DISK_BASE_PATH cannot be root"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
BASE_NAME="matricarmz-backup-${STAMP}"
DB_DUMP="$WORK_DIR/db.dump"
LEDGER_TAR="$WORK_DIR/ledger.tar.zst"
COMBINED="$WORK_DIR/${BASE_NAME}.tar"
ENCRYPTED="$WORK_DIR/${BASE_NAME}.tar.gpg"

log "start backup -> $YANDEX_BASE/${BASE_NAME}.tar.gpg"

# 1. pg_dump (custom format, internal compression off; we'll wrap everything in zstd then gpg)
log "pg_dump ${PGDATABASE}@${PGHOST:-127.0.0.1}:${PGPORT:-5432}"
PGPASSWORD="$PGPASSWORD" pg_dump \
  -h "${PGHOST:-127.0.0.1}" \
  -p "${PGPORT:-5432}" \
  -U "$PGUSER" \
  -d "$PGDATABASE" \
  --format=custom --compress=0 --no-owner --no-privileges \
  --file="$DB_DUMP"
log "  db.dump: $(du -h "$DB_DUMP" | awk '{print $1}')"

# 2. ledger archive (compress strongly with zstd -19)
log "tar+zstd ledger (excluding archive/ and *.bak.*)"
tar --create --file=- \
    --exclude='archive' --exclude='*.bak.*' \
    -C "$LEDGER_DIR" . \
  | zstd -q -19 -T2 -o "$LEDGER_TAR"
log "  ledger.tar.zst: $(du -h "$LEDGER_TAR" | awk '{print $1}')"

# 3. combine into single tar (already-compressed inner files, so no outer compression)
tar --create --file="$COMBINED" \
  -C "$WORK_DIR" "$(basename "$DB_DUMP")" "$(basename "$LEDGER_TAR")"
log "  combined: $(du -h "$COMBINED" | awk '{print $1}')"

# 4. GPG symmetric encrypt
log "gpg symmetric AES256"
gpg --batch --yes --quiet \
    --cipher-algo AES256 --s2k-mode 3 --s2k-count 65011712 \
    --passphrase-file "$PASSPHRASE_FILE" \
    -c --output "$ENCRYPTED" "$COMBINED"
rm -f "$COMBINED"
ENC_SIZE="$(du -h "$ENCRYPTED" | awk '{print $1}')"
log "  encrypted: $ENC_SIZE"

# 5. Upload to Yandex.Disk
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

log "done: $YANDEX_BASE/${BASE_NAME}.tar.gpg ($ENC_SIZE)"
