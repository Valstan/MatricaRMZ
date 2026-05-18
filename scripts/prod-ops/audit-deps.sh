#!/usr/bin/env bash
# Weekly pnpm audit of production dependencies, with Telegram alert on high/critical.

set -uo pipefail

ENV_FILE="${MATRICA_ENV_FILE:-/home/valstan/MatricaRMZ/backend-api/.env}"
REPO_DIR="${MATRICA_REPO_DIR:-/home/valstan/MatricaRMZ}"

log() { printf '[%s] %s\n' "$(date +%FT%T%z)" "$*"; }

telegram_send() {
  local msg="$1"
  [[ "${MATRICA_TELEGRAM_ENABLED:-false}" == "true" ]] || { log "telegram disabled, msg head: ${msg:0:80}"; return 0; }
  [[ -n "${MATRICA_TELEGRAM_BOT_TOKEN:-}" && -n "${MATRICA_TELEGRAM_ALERT_CHAT_ID:-}" ]] || return 0
  curl -fsS -m 15 -o /dev/null \
    -d "chat_id=${MATRICA_TELEGRAM_ALERT_CHAT_ID}" \
    --data-urlencode "text=${msg}" \
    "https://api.telegram.org/bot${MATRICA_TELEGRAM_BOT_TOKEN}/sendMessage" || true
}

[[ -r "$ENV_FILE" ]] && { set -a; . "$ENV_FILE"; set +a; }

cd "$REPO_DIR" || { log "ERROR: cannot cd to $REPO_DIR"; exit 1; }

log "running pnpm audit --prod --json"
AUDIT_JSON="$(pnpm audit --prod --json 2>/dev/null || true)"

if [[ -z "$AUDIT_JSON" ]]; then
  log "empty audit output (treated as no findings)"
  exit 0
fi

REPORT="$(printf '%s' "$AUDIT_JSON" | python3 <<'PY'
import json, sys
try:
    data = json.load(sys.stdin)
except Exception as e:
    print(f"summary: parse_error={e}")
    print("NOALERT")
    sys.exit(0)

meta = data.get("metadata", {})
counts = meta.get("vulnerabilities", {}) if isinstance(meta, dict) else {}
info = int(counts.get("info", 0))
low = int(counts.get("low", 0))
mod = int(counts.get("moderate", 0))
high = int(counts.get("high", 0))
crit = int(counts.get("critical", 0))

ad = data.get("advisories") or {}
if isinstance(ad, dict):
    advisories = list(ad.values())
elif isinstance(ad, list):
    advisories = ad
else:
    advisories = []

sev_order = {"critical": 0, "high": 1, "moderate": 2, "low": 3, "info": 4}
advisories.sort(key=lambda a: sev_order.get(a.get("severity", "info"), 5))

print(f"summary: crit={crit} high={high} mod={mod} low={low} info={info}")
print("ALERT" if (crit > 0 or high > 0) else "NOALERT")
print("---")
for a in advisories[:10]:
    sev = a.get("severity", "?")
    mod_name = a.get("module_name") or a.get("name") or "?"
    title = (a.get("title") or "")[:80]
    url = a.get("url") or ""
    print(f"  [{sev}] {mod_name}: {title} {url}")
PY
)"

SUMMARY="$(printf '%s' "$REPORT" | head -n 1)"
NEEDS_ALERT=0
printf '%s' "$REPORT" | sed -n '2p' | grep -q '^ALERT$' && NEEDS_ALERT=1

log "$SUMMARY"

if [[ $NEEDS_ALERT -eq 1 ]]; then
  TOP="$(printf '%s' "$REPORT" | awk '/^---$/{found=1; next} found' | head -n 10)"
  telegram_send "⚠️ MatricaRMZ deps audit: ${SUMMARY#summary: }
$TOP"
  log "alert sent"
else
  log "no high/critical findings — no alert"
fi
