#!/usr/bin/env bash
# Выкат бэкенда: забрать собранное с раннера и перезапустить сервисы.
#
# Прод НЕ собирает то, что исполняет. Он это скачивает. Причина не стилистическая: бокс —
# OpenVZ-контейнер с 1536 МБ и без права на swap (ядро отказывает в `swapon` даже из-под root),
# и `tsc` там убивает OOM-killer. Обнаружилось это при выкате исправления, то есть ровно тогда,
# когда нужна была способность выкатывать.
#
# Порядок перезапуска — последовательный (primary → health → secondary): singleton-задания
# живут на primary, и одновременный рестарт обоих оставил бы парк без API.
#
#   scripts/prod-ops/deploy-backend.sh              # из последней успешной сборки main
#   scripts/prod-ops/deploy-backend.sh <run-id>     # из конкретного прогона
#   scripts/prod-ops/deploy-backend.sh snapshot     # копия текущего dist в .deploy-backup, без рестарта
#   scripts/prod-ops/deploy-backend.sh rollback [<стамп>]   # вернуть копию (по умолчанию — последнюю) и перезапустить
#
# `rollback` — команда скрипта, а не рецепт в доке (brain #324/G373): откат, который живёт
# только в инструкции, при приёмке не прогоняется и в день отказа делается впервые.
# Репетиция на живом проде без смены версии: `snapshot` → `rollback` (dist тот же, механика
# копирования, порядок рестарта и health-гейты — настоящие).
#
# Требует `gh` (авторизован) и права на systemctl для юнитов Матрицы.

set -euo pipefail

REPO_DIR="${MATRICA_REPO_DIR:-$HOME/MatricaRMZ}"
WORKFLOW="${MATRICA_DIST_WORKFLOW:-backend-dist.yml}"
ARTIFACT="${MATRICA_DIST_ARTIFACT:-backend-dist}"
COMMAND="${1:-}"
RUN_ID=""
case "$COMMAND" in
  snapshot|rollback) ;;
  *) RUN_ID="$COMMAND"; COMMAND="deploy" ;;
esac

log() { printf '[%s] %s\n' "$(date +%FT%T%z)" "$*"; }

# Тот же список, что пакует `.github/workflows/backend-dist.yml` — менять парой. `web-admin/dist`
# здесь с 21.09: бэкенд раздаёт админку как `/admin-ui` из этого каталога, и без него в архиве
# она на проде обновлялась руками и отставала от кода.
PATHS=(backend-api/dist backend-api/drizzle shared/dist ledger/dist web-admin/dist)

BACKUP_ROOT="$REPO_DIR/.deploy-backup"
BACKUP_KEEP="${MATRICA_DEPLOY_BACKUP_KEEP:-3}"

# Окно ожидания — по канону (AGENTS.md §Release, GOTCHAS M100): primary поднимает фоновую
# обвязку и биндится ~50 с, поэтому меньше 90 с брать нельзя — иначе здоровый выкат объявляется
# упавшим и откат стреляет по исправному. `systemctl is-active` за готовность не считаем:
# он печатает active до бинда. Здесь было 60 с.
PRIMARY_WAIT="${MATRICA_DEPLOY_PRIMARY_WAIT:-120}"
SECONDARY_WAIT="${MATRICA_DEPLOY_SECONDARY_WAIT:-60}"

snapshot_to() {
  local dest="$1" p
  for p in "${PATHS[@]}"; do
    if [[ -e "$REPO_DIR/$p" ]]; then
      mkdir -p "$dest/$(dirname "$p")"
      cp -a "$REPO_DIR/$p" "$dest/$p"
    fi
  done
}

restore_from() {
  local src="$1" p
  for p in "${PATHS[@]}"; do
    [[ -e "$src/$p" ]] || continue
    rm -rf "${REPO_DIR:?}/$p"
    mkdir -p "$(dirname "$REPO_DIR/$p")"
    cp -a "$src/$p" "$REPO_DIR/$p"
  done
}

