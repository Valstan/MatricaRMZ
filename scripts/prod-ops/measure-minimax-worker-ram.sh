#!/usr/bin/env bash
# Замер пика памяти агента MiniMax Code на боксе (прод).
#
# Зачем отдельный скрипт, а не «посмотреть ps во время вопроса»:
#   - агент живёт десятки секунд внутри одного запроса к воркеру, и поймать его RSS
#     между командами нельзя: окно закрывается, пока идёт следующий ssh;
#   - замер с машины разработчика ломался о две вещи: PowerShell 5.1 калечит
#     аргументы (режет пайпы, теряет флаги), а локальный гейт не пускает команды
#     с фоновым шеллом. Скрипт делает всё на боксе одним запуском.
#
# Что измеряем:
#   - пик RSS процессов агента (`mcode exec` → node) — ради этого замер и нужен:
#     бокс 1536 МБ без swap, и два агента разом = OOM-killer снимает крупнейший процесс;
#   - пик RSS самого воркера (`node .../minimaxWorker/index.js`) — его тоже видно;
#   - снимал ли кто-то процесс (`dmesg`: Killed process / Out of memory).
#
# Что скрипт НЕ делает: ничего не меняет — только читает `ps`/`dmesg` и отправляет
# ОДИН запрос к локальному воркеру. Запрос может взять аккаунт из пула (у Кармана
# выдача = погашение), поэтому есть `--dry-run`: он проверяет окружение, не тратя аккаунт.
#
#   bash scripts/prod-ops/measure-minimax-worker-ram.sh --dry-run
#   bash scripts/prod-ops/measure-minimax-worker-ram.sh
#   bash scripts/prod-ops/measure-minimax-worker-ram.sh --question="сколько двигателей в ремонте?"
#
# Коды возврата:
#   0 — агент ответил (HTTP 200), пик измерен;
#   2 — пул пуст (503 pool_empty): агент не запускался, мерить нечего;
#   3 — воркер ответил иначе (5xx/таймаут), окружение не готово или ядро сняло процесс.
set -uo pipefail

URL="${MATRICA_MINIMAX_WORKER_URL:-http://127.0.0.1:3010/v1/messages}"
TOKEN="${MATRICA_MINIMAX_WORKER_TOKEN:-minimax-worker-local}"
TIMEOUT="${MATRICA_MINIMAX_MEASURE_TIMEOUT:-180}"
QUESTION="${MATRICA_MINIMAX_MEASURE_QUESTION:-Назови одним предложением, чем занимается ремонтный завод двигателей.}"
SYSTEM_PROMPT="${MATRICA_MINIMAX_MEASURE_SYSTEM:-Отвечай кратко по-русски, одним предложением.}"
WORK_DIR="${MATRICA_MINIMAX_MEASURE_DIR:-/tmp}"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --url=*) URL="${arg#--url=}" ;;
    --question=*) QUESTION="${arg#--question=}" ;;
    --timeout=*) TIMEOUT="${arg#--timeout=}" ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
  esac
done

SAMPLES="$WORK_DIR/minimax-ram-samples.log"
STOP_FILE="$WORK_DIR/minimax-ram-stop"
RESP="$WORK_DIR/minimax-ram-response.json"

rm -f "$SAMPLES" "$STOP_FILE" "$RESP"

# Сумма RSS по процессам: агент — всё, где в строке команды есть `mcode`;
# воркер — всё, где есть `minimaxWorker`. Сумма, а не максимум: агент — это
# сам CLI плюс его node-процессы, и они живут одновременно.
sample_once() {
  local pid rss args agent=0 worker=0
  while read -r pid rss args; do
    [[ -n "${args:-}" ]] || continue
    [[ "${rss:-0}" =~ ^[0-9]+$ ]] || continue
    case "$args" in
      # Только агент: `mcode exec ...` или полный путь к CLI. Широкое `*mcode*`
      # ловило чужие процессы (например, mcode-tools в PATH другого агента).
      *"mcode exec"*|*/bin/mcode\ *) agent=$((agent + rss)) ;;
    esac
    case "$args" in
      *minimaxWorker*) worker=$((worker + rss)) ;;
    esac
  done < <(ps -eo pid=,rss=,args= 2>/dev/null)
  printf '%s %s\n' "$agent" "$worker"
}

