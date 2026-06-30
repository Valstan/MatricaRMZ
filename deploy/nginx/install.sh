#!/usr/bin/env bash
# Применяет deploy/nginx/matricarmz-backend.conf на сервере.
#
# Шаги:
#   1. backup текущего конфига в /etc/nginx/conf.d/matricarmz-backend.conf.bak-<ts>
#   2. копирование из репо в /etc/nginx/conf.d/
#   3. nginx -t (валидация)
#   4. nginx -s reload (горячая перезагрузка)
#   5. smoke-test через curl https://127.0.0.1/health
#
# При любом fail после копирования — auto-rollback из backup'а.
#
# Запускать на проде:
#   bash deploy/nginx/install.sh
#
# Требует sudo (читает/пишет /etc/nginx/conf.d/, перезагружает nginx).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_CONF="$SCRIPT_DIR/matricarmz-backend.conf"
TARGET_CONF="/etc/nginx/conf.d/matricarmz-backend.conf"
BACKUP_DIR="/etc/nginx/conf.d"
TS="$(date +%Y%m%d_%H%M%S)"
BACKUP_PATH="$BACKUP_DIR/matricarmz-backend.conf.bak-$TS"

if [[ ! -f "$REPO_CONF" ]]; then
  echo "ERROR: repo config not found at $REPO_CONF" >&2
  exit 1
fi

echo "==> Backing up current config to $BACKUP_PATH"
sudo cp "$TARGET_CONF" "$BACKUP_PATH"

rollback() {
  echo "==> ROLLBACK: restoring $BACKUP_PATH"
  sudo cp "$BACKUP_PATH" "$TARGET_CONF"
  sudo nginx -t >&2 || true
  sudo nginx -s reload >&2 || true
}

echo "==> Installing new config from repo"
sudo cp "$REPO_CONF" "$TARGET_CONF"

echo "==> Validating nginx config (nginx -t)"
if ! sudo nginx -t; then
  rollback
  echo "ERROR: nginx -t failed, rolled back" >&2
  exit 2
fi

echo "==> Reloading nginx"
sudo nginx -s reload

sleep 1
echo "==> Smoke test: curl https://127.0.0.1/health"
if ! curl -fsSk https://127.0.0.1/health > /tmp/nginx-deploy-health.log 2>&1; then
  cat /tmp/nginx-deploy-health.log
  rollback
  echo "ERROR: /health failed after reload, rolled back" >&2
  exit 3
fi
cat /tmp/nginx-deploy-health.log
echo

echo "==> Done. Backup kept at $BACKUP_PATH"
echo "    Чтобы откатить вручную:"
echo "      sudo cp $BACKUP_PATH $TARGET_CONF && sudo nginx -s reload"