restart_one() {
  local unit="$1" port="$2" wait_s="$3" waited=0
  log "перезапуск $unit (жду до $wait_s с)"
  sudo -n systemctl restart "$unit"
  while (( waited < wait_s )); do
    sleep 2
    waited=$((waited + 2))
    if curl -fs "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      log "$unit отвечает через $waited с"
      return 0
    fi
  done
  log "$unit НЕ поднялся за $wait_s с"
  return 1
}

if [[ "$COMMAND" == "snapshot" ]]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  log "snapshot: копирую текущий dist в .deploy-backup/$STAMP (без рестарта)"
  snapshot_to "$BACKUP_ROOT/$STAMP"
  log "готово: .deploy-backup/$STAMP"
  exit 0
fi

if [[ "$COMMAND" == "rollback" ]]; then
  STAMP="${2:-}"
  if [[ -z "$STAMP" ]]; then
    STAMP="$(ls -1 "$BACKUP_ROOT" 2>/dev/null | sort -r | head -n 1)"
  fi
  [[ -n "$STAMP" && -d "$BACKUP_ROOT/$STAMP" ]] || { log "rollback: копии '$STAMP' нет в .deploy-backup"; exit 1; }
  log "rollback: возвращаю dist из .deploy-backup/$STAMP"
  restore_from "$BACKUP_ROOT/$STAMP"
  restart_one matricarmz-backend-primary 3001 "$PRIMARY_WAIT" || { log "rollback: primary не поднялся на копии $STAMP — смотреть journalctl -u matricarmz-backend-primary"; exit 1; }
  restart_one matricarmz-backend-secondary 3002 "$SECONDARY_WAIT" || { log "rollback: secondary не поднялся — primary здоров, парк обслуживается одним инстансом"; exit 1; }
  log "готово: откат на $STAMP, $(curl -fsk https://127.0.0.1/health || echo 'nginx не ответил')"
  exit 0
fi

command -v gh >/dev/null || { log "gh не установлен — без него артефакт не забрать"; exit 1; }
gh auth status >/dev/null 2>&1 || { log "gh не авторизован"; exit 1; }

cd "$REPO_DIR"

# Исходники всё равно подтягиваем: по ним живут миграции, скрипты обслуживания и история.
# Собранное придёт отдельно и ляжет поверх.
log "git pull"
git pull --ff-only

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(gh run list --workflow "$WORKFLOW" --branch main --status success --limit 1 --json databaseId --jq '.[0].databaseId')"
  [[ -n "$RUN_ID" && "$RUN_ID" != "null" ]] || { log "нет успешных прогонов $WORKFLOW на main"; exit 1; }
fi

HEAD_SHA="$(gh run view "$RUN_ID" --json headSha --jq '.headSha')"
LOCAL_SHA="$(git rev-parse HEAD)"
log "прогон $RUN_ID собран на ${HEAD_SHA:0:8}, локально ${LOCAL_SHA:0:8}"
if [[ "$HEAD_SHA" != "$LOCAL_SHA" ]]; then
  # Не отказ: бывает законно (выкатывают предыдущую сборку намеренно). Но сказать обязаны —
  # молча разъехавшиеся исходники и dist потом стоят часов разбирательства.
  log "ВНИМАНИЕ: собранное и исходники в клоне — с разных коммитов"
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
log "скачиваю артефакт $ARTIFACT"
gh run download "$RUN_ID" --name "$ARTIFACT" --dir "$STAGE"
TARBALL="$STAGE/backend-dist.tar.gz"
[[ -f "$TARBALL" ]] || { log "в артефакте нет backend-dist.tar.gz"; exit 1; }

# Разворачиваем во временный каталог и проверяем, что внутри действительно то, что ждём:
# распаковка сразу поверх рабочего дерева при битом архиве оставила бы половину старого dist
# и половину нового — худшее из состояний.
log "проверяю содержимое"
tar -xzf "$TARBALL" -C "$STAGE"
for p in backend-api/dist/index.js shared/dist ledger/dist web-admin/dist/index.html; do
  [[ -e "$STAGE/$p" ]] || { log "в архиве нет $p — выкат отменён"; exit 1; }
