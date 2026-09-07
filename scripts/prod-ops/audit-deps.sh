#!/usr/bin/env bash
# Weekly pnpm audit of production dependencies, with Telegram alert on high/critical.

set -uo pipefail

REPO_DIR="${MATRICA_REPO_DIR:-$HOME/MatricaRMZ}"
ENV_FILE="${MATRICA_ENV_FILE:-$REPO_DIR/backend-api/.env}"

log() { printf '[%s] %s\n' "$(date +%FT%T%z)" "$*"; }

# Возвращает 0 только если сообщение действительно ушло. Прежде функция всегда возвращала 0,
# и вызывающий безусловно писал в лог «alert sent» — четыре ложных записи подряд при выключенном
# Telegram (03.08, 10.08, 24.08, 31.08). Лог о доставке обязан говорить о доставке.
telegram_send() {
  local msg="$1"
  [[ "${MATRICA_OPS_TELEGRAM_ENABLED:-${MATRICA_TELEGRAM_ENABLED:-false}}" == "true" ]] || { log "telegram disabled, msg head: ${msg:0:80}"; return 1; }
  [[ -n "${MATRICA_TELEGRAM_BOT_TOKEN:-}" && -n "${MATRICA_TELEGRAM_ALERT_CHAT_ID:-}" ]] || { log "telegram not configured (token/chat_id missing)"; return 1; }
  curl -fsS --connect-timeout 4 --retry 6 --retry-delay 1 --retry-all-errors -m 15 -o /dev/null \
    -d "chat_id=${MATRICA_TELEGRAM_ALERT_CHAT_ID}" \
    --data-urlencode "text=${msg}" \
    "https://api.telegram.org/bot${MATRICA_TELEGRAM_BOT_TOKEN}/sendMessage"
}

[[ -r "$ENV_FILE" ]] && { set -a; . "$ENV_FILE"; set +a; }

cd "$REPO_DIR" || { log "ERROR: cannot cd to $REPO_DIR"; exit 1; }

log "running pnpm audit --prod --json"
AUDIT_JSON="$(pnpm audit --prod --json 2>/dev/null || true)"

if [[ -z "$AUDIT_JSON" ]]; then
  log "empty audit output (treated as no findings)"
  exit 0
fi

JSON_TMP="$(mktemp)"
printf '%s' "$AUDIT_JSON" > "$JSON_TMP"
trap 'rm -f "$JSON_TMP"' EXIT

ACCEPTED_FILE="${MATRICA_AUDIT_ACCEPTED_FILE:-$REPO_DIR/scripts/prod-ops/audit-accepted.json}"

REPORT="$(python3 - "$JSON_TMP" "$ACCEPTED_FILE" <<'PY'
import json, sys, datetime
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
except Exception as e:
    print(f"summary: parse_error={e}")
    print("NOALERT")
    sys.exit(0)

# Принятые находки: не поднимают алерт до своей даты, но печатаются всегда. Просроченная
# запись поднимает алерт сама — иначе список молча становится вечным и гейт перестаёт
# быть гейтом (у проверки должны существовать данные, при которых она скажет «плохо»).
accepted, expired = {}, []
try:
    with open(sys.argv[2]) as f:
        today = datetime.date.today()
        for row in (json.load(f).get("accepted") or []):
            mod = str(row.get("module") or "")
            if not mod:
                continue
            try:
                until = datetime.date.fromisoformat(str(row.get("until") or ""))
            except ValueError:
                expired.append((mod, "нет даты"))
                continue
            if until < today:
                expired.append((mod, f"срок принятия истёк {until.isoformat()}"))
            else:
                accepted[mod] = until.isoformat()
except FileNotFoundError:
    pass
except Exception as e:
    expired.append(("audit-accepted.json", f"не читается: {e}"))

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

def module_of(a):
    return a.get("module_name") or a.get("name") or "?"

blocking = [
    a for a in advisories
    if a.get("severity") in ("critical", "high") and module_of(a) not in accepted
]

print(f"summary: crit={crit} high={high} mod={mod} low={low} info={info} accepted={len(accepted)}")
print("ALERT" if (blocking or expired) else "NOALERT")
print("---")
for mod_name, why in expired:
    print(f"  [ПРОСРОЧЕНО] {mod_name}: {why} — перепроверить или продлить осознанно")
for a in advisories[:10]:
    sev = a.get("severity", "?")
    mod_name = module_of(a)
    title = (a.get("title") or "")[:80]
    url = a.get("url") or ""
    mark = f" (принято до {accepted[mod_name]})" if mod_name in accepted else ""
    print(f"  [{sev}] {mod_name}: {title} {url}{mark}")
PY
)"

SUMMARY="$(printf '%s' "$REPORT" | head -n 1)"
NEEDS_ALERT=0
printf '%s' "$REPORT" | sed -n '2p' | grep -q '^ALERT$' && NEEDS_ALERT=1

log "$SUMMARY"

FINDINGS="$(printf '%s' "$REPORT" | awk '/^---$/{found=1; next} found' | head -n 10)"
[[ -n "$FINDINGS" ]] && printf '%s\n' "$FINDINGS"

if [[ $NEEDS_ALERT -eq 1 ]]; then
  if telegram_send "⚠️ MatricaRMZ deps audit: ${SUMMARY#summary: }
$FINDINGS"; then
    log "alert sent"
  else
    log "ALERT NOT SENT (telegram unavailable) — findings above are the only record"
  fi
else
  log "no unaccepted high/critical findings — no alert"
fi
