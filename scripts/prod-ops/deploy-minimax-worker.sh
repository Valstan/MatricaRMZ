#!/usr/bin/env bash
# Раскатка воркера MiniMax на проде: проверки + план. По умолчанию НИЧЕГО НЕ МЕНЯЕТ.
#
# Зачем отдельный скрипт, если есть `deploy/systemd/install-backend.sh` и `deploy-backend.sh`:
#   - юнит воркера ставит install-backend.sh, а код воркера едет с dist (deploy-backend.sh);
#   - НО между этими шагами и включением звена есть окно, где воркер молча не работает:
#     каталог профилей не создан (EACCES → тихий уход на платного страхователя), пин
#     адресов не на месте (агент не доходит до MiniMax), в юните нет
#     MATRICA_INSTANCE_ROLE=worker (юнит поднимет ВТОРОЙ набор фоновых задач, и очередь
#     ИИваныча разберётся дважды). Скрипт закрывает это окно проверками ДО включения.
#
# ПО УМОЛЧАНИЮ — DRY-RUN: на машине ничего не меняется, печатаются план и результаты
# проверок. Реальные действия — только с --apply.
#
#   bash scripts/prod-ops/deploy-minimax-worker.sh            # dry-run (по умолчанию)
#   bash scripts/prod-ops/deploy-minimax-worker.sh --dry-run  # то же самое, явно
#   bash scripts/prod-ops/deploy-minimax-worker.sh --apply    # включить и поднять воркер
#
# Коды возврата:
#   0 — всё готово (dry-run: проверки пройдены; apply: воркер поднят, /health отвечает);
#   1 — блокер: раскатывать нечего (нет backend-api/dist/minimaxWorker/index.js) либо
#       --apply не смог поднять воркер;
#   2 — dry-run: часть проверок не прошла, но это НЕ блокер (пин не на месте, звено не
#       включено, каталог профилей не создан) — печатаются список и подсказки.
#
# Переопределяемые пути (приёмка гоняет на фикстуре): MATRICA_REPO_DIR, MATRICA_ENV_FILE,
# MINIMAX_ACCOUNTS_DIR, MINIMAX_CLI, MATRICA_MINIMAX_WORKER_URL.
#
# Секреты в выводе не печатаются: значение токена пула не показываем — только факт, что
# ключ в env-файле есть.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${MATRICA_REPO_DIR:-$HOME/MatricaRMZ}"
ENV_FILE="${MATRICA_ENV_FILE:-/etc/matricarmz/matricarmz.env}"
ACCOUNTS_DIR="${MINIMAX_ACCOUNTS_DIR:-/opt/minimax-accounts}"
CLI="${MINIMAX_CLI:-mcode}"
WORKER_URL="${MATRICA_MINIMAX_WORKER_URL:-http://127.0.0.1:3010/v1/messages}"
HEALTH_URL="${WORKER_URL%/v1/messages}/health"
HEALTH_WAIT="${MATRICA_MINIMAX_WORKER_HEALTH_WAIT:-20}"
WORKER_UNIT="matricarmz-minimax-worker.service"
PIN_UNIT="matricarmz-minimax-dns-pin.service"
PIN_TIMER="matricarmz-minimax-dns-pin.timer"

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) APPLY=0 ;;
    --apply) APPLY=1 ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) printf 'НЕПОНЯТНЫЙ АРГУМЕНТ: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

PROBLEMS=0
BLOCKERS=0
PIN_STATE="unknown"

ok()       { printf 'OK: %s\n' "$*"; }
problem()  { printf 'ПРОБЛЕМА: %s\n' "$*"; PROBLEMS=$((PROBLEMS + 1)); }
blocker()  { printf 'БЛОКЕР: %s\n' "$*"; BLOCKERS=$((BLOCKERS + 1)); }
softnote() { printf 'ПОДСКАЗКА: %s\n' "$*"; PROBLEMS=$((PROBLEMS + 1)); }
hint()     { printf '    подсказка: %s\n' "$*"; }
note()     { printf '%s\n' "$*"; }

# Поле из JSON-ответа воркера. Ключи в /health безопасные (токенов там нет).
json_field() {
  printf '%s' "$1" | grep -o "\"$2\":[^,}]*" | head -n1 | sed -e 's/^[^:]*://' -e 's/[" ]//g'
}

if [[ "$APPLY" -eq 1 ]]; then
  printf '== Раскатка воркера MiniMax (--apply: включаю и поднимаю воркер)\n'
