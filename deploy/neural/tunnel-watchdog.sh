#!/bin/bash
# Сторож туннеля движка (neural-vpn): проба туннеля, при отказе — переключение на
# следующий сервер из подписки. Fail-closed не нарушается: пока туннель лежит, у
# пользователя движка нет выхода вовсе — прямого пути в конфиге нет.
#
# Режимы:
#   (без аргументов) — живость туннеля по exit-IP; мёртв → следующий сервер без проверки
#                      движка (провайдера не спрашивает — квота не тратится);
#   --check          — то, что крутит таймер: живость туннеля + последний запрос Ииваныча
#                      в базе; если его обслужил не движок — холодная ротация;
#   --cold-rotate    — исчерпана квота free-тира: погасить движок, сменить сервер, поднять
#                      движок, спросить его одним коротким вопросом; повторять до ответа;
#   --find-exit      — как --cold-rotate, но по всему списку серверов (ATTEMPTS);
#   --dry-rotate     — собрать и проверить конфиг следующего сервера, ничего не применяя;
#   --force-rotate   — переключиться даже при живом туннеле (проверка механизма);
#   --test-alert     — отправить тестовое уведомление в Telegram.
set -u

CLIENT=/etc/neural/vpn/client.json
NEXT=/etc/neural/vpn/client.next.json
STATE=/etc/neural/vpn/current-server
BACKUPS=/etc/neural/vpn/backups
LOGFILE=/var/log/neural/tunnel-watchdog.log
PROBE=/usr/local/lib/neural/engine-probe.py
XRAY=/usr/local/bin/xray
REDIRECT=/usr/local/lib/neural/egress-redirect.sh
ENVFILE=/etc/matricarmz/matricarmz.env
PROBE_URL=https://api.ipify.org
REQ_STATE=/var/lib/neural/last-handled-request
ATTEMPTS=${ATTEMPTS:-21}
COLD_ATTEMPTS=${COLD_ATTEMPTS:-3}

mkdir -p "$(dirname "$LOGFILE")"
touch "$LOGFILE"
chmod 640 "$LOGFILE"

log() {
  printf '%s %s\n' "$(date -Is)" "$*" >> "$LOGFILE"
  logger -t tunnel-watchdog -- "$*" 2>/dev/null || true
}

probe() {
  curl -s --max-time 12 --socks5-hostname 127.0.0.1:10808 "$PROBE_URL" 2>/dev/null | tr -d '[:space:]'
}

alert() {
  [ -r "$ENVFILE" ] || { log "alert skipped: no env"; return 0; }
  (
    set -a; . "$ENVFILE"; set +a
    case "${MATRICA_TELEGRAM_ENABLED:-0}" in 1|true|yes|on) ;; *) exit 0 ;; esac
    [ -n "${MATRICA_TELEGRAM_BOT_TOKEN:-}" ] || exit 0
    [ -n "${MATRICA_TELEGRAM_ALERT_CHAT_ID:-}" ] || exit 0
    curl -s --max-time 15 -o /dev/null \
      "https://api.telegram.org/bot${MATRICA_TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${MATRICA_TELEGRAM_ALERT_CHAT_ID}" \
      --data-urlencode "text=$1" || true
  )
}

count_servers() {
  python3 -c 'import json;print(len(json.load(open("/etc/neural/vpn/servers.json"))))'
}

current_index() {
  if [ -r "$STATE" ]; then cat "$STATE"; return; fi
  python3 - <<'PY'
import json
servers = json.load(open('/etc/neural/vpn/servers.json'))
conf = json.load(open('/etc/neural/vpn/client.json'))
proxy = next(o for o in conf['outbounds'] if o.get('tag') == 'proxy')
vnext = proxy['settings']['vnext'][0]
for s in servers:
    if s['host'] == vnext['address'] and int(s['port']) == int(vnext['port']):
        print(s['i'])
        break
else:
    print(0)
PY
}

# $1 — индекс сервера; печатает имя сервера
render() {
  python3 - "$1" <<'PY'
import json, sys
idx = int(sys.argv[1])
servers = json.load(open('/etc/neural/vpn/servers.json'))
s = servers[idx]
conf = json.load(open('/etc/neural/vpn/client.json'))
user = {'id': s['uuid'], 'encryption': 'none'}
if s.get('flow'):
    user['flow'] = s['flow']
stream = {'network': s.get('network') or 'tcp', 'security': s.get('security') or 'reality'}
if stream['security'] == 'reality':
    stream['realitySettings'] = {
        'serverName': s.get('sni') or '',
        'fingerprint': s.get('fp') or 'chrome',
        'publicKey': s.get('pbk') or '',
        'shortId': s.get('sid') or '',
        'spiderX': '/',
    }
elif stream['security'] == 'tls':
    stream['tlsSettings'] = {'serverName': s.get('sni') or '', 'fingerprint': s.get('fp') or 'chrome'}
out = {
    'tag': 'proxy',
    'protocol': 'vless',
    'settings': {'vnext': [{'address': s['host'], 'port': int(s['port']), 'users': [user]}]},
    'streamSettings': stream,
}
conf['outbounds'] = [out if o.get('tag') == 'proxy' else o for o in conf['outbounds']]
json.dump(conf, open('/etc/neural/vpn/client.next.json', 'w'), ensure_ascii=False, indent=1)
print(s['name'])
PY
}

