#!/usr/bin/env bash
# Scans last N minutes of nginx access log, counts 401/403 per real client IP
# (extracted from X-Forwarded-For), sends Telegram alert if any IP exceeds threshold.
# Deduplicates via state file (one alert per IP per ALERT_COOLDOWN_MIN).

set -uo pipefail

ENV_FILE="${MATRICA_ENV_FILE:-/home/valstan/MatricaRMZ/backend-api/.env}"
NGINX_LOG="${MATRICA_NGINX_LOG:-/var/log/nginx/matricarmz_access.log}"
WINDOW_MINUTES="${MATRICA_AUTH_WINDOW_MIN:-5}"
THRESHOLD="${MATRICA_AUTH_THRESHOLD:-10}"
ALERT_COOLDOWN_MIN="${MATRICA_AUTH_COOLDOWN_MIN:-60}"
STATE_FILE="${MATRICA_AUTH_STATE_FILE:-/var/lib/matricarmz/watch-failed-auth.state}"

log() { printf '[%s] %s\n' "$(date +%FT%T%z)" "$*"; }

telegram_send() {
  local msg="$1"
  [[ "${MATRICA_TELEGRAM_ENABLED:-false}" == "true" ]] || { log "telegram disabled"; return 0; }
  [[ -n "${MATRICA_TELEGRAM_BOT_TOKEN:-}" && -n "${MATRICA_TELEGRAM_ALERT_CHAT_ID:-}" ]] || return 0
  curl -fsS -m 15 -o /dev/null \
    -d "chat_id=${MATRICA_TELEGRAM_ALERT_CHAT_ID}" \
    --data-urlencode "text=${msg}" \
    "https://api.telegram.org/bot${MATRICA_TELEGRAM_BOT_TOKEN}/sendMessage" || true
}

[[ -r "$ENV_FILE" ]] && { set -a; . "$ENV_FILE"; set +a; }

if [[ ! -r "$NGINX_LOG" ]]; then
  log "ERROR: nginx log not readable: $NGINX_LOG"
  exit 1
fi

mkdir -p "$(dirname "$STATE_FILE")"
touch "$STATE_FILE"

OUTPUT="$(python3 - "$NGINX_LOG" "$WINDOW_MINUTES" "$THRESHOLD" "$ALERT_COOLDOWN_MIN" "$STATE_FILE" <<'PY'
import json, os, re, sys, time
from datetime import datetime, timedelta, timezone

NGINX_LOG, WINDOW, THRESHOLD, COOLDOWN, STATE = sys.argv[1:6]
WINDOW = int(WINDOW); THRESHOLD = int(THRESHOLD); COOLDOWN = int(COOLDOWN)

# Match nginx 'main' log line; capture status code and X-Forwarded-For (real client IP).
LINE_RE = re.compile(
    r'^(?P<remote>\S+)\s+\S+\s+\S+\s+\[(?P<time>[^\]]+)\]\s+'
    r'"(?P<request>[^"]*)"\s+(?P<status>\d{3})\s+\d+\s+'
    r'"[^"]*"\s+"[^"]*"\s+"(?P<xff>[^"]*)"'
)

def parse_ts(s):
    try:
        return datetime.strptime(s, "%d/%b/%Y:%H:%M:%S %z").astimezone(timezone.utc)
    except Exception:
        return None

cutoff = datetime.now(timezone.utc) - timedelta(minutes=WINDOW)
counts = {}
sample_paths = {}

with open(NGINX_LOG, "rb") as f:
    try:
        f.seek(0, 2); size = f.tell()
        f.seek(max(0, size - 4 * 1024 * 1024))
    except Exception:
        pass
    for raw in f:
        try:
            line = raw.decode("utf-8", "replace")
        except Exception:
            continue
        m = LINE_RE.match(line)
        if not m:
            continue
        status = int(m.group("status"))
        if status not in (401, 403):
            continue
        ts = parse_ts(m.group("time"))
        if not ts or ts < cutoff:
            continue
        xff = m.group("xff").strip()
        ip = xff.split(",")[0].strip() if xff and xff != "-" else m.group("remote")
        if not ip:
            continue
        counts[ip] = counts.get(ip, 0) + 1
        req = m.group("request")
        path = req.split()[1] if " " in req else req
        sample_paths.setdefault(ip, [])
        if path not in sample_paths[ip] and len(sample_paths[ip]) < 3:
            sample_paths[ip].append(path)

# Dedup via state file: don't re-alert same IP within COOLDOWN
try:
    with open(STATE) as f:
        state = json.load(f)
except Exception:
    state = {}
now = int(time.time())
cooldown_sec = COOLDOWN * 60

violators = []
for ip, n in counts.items():
    if n < THRESHOLD:
        continue
    if now - int(state.get(ip, 0)) < cooldown_sec:
        continue
    violators.append((ip, n, sample_paths.get(ip, [])))
    state[ip] = now

state = {k: v for k, v in state.items() if now - int(v) < 24 * 3600}
with open(STATE, "w") as f:
    json.dump(state, f)

if not violators:
    print(f"OK: {sum(counts.values())} 401/403 across {len(counts)} IPs in last {WINDOW}m, no violators")
    sys.exit(0)

lines = [f"🚨 MatricaRMZ: brute-force suspected ({len(violators)} IP(s) in last {WINDOW}m, threshold={THRESHOLD}/window)"]
for ip, n, paths in sorted(violators, key=lambda x: -x[1])[:5]:
    lines.append(f"  {ip}: {n} 401/403, paths: {', '.join(paths) if paths else 'n/a'}")
print("\n".join(lines))
sys.exit(42)
PY
)"
RC=$?

if [[ $RC -eq 42 ]]; then
  log "alert triggered:"
  printf '%s\n' "$OUTPUT"
  telegram_send "$OUTPUT"
elif [[ $RC -eq 0 ]]; then
  log "$OUTPUT"
else
  log "ERROR: python script exited $RC, output: $OUTPUT"
  exit $RC
fi