else
  printf '== Раскатка воркера MiniMax (dry-run: на машине ничего не меняется)\n'
fi
printf '   репозиторий: %s\n' "$REPO_DIR"
printf '   env-файл:    %s\n' "$ENV_FILE"
printf '   профили:     %s\n' "$ACCOUNTS_DIR"
printf '   CLI:         %s\n' "$CLI"
printf '   health:      %s\n' "$HEALTH_URL"
printf '\n== Проверки\n'

# 1. Код воркера. Без него юнит поднимется и сразу умрёт — раскатывать нечего.
WORKER_ENTRY="$REPO_DIR/backend-api/dist/minimaxWorker/index.js"
if [[ ! -d "$REPO_DIR" ]]; then
  blocker "репозиторий не найден: $REPO_DIR"
  hint "MATRICA_REPO_DIR должен указывать на клон на боксе (обычно $HOME/MatricaRMZ)"
elif [[ ! -f "$WORKER_ENTRY" ]]; then
  blocker "нет $WORKER_ENTRY — воркер не запустится"
  hint "сначала выложить код: bash scripts/prod-ops/deploy-backend.sh"
else
  ok "код воркера на месте: $WORKER_ENTRY"
fi

# 2. Роль worker в юните. Без неё юнит поднимает второй набор фоновых задач бэкенда —
#    и очередь ИИваныча разбирается дважды (services/instanceRole.ts).
UNIT_TEMPLATE="$REPO_DIR/deploy/systemd/matricarmz-minimax-worker.service"
[[ -f "$UNIT_TEMPLATE" ]] || UNIT_TEMPLATE="$SCRIPT_DIR/../../deploy/systemd/matricarmz-minimax-worker.service"
if [[ ! -f "$UNIT_TEMPLATE" ]]; then
  problem "шаблон юнита воркера не найден — нечем подтвердить MATRICA_INSTANCE_ROLE=worker"
  hint "шаблон лежит в deploy/systemd/matricarmz-minimax-worker.service"
elif grep -qE '^[[:space:]]*Environment=MATRICA_INSTANCE_ROLE=worker[[:space:]]*$' "$UNIT_TEMPLATE"; then
  ok "MATRICA_INSTANCE_ROLE=worker в юните — второй набор фоновых задач не поднимется"
else
  problem "в юните нет MATRICA_INSTANCE_ROLE=worker — юнит поднимет ВТОРОЙ набор фоновых задач, и очередь ИИваныча разберётся дважды"
  hint "дописать в deploy/systemd/matricarmz-minimax-worker.service: Environment=MATRICA_INSTANCE_ROLE=worker"
fi

# 3. Каталог профилей. /opt принадлежит root, а юнит работает от сервисного пользователя:
#    без каталога первая же аренда упадёт на mkdir с EACCES (тихий уход на DeepSeek).
if [[ ! -d "$ACCOUNTS_DIR" ]]; then
  problem "каталог профилей не создан: $ACCOUNTS_DIR"
  hint "sudo mkdir -p $ACCOUNTS_DIR && sudo chown $(id -un):$(id -gn) $ACCOUNTS_DIR"
elif [[ ! -w "$ACCOUNTS_DIR" ]]; then
  OWNER="$(stat -c '%U:%G' "$ACCOUNTS_DIR" 2>/dev/null || echo 'владелец неизвестен')"
  problem "каталог профилей $ACCOUNTS_DIR не доступен на запись (владелец $OWNER) — воркер упадёт на EACCES"
  hint "передать каталог сервисному пользователю: sudo chown -R $(id -un):$(id -gn) $ACCOUNTS_DIR"
else
  ok "каталог профилей доступен на запись: $ACCOUNTS_DIR"
fi

# 4. CLI MiniMax Code. В системном PATH его нет (юнит прописывает ~/.local/bin сам),
#    поэтому «не найден в PATH» — ещё не поломка.
if command -v "$CLI" >/dev/null 2>&1; then
  ok "CLI MiniMax Code доступен: $CLI -> $(command -v "$CLI")"
elif [[ -x "$HOME/.local/bin/$CLI" ]]; then
  ok "CLI лежит в ~/.local/bin — юнит видит его через PATH из шаблона юнита"
else
  problem "CLI MiniMax Code не найден: $CLI"
  hint "поставить в пользовательский префикс: npm i -g --prefix ~/.local @minimax-ai/code"
fi