apply_client() {
  chown root:nogroup "$CLIENT" 2>/dev/null || true
  chmod 640 "$CLIENT" 2>/dev/null || true
  systemctl restart neural-vpn
  sleep 3
  sh "$REDIRECT" >/dev/null 2>&1 || log "redirect reapply failed"
}

wait_engine() {
  local k code
  for k in $(seq 1 40); do
    code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:49374/ 2>/dev/null)
    [ "$code" = "200" ] && return 0
    sleep 2
  done
  return 1
}

# Печатает JSON пробы движка; код 0 — движок ответил текстом
engine_probe() {
  (
    set -a; . "$ENVFILE"; set +a
    python3 "$PROBE"
  )
}

# Один шаг: поставить сервер $1. Код 0 — туннель поднялся и отдал exit-IP.
apply_server() {
  local idx=$1 name ip
  name=$(render "$idx") || { log "render failed for index $idx"; return 1; }
  if ! "$XRAY" run -test -config "$NEXT" >/dev/null 2>&1; then
    log "config invalid for $name (index $idx), skipped"
    return 1
  fi
  mv "$NEXT" "$CLIENT"
  apply_client
  ip=$(probe)
  if [ -z "$ip" ]; then
    log "$name gave no traffic, skipped"
    return 1
  fi
  echo "$idx" > "$STATE"
  log "applied $name (index $idx), exit=$ip"
  echo "$name|$ip"
  return 0
}

