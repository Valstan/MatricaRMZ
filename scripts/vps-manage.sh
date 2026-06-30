#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/valstan/MatricaRMZ"
BACKEND_DIR="$PROJECT_DIR/backend-api"
PRIMARY="matricarmz-backend-primary"
SECONDARY="matricarmz-backend-secondary"

usage() {
  cat <<'HELP'
MatricaRMZ VPS management — usage:
  vps-manage.sh <command>

Commands:
  status        Show backend services status
  logs [N]      Last N lines of primary backend log (default 80)
  logs2 [N]     Last N lines of secondary backend log
  restart       Restart primary -> health -> secondary
  stop          Stop both backend services
  start         Start primary -> health -> secondary
  build         Build backend (tsc) + shared + ledger
  deploy        git pull → pnpm install → build → restart
  deploy-quick  git pull → build → restart (skip install)
  migrate       Run drizzle DB migrations
  git-status    Show git status
  git-log [N]   Show last N commits (default 10)
  disk          Show disk usage
  health        Curl backend health endpoint
HELP
}

cmd_status() {
  systemctl status "$PRIMARY" "$SECONDARY" --no-pager -l 2>/dev/null || true
}

cmd_logs() {
  local n="${1:-80}"
  journalctl -u "$PRIMARY" --no-pager -n "$n" --output=short-iso
}

cmd_logs2() {
  local n="${1:-80}"
  journalctl -u "$SECONDARY" --no-pager -n "$n" --output=short-iso
}

wait_for_health() {
  local port="$1"
  local name="$2"
  local retries="${3:-30}"
  local i
  for ((i=1; i<=retries; i++)); do
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/health" 2>/dev/null || true)"
    if [[ "$code" == "200" ]]; then
      echo "  $name health ok on :$port"
      return 0
    fi
    sleep 1
  done
  echo "  $name health check failed on :$port" >&2
  return 1
}

cmd_restart() {
  echo ">>> Restarting $PRIMARY..."
  sudo systemctl restart "$PRIMARY"
  wait_for_health 3001 "$PRIMARY"
  echo ">>> Restarting $SECONDARY..."
  sudo systemctl restart "$SECONDARY"
  wait_for_health 3002 "$SECONDARY"
  cmd_status
}

cmd_stop() {
  sudo systemctl stop "$PRIMARY" "$SECONDARY"
  echo "Stopped."
}

cmd_start() {
  echo ">>> Starting $PRIMARY..."
  sudo systemctl start "$PRIMARY"
  wait_for_health 3001 "$PRIMARY"
  echo ">>> Starting $SECONDARY..."
  sudo systemctl start "$SECONDARY"
  wait_for_health 3002 "$SECONDARY"
  cmd_status
}

cmd_build() {
  cd "$PROJECT_DIR"
  echo ">>> Building shared + ledger + backend-api..."
  pnpm -C shared build 2>/dev/null || true
  pnpm -C ledger build
  pnpm -C backend-api build
  echo ">>> Build complete."
}

cmd_deploy() {
  cd "$PROJECT_DIR"
  echo ">>> git pull..."
  git pull --ff-only
  echo ">>> pnpm install..."
  pnpm install --frozen-lockfile
  cmd_build
  cmd_restart
  echo ">>> Deploy complete."
}

cmd_deploy_quick() {
  cd "$PROJECT_DIR"
  echo ">>> git pull..."
  git pull --ff-only
  cmd_build
  cmd_restart
  echo ">>> Quick deploy complete."
}

cmd_migrate() {
  cd "$BACKEND_DIR"
  echo ">>> Running DB migrations..."
  pnpm db:migrate
  echo ">>> Migrations complete."
}

cmd_git_status() {
  cd "$PROJECT_DIR"
  git status
}

cmd_git_log() {
  local n="${1:-10}"
  cd "$PROJECT_DIR"
  git log --oneline --graph -n "$n"
}

cmd_disk() {
  df -h / | tail -1
  echo ""
  du -sh "$PROJECT_DIR" "$BACKEND_DIR/dist" "$BACKEND_DIR/node_modules" 2>/dev/null
}

cmd_health() {
  echo "Primary (3001):"
  curl -s -o /dev/null -w "  HTTP %{http_code} in %{time_total}s\n" http://127.0.0.1:3001/health 2>/dev/null || echo "  UNREACHABLE"
  echo "Secondary (3002):"
  curl -s -o /dev/null -w "  HTTP %{http_code} in %{time_total}s\n" http://127.0.0.1:3002/health 2>/dev/null || echo "  UNREACHABLE"
}

case "${1:-}" in
  status)       cmd_status ;;
  logs)         cmd_logs "${2:-}" ;;
  logs2)        cmd_logs2 "${2:-}" ;;
  restart)      cmd_restart ;;
  stop)         cmd_stop ;;
  start)        cmd_start ;;
  build)        cmd_build ;;
  deploy)       cmd_deploy ;;
  deploy-quick) cmd_deploy_quick ;;
  migrate)      cmd_migrate ;;
  git-status)   cmd_git_status ;;
  git-log)      cmd_git_log "${2:-}" ;;
  disk)         cmd_disk ;;
  health)       cmd_health ;;
  *)            usage ;;
esac