# 5. Пин адресов MiniMax. Без него резолверы бокса отдают недоступные адреса Akamai,
#    и агент не доходит до MiniMax вовсе. Нет скрипта/питона — «не проверено», а не поломка.
PIN_SCRIPT="$REPO_DIR/scripts/prod-ops/minimax-dns-pin.py"
[[ -f "$PIN_SCRIPT" ]] || PIN_SCRIPT="$SCRIPT_DIR/minimax-dns-pin.py"
if [[ ! -f "$PIN_SCRIPT" ]]; then
  note "НЕ ПРОВЕРЕНО: скрипт пина не найден (scripts/prod-ops/minimax-dns-pin.py) — состояние пина неизвестно"
  PIN_STATE="unknown"
elif ! command -v python3 >/dev/null 2>&1; then
  note "НЕ ПРОВЕРЕНО: python3 не найден — состояние пина неизвестно"
  PIN_STATE="unknown"
else
  PIN_OUT="$(python3 "$PIN_SCRIPT" --check 2>&1)"
  PIN_RC=$?
  if [[ "$PIN_RC" -eq 0 ]]; then
    ok "пин адресов MiniMax на месте"
    [[ -n "$PIN_OUT" ]] && printf '%s\n' "$PIN_OUT" | sed 's/^/    /'
    PIN_STATE="ok"
  else
    problem "пин адресов MiniMax не на месте (--check вернул $PIN_RC)"
    [[ -n "$PIN_OUT" ]] && printf '%s\n' "$PIN_OUT" | sed 's/^/    /'
    PIN_STATE="broken"
  fi
fi

# 6. Env-файл и ключ токена пула. Значение ключа НЕ печатаем — только факт наличия.
if [[ ! -r "$ENV_FILE" ]]; then
  problem "env-файл не читается: $ENV_FILE"
  hint "файл принадлежит root:сервисный-пользователь (640) — читать его должен тот, кто в группе"
else
  if grep -qE '^[[:space:]]*KARMAN_MINIMAX_TOKEN=' "$ENV_FILE"; then
    ok "в env-файле есть ключ KARMAN_MINIMAX_TOKEN (значение не печатаю)"
  else
    problem "в env-файле нет ключа KARMAN_MINIMAX_TOKEN — пул Кармана не отдаст аккаунт"
    hint "ключ лежит в комнате Кармана под именем KARMAN_MINIMAX_TOKEN"
  fi
fi

# 7. Звено включено? Это НЕ ошибка: включать его надо только после успешного прогона
#    воркера, иначе каждый вопрос ИИваныча сжигает аккаунт пула впустую.
if [[ -r "$ENV_FILE" ]]; then
  PROVIDER="$(grep -E '^[[:space:]]*MATRICA_AI_PROVIDER=' "$ENV_FILE" | tail -n1 \
    | sed -e 's/^[^=]*=//' -e 's/[[:space:]"]//g')"
  if [[ "$PROVIDER" == "minimax" ]]; then
    ok "звено включено: MATRICA_AI_PROVIDER=minimax"
  else
    softnote "звено не включено — MATRICA_AI_PROVIDER задан не как minimax (это не ошибка)"
    hint "включать только ПОСЛЕ успешного прогона воркера: иначе аккаунты пула сгорают впустую"
  fi
fi

# 8. Живой воркер. Ответ /health безопасный: ключи есть, токенов нет.
HEALTH_BODY="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
if [[ -n "$HEALTH_BODY" ]]; then
  ok "воркер отвечает: $HEALTH_URL"
  printf '    %s\n' "$HEALTH_BODY"
  printf '    pool=%s agentsActive=%s agentsQueued=%s\n' \
    "$(json_field "$HEALTH_BODY" pool)" \
    "$(json_field "$HEALTH_BODY" agentsActive)" \
    "$(json_field "$HEALTH_BODY" agentsQueued)"
else
  note "воркер не отвечает на $HEALTH_URL — это и есть то, что раскатка чинит"
fi

printf '\n== План раскатки\n'
printf '  1. код воркера уже в backend-api/dist — раскладывает bash scripts/prod-ops/deploy-backend.sh\n'
printf '  2. юнит ставится отдельным шагом: bash deploy/systemd/install-backend.sh (юниты этот скрипт не трогает)\n'
printf '  3. sudo systemctl enable --now %s\n' "$WORKER_UNIT"
printf '  4. ждём /health до %s с\n' "$HEALTH_WAIT"
printf '  5. пин адресов — только если он не на месте: sudo systemctl enable --now %s && sudo systemctl start %s\n' \
  "$PIN_TIMER" "$PIN_UNIT"