# Перебор серверов до первого, где движок ответил (обход квоты free-тира по сети)
find_exit() {
  local total start n idx applied name ip result
  total=$(count_servers)
  start=$(current_index)
  mkdir -p "$BACKUPS"
  cp -p "$CLIENT" "$BACKUPS/client.orig.json"
  for n in $(seq 1 "$ATTEMPTS"); do
    idx=$(( (start + n) % total ))
    applied=$(apply_server "$idx") || continue
    name=${applied%%|*}; ip=${applied##*|}
    result=$(engine_probe)
    if [ $? -eq 0 ]; then
      log "engine answered on $name (exit=$ip): $result"
      alert "Матрица: движок отвечает через «$name», exit-IP $ip"
      return 0
    fi
    log "engine did not answer on $name (exit=$ip): $result"
  done
  log "no server answered after $ATTEMPTS attempts; restoring previous config"
  cp -p "$BACKUPS/client.orig.json" "$CLIENT"
  apply_client
  alert "Матрица: ни один из $ATTEMPTS серверов ВПН не дал ответа движку — Ииваныч без серверного движка"
  return 1
}

# Холодная ротация: сначала гасим движок (иначе он держит keep-alive соединения
# со старым выходом и видит ту же квоту), потом меняем сервер, потом поднимаем.
cold_rotate() {
  local total start n idx applied name ip result
  total=$(count_servers)
  start=$(current_index)
  mkdir -p "$BACKUPS"
  cp -p "$CLIENT" "$BACKUPS/client.orig.json"
  for n in $(seq 1 "${COLD_ATTEMPTS}"); do
    idx=$(( (start + n) % total ))
    name=$(render "$idx") || { log "render failed for index $idx"; continue; }
    if ! "$XRAY" run -test -config "$NEXT" >/dev/null 2>&1; then
      log "config invalid for $name (index $idx), skipped"
      continue
    fi
    log "cold rotate: stopping engine before switch"
    systemctl stop opencode-web
    mv "$NEXT" "$CLIENT"
    apply_client
    ip=$(probe)
    if [ -z "$ip" ]; then
      log "tunnel gave no traffic on $name, restoring engine"
      systemctl start opencode-web
      continue
    fi
    systemctl start opencode-web
    wait_engine || { log "engine did not come up on $name"; continue; }
    result=$(engine_probe)
    if [ $? -eq 0 ]; then
      echo "$idx" > "$STATE"
      log "cold rotate ok: $name (index $idx), exit=$ip, engine answered"
      alert "Матрица: движок снова отвечает — сервер «$name», exit-IP $ip"
      return 0
    fi
    log "cold rotate: $name (exit=$ip) still no answer: $result"
  done
  log "cold rotate: no server produced an answer after $COLD_ATTEMPTS attempts"
  alert "Матрица: холодная ротация не вернула ответ движка (проверено $COLD_ATTEMPTS серверов)"
  return 1
}

# Поднять туннель на следующем сервере, НЕ спрашивая провайдера (дешёвый путь для таймера:
# живость туннеля видна по exit-IP, квота при этом не тратится).
rotate_tunnel() {
  local total start n idx applied name ip
  total=$(count_servers)
  start=$(current_index)
  for n in $(seq 1 4); do
    idx=$(( (start + n) % total ))
    applied=$(apply_server "$idx") || continue
    name=${applied%%|*}; ip=${applied##*|}
    log "tunnel restored on $name (index $idx), exit=$ip"
    alert "Матрица: туннель движка переключён на «$name», exit-IP $ip"
    return 0
  done
  log "no server gave traffic; engine has no egress"
  alert "Матрица: туннель движка не поднялся ни на одном сервере — Ииваныч без серверного движка"
  return 1
}

rotate() {
  local total start idx applied name ip result
  total=$(count_servers)
  start=$(current_index)
  mkdir -p "$BACKUPS"
  cp -p "$CLIENT" "$BACKUPS/client.orig.json"
  for n in $(seq 1 5); do
    idx=$(( (start + n) % total ))
    applied=$(apply_server "$idx") || continue
    name=${applied%%|*}; ip=${applied##*|}
    result=$(engine_probe)
    if [ $? -eq 0 ]; then
      log "rotated to $name (index $idx), exit=$ip, engine ok"
      alert "Матрица: выход движка переключён на «$name», exit-IP $ip"
      return 0
    fi
    log "tunnel is up on $name but engine did not answer: $result"
  done
  cp -p "$BACKUPS/client.orig.json" "$CLIENT"
  apply_client
  log "all attempts failed; previous config restored"
  alert "Матрица: ВПН движка не поднялся ни на одном сервере — Ииваныч без серверного движка"
  return 1
}

# Один SQL-запрос к PG бэкенда (учётные данные — из env бэкенда).
psql_at() {
  set -a; . "$ENVFILE"; set +a
  PGPASSWORD="${PGPASSWORD:-}" psql -h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5432}" \
    -U "${PGUSER:-postgres}" -d "${PGDATABASE:-matricarmz}" \
    -At -F '|' -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null
}

# Слежение за реальными запросами Ииваныча: если последний завершённый запрос
# обслужило не движок (answer_source != 'engine'), значит движок не смог ответить —
# это и есть повод для холодной ротации. Провайдера при этом не спрашиваем вовсе:
# единственный вопрос, который уйдёт в квоту, — тот, который оператор уже задал.
check_requests() {
  local row id status source created question handled age_min
  row=$(psql_at "select id,status,coalesce(answer_source,''),created_at from ai_chat_requests where deleted_at is null and status in ('answered','escalated') order by created_at desc limit 1")
  if [ -z "$row" ]; then log "check: завершённых запросов Ииваныча нет"; return 0; fi
  IFS='|' read -r id status source created <<< "$row"
  age_min=$(( ( $(date +%s) * 1000 - created ) / 60000 ))
  if [ "$age_min" -gt 360 ]; then log "check: свежих запросов нет (последний $age_min мин назад)"; return 0; fi
  if [ "$source" = "engine" ]; then
    echo "$id" > "$REQ_STATE"
    log "check: движок ответил на запрос $id ($age_min мин назад)"
    return 0
  fi
  handled=$(cat "$REQ_STATE" 2>/dev/null || true)
  if [ "$id" = "$handled" ]; then
    log "check: запрос $id уже отработан ротацией"
    return 0
  fi
  question=$(psql_at "select left(regexp_replace(question_text, '[[:space:]]+', ' ', 'g'), 400) from ai_chat_requests where id = '$id'")
  log "check: запрос $id не обслужен движком (status=$status, source=${source:-нет}) — холодная ротация"
  echo "$id" > "$REQ_STATE"
  ENGINE_PROBE_TEXT="${question:-Ответь одним словом: ок}" cold_rotate
}

case "${1:-}" in
  --check)
    ip=$(probe)
    if [ -z "$ip" ]; then
      sleep 3; ip=$(probe)
      if [ -z "$ip" ]; then
        log "check: туннель мёртв (нет exit-IP)"
        rotate_tunnel || exit 1
      fi
    fi
    check_requests
    ;;
  --dry-rotate)
    total=$(count_servers); start=$(current_index); idx=$(( (start + 1) % total ))
    name=$(render "$idx")
    if "$XRAY" run -test -config "$NEXT" >/dev/null 2>&1; then
      echo "dry-run ok: $name (index $idx)"
      rm -f "$NEXT"
    else
      echo "dry-run FAILED: $name (index $idx)"
      exit 1
    fi
    ;;
  --force-rotate)
    rotate
    ;;
  --find-exit)
    find_exit
    ;;
  --cold-rotate)
    cold_rotate
    ;;
  --test-alert)
    alert "Матрица: проверка уведомлений сторожа туннеля движка"
    echo "тестовое уведомление отправлено"
    ;;
  *)
    ip=$(probe)
    if [ -n "$ip" ]; then log "ok, exit=$ip"; exit 0; fi
    sleep 5
    ip=$(probe)
    if [ -n "$ip" ]; then log "ok after retry, exit=$ip"; exit 0; fi
    log "tunnel dead (no exit ip), rotating"
    rotate_tunnel
    ;;
esac
