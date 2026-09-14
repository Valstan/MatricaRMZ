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
#
# Требует `gh` (авторизован) и права на systemctl для юнитов Матрицы.

set -euo pipefail

REPO_DIR="${MATRICA_REPO_DIR:-$HOME/MatricaRMZ}"
WORKFLOW="${MATRICA_DIST_WORKFLOW:-backend-dist.yml}"
ARTIFACT="${MATRICA_DIST_ARTIFACT:-backend-dist}"
RUN_ID="${1:-}"

log() { printf '[%s] %s\n' "$(date +%FT%T%z)" "$*"; }

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
for p in backend-api/dist/index.js shared/dist ledger/dist; do
  [[ -e "$STAGE/$p" ]] || { log "в архиве нет $p — выкат отменён"; exit 1; }
done

log "раскладываю"
for p in backend-api/dist backend-api/drizzle shared/dist ledger/dist; do
  rm -rf "${REPO_DIR:?}/$p"
  mkdir -p "$(dirname "$REPO_DIR/$p")"
  cp -a "$STAGE/$p" "$REPO_DIR/$p"
done

restart_one() {
  local unit="$1" port="$2"
  log "перезапуск $unit"
  sudo -n systemctl restart "$unit"
  for _ in $(seq 1 30); do
    sleep 2
    if curl -fs "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      log "$unit отвечает"
      return 0
    fi
  done
  log "$unit НЕ поднялся за 60 с — второй инстанс не трогаю"
  return 1
}

restart_one matricarmz-backend-primary 3001
restart_one matricarmz-backend-secondary 3002

log "готово: $(curl -fsk https://127.0.0.1/health || echo 'nginx не ответил')"