printf '  6. переключение звена MATRICA_AI_PROVIDER=minimax — ПОСЛЕ успешного прогона воркера, вручную владельцем\n'

if (( BLOCKERS > 0 )); then
  printf '\n== Итог\n'
  printf '   блокеров: %d, мягких замечаний: %d\n' "$BLOCKERS" "$PROBLEMS"
  printf '   раскатка отменена — на машине ничего не изменено.\n'
  exit 1
fi

if [[ "$APPLY" -ne 1 ]]; then
  printf '\n== Итог\n'
  printf '   блокеров: 0, мягких замечаний: %d\n' "$PROBLEMS"
  if (( PROBLEMS > 0 )); then
    printf '   это НЕ блокер, но до включения звена замечания надо закрыть.\n'
    exit 2
  fi
  printf '   проверки пройдены — можно раскатывать: bash scripts/prod-ops/deploy-minimax-worker.sh --apply\n'
  exit 0
fi

printf '\n== Действия (--apply)\n'
printf 'юниты этот скрипт не трогает — ставит их install-backend.sh, отдельным шагом:\n'
printf '  bash deploy/systemd/install-backend.sh\n'

if [[ "$PIN_STATE" == "broken" ]]; then
  printf 'пин адресов MiniMax не на месте — включаю таймер пина и делаю разовую пробу:\n'
  printf '  sudo systemctl enable --now %s\n' "$PIN_TIMER"
  sudo systemctl enable --now "$PIN_TIMER"
  PIN_RC=$?
  printf '  sudo systemctl start %s\n' "$PIN_UNIT"
  sudo systemctl start "$PIN_UNIT"
  PIN_RC=$?
  if [[ "$PIN_RC" -ne 0 ]]; then
    problem "юниты пина не поднялись (код $PIN_RC) — без живых адресов агент не дойдёт до MiniMax"
    hint "sudo systemctl status $PIN_TIMER $PIN_UNIT"
  fi
elif [[ "$PIN_STATE" == "unknown" ]]; then
  printf 'состояние пина не проверено (нет скрипта или python3) — таймер пина не трогаю.\n'
  printf '  sudo systemctl enable --now %s && sudo systemctl start %s\n' "$PIN_TIMER" "$PIN_UNIT"
fi

printf 'включаю и поднимаю воркер:\n'
printf '  sudo systemctl enable --now %s\n' "$WORKER_UNIT"
sudo systemctl enable --now "$WORKER_UNIT"
ENABLE_RC=$?
if [[ "$ENABLE_RC" -ne 0 ]]; then
  problem "systemctl не смог включить $WORKER_UNIT (код $ENABLE_RC)"
  hint "юнит мог не стоять: bash deploy/systemd/install-backend.sh"
fi

printf 'жду ответа /health (до %s с):\n' "$HEALTH_WAIT"
WAITED=0
HEALTH_BODY=""
while (( WAITED < HEALTH_WAIT )); do
  HEALTH_BODY="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
  [[ -n "$HEALTH_BODY" ]] && break
  sleep 2
  WAITED=$((WAITED + 2))
done

printf '\n== Итог\n'
if [[ -n "$HEALTH_BODY" ]]; then
  ok "воркер поднят: $HEALTH_URL"
  printf '    %s\n' "$HEALTH_BODY"
  printf '    pool=%s agentsActive=%s agentsQueued=%s\n' \
    "$(json_field "$HEALTH_BODY" pool)" \
    "$(json_field "$HEALTH_BODY" agentsActive)" \
    "$(json_field "$HEALTH_BODY" agentsQueued)"
  printf 'переключение звена — ПОСЛЕ успешного прогона воркера (иначе аккаунты пула сгорают впустую), вручную владельцем:\n'
  printf "  sudo sed -i 's/^MATRICA_AI_PROVIDER=.*/MATRICA_AI_PROVIDER=minimax/' %s\n" "$ENV_FILE"
  printf '  (файл принадлежит root — сервисный пользователь в него не пишет; после правки — рестарт обоих инстансов бэкенда: sudo systemctl restart matricarmz-backend-primary.service matricarmz-backend-secondary.service)\n'
  printf '   блокеров: 0, мягких замечаний: %d\n' "$PROBLEMS"
  exit 0
fi

problem "воркер не ответил на $HEALTH_URL за ${HEALTH_WAIT} с — поднять не удалось"
hint "смотреть журнал: journalctl -u $WORKER_UNIT"
printf '   блокеров: 0, мягких замечаний: %d\n' "$PROBLEMS"
exit 1