done

# Рантаймовые зависимости проверяем ДО сноса. Артефакт несёт только собранное; `dependencies`
# приезжают с `git pull`, а ставит их человек отдельным фильтрованным install'ом (см. AGENTS.md
# §Release). Пропущенный install виден иначе только после `rm -rf` — сервис не поднимается с
# MODULE_NOT_FOUND, а возвращаться уже некуда.
missing_runtime_deps() {
  local names dep missing=""
  names="$(node -p 'Object.keys(require("./backend-api/package.json").dependencies||{}).join(" ")' 2>/dev/null)" || return 0
  for dep in $names; do
    case "$dep" in
      @matricarmz/*) continue ;;  # workspace-пакеты приезжают этим же архивом
    esac
    [[ -e "$REPO_DIR/backend-api/node_modules/$dep" ]] || missing="$missing $dep"
  done
  printf '%s' "${missing# }"
}

MISSING="$(missing_runtime_deps)"
if [[ -n "$MISSING" ]]; then
  log "рантаймовые зависимости не установлены:$(printf ' %s' $MISSING)"
  log "выкат отменён ДО замены dist — прежний остался на месте и работает"
  log "поставить: corepack pnpm install --filter \"@matricarmz/backend-api...\" && node scripts/prod-ops/prune-virtual-store.mjs"
  exit 1
fi

# Резервная копия прежнего dist. Раньше её не было вовсе: скрипт сносил `rm -rf` и клал новое,
# а вернуться можно было только повторным выкатом прошлого артефакта — который живёт
# retention-days: 14. Старше двух недель откатываться было не на что.
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_ROOT/$STAMP"

log "сохраняю прежний dist в .deploy-backup/$STAMP"
snapshot_to "$BACKUP"

log "раскладываю"
restore_from "$STAGE"

restore_backup() {
  log "ОТКАТ: возвращаю dist из .deploy-backup/$STAMP"
  restore_from "$BACKUP"
}

if ! restart_one matricarmz-backend-primary 3001 "$PRIMARY_WAIT"; then
  # Secondary ещё не перезапускали — он держит парк на прежнем коде из памяти. Но новый dist
  # уже на диске, общий для обоих юнитов, и secondary подхватил бы его при любом рестарте.
  # Поэтому откат обязателен, а не желателен.
  restore_backup
  if restart_one matricarmz-backend-primary 3001 "$PRIMARY_WAIT"; then
    log "откат удался: primary снова на прежнем dist, secondary не трогали"
  else
    log "ОТКАТ НЕ ПОМОГ — primary не поднимается и на прежнем dist. Дело не в выкате."
    log "прежний dist лежит в .deploy-backup/$STAMP; смотреть journalctl -u matricarmz-backend-primary"
  fi
  exit 1
fi

if ! restart_one matricarmz-backend-secondary 3002 "$SECONDARY_WAIT"; then
  # Primary уже здоров на новом dist — откатывать всё назад дороже, чем чинить secondary:
  # парк обслуживается. Поэтому громко говорим и выходим с ошибкой, но dist не трогаем.
  log "secondary не поднялся, primary здоров на новом dist — парк обслуживается одним инстансом"
  log "прежний dist для ручного отката: .deploy-backup/$STAMP"
  exit 1
fi

# Чистим старые копии только после успеха: упавший выкат оставляет их все.
if [[ -d "$BACKUP_ROOT" ]]; then
  mapfile -t OLD < <(ls -1 "$BACKUP_ROOT" 2>/dev/null | sort -r | tail -n "+$((BACKUP_KEEP + 1))")
  for old in "${OLD[@]}"; do
    [[ -n "$old" ]] && rm -rf "${BACKUP_ROOT:?}/$old"
  done
fi

log "готово: $(curl -fsk https://127.0.0.1/health || echo 'nginx не ответил')"
log "откат при нужде: bash scripts/prod-ops/deploy-backend.sh rollback $STAMP"