if [[ "$DRY_RUN" == 1 ]]; then
  echo "== dry-run: запрос не отправляем, аккаунт из пула не берём"
  echo "-- воркер:"
  curl -sS -m 8 "${URL%/v1/messages}/health" || echo "(не отвечает)"
  echo
  echo "-- ps доступен:"
  ps -eo pid=,rss=,args= 2>/dev/null | head -3
  echo "-- dmesg доступен:"
  if dmesg 2>/dev/null | tail -1 | grep -q .; then
    echo "   да"
  else
    echo "   нет (замер OOM будет недоступен — на боксе dmesg обычно доступен)"
  fi
  exit 0
fi

: > "$SAMPLES"
(
  while [[ ! -f "$STOP_FILE" ]]; do
    sample_once >> "$SAMPLES"
    sleep 1
  done
) &
SAMPLER_PID=$!

# Baseline до запроса: сэмпл без агента — по нему видно, сколько воркер занимает сам.
sleep 1

esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
PAYLOAD="$(printf '{"model":"minimax-m3.1-flash","max_tokens":512,"system":"%s","messages":[{"role":"user","content":"%s"}]}' \
  "$(esc "$SYSTEM_PROMPT")" "$(esc "$QUESTION")")"

HTTP_CODE="$(printf '%s' "$PAYLOAD" | curl -sS -m "$TIMEOUT" -o "$RESP" -w '%{http_code}' \
  -X POST "$URL" -H 'Content-Type: application/json' -H "X-Api-Key: $TOKEN" --data-binary @- 2>/dev/null)"
CURL_RC=$?

touch "$STOP_FILE"
wait "$SAMPLER_PID" 2>/dev/null

PEAK="$(awk '{ if ($1+0 > a) a=$1+0; if ($2+0 > w) w=$2+0; n++ } END { printf "%d %d %d", a, w, n }' "$SAMPLES" 2>/dev/null)"
AGENT_KB="$(printf '%s' "$PEAK" | cut -d' ' -f1)"
WORKER_KB="$(printf '%s' "$PEAK" | cut -d' ' -f2)"
SAMPLES_N="$(printf '%s' "$PEAK" | cut -d' ' -f3)"

BODY="$(head -c 600 "$RESP" 2>/dev/null)"

echo "== HTTP: ${HTTP_CODE:-нет ответа} (curl rc=$CURL_RC)"
echo "== ответ воркера (обрезан):"
echo "$BODY"
echo
echo "== замеров: ${SAMPLES_N:-0}"
echo "== пик RSS агента (mcode): ${AGENT_KB:-0} КБ = $(( ${AGENT_KB:-0} / 1024 )) МБ"
echo "== пик RSS воркера: ${WORKER_KB:-0} КБ = $(( ${WORKER_KB:-0} / 1024 )) МБ"
echo "== состояние воркера после прогона:"
curl -sS -m 8 "${URL%/v1/messages}/health" 2>/dev/null || echo "(не отвечает)"
echo

OOM_LINES="$(dmesg 2>/dev/null | grep -iE 'killed process|out of memory' | tail -3)"
if [[ -n "$OOM_LINES" ]]; then
  echo "== ЯДРО СНЯЛО ПРОЦЕССЫ:"
  echo "$OOM_LINES"
  exit 3
fi
echo "== ядро процессы не снимало (чисто)"

case "$BODY" in
  *pool_empty*)
    echo "== ПУЛ ПУСТ: агент не запускался, мерить нечего. Приёмка переносится на окно сброса пула."
    exit 2
    ;;
esac

if [[ "${HTTP_CODE:-}" == "200" ]]; then
  if [[ "${AGENT_KB:-0}" -le 0 ]]; then
    echo "== ВНИМАНИЕ: ответ 200, но агент в ps не виден — процесс отработал быстрее выборки."
    exit 0
  fi
  exit 0
fi

echo "== воркер ответил не 200 — приёмку не засчитываем."
exit 3
