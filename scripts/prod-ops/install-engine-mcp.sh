#!/usr/bin/env bash
# Поставить серверному движку (контур A) инструменты Ииваныча: MCP-прокси в
# /opt/matricarmz/mcp + конфиг движка с адресом и токеном loopback-моста бэкенда.
#
# Зачем скриптом, а не руками: движку инструменты задаются ТОЛЬКО конфигом движка
# (в POST /api/session полей mcp/tools нет), а конфиг лежит в домашнем каталоге
# пользователя opencode — писать туда может только root. Скрипт делает это
# повторяемо и проверяет результат.
#
# Требования:
#   * бэкенд уже поднят с AI_SERVER_ENGINE_TOOLS_TOKEN (мост слушает loopback);
#   * запуск от пользователя бэкенда (valstan) с passwordless sudo.
#
# Использование: bash scripts/prod-ops/install-engine-mcp.sh [путь к репо]
set -euo pipefail

REPO_DIR="${1:-$HOME/MatricaRMZ}"
ENV_FILE=/etc/matricarmz/matricarmz.env
ENGINE_ENV=/etc/opencode-web/anon.env
ENGINE_URL=http://127.0.0.1:49374
TARGET_DIR=/opt/matricarmz/mcp
CONFIG_DIR=/home/opencode/.config/opencode
CONFIG_FILE="$CONFIG_DIR/opencode.json"
PROXY_SRC="$REPO_DIR/scripts/prod-ops/engine-mcp/matrica-engine-mcp.cjs"
BRIDGE_PORT="${AI_SERVER_ENGINE_TOOLS_PORT:-49390}"

[ -f "$PROXY_SRC" ] || { echo "нет файла прокси: $PROXY_SRC" >&2; exit 1; }

TOKEN=$(sudo -n grep -E '^AI_SERVER_ENGINE_TOOLS_TOKEN=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)
if [ -z "$TOKEN" ]; then
  echo "в $ENV_FILE нет AI_SERVER_ENGINE_TOOLS_TOKEN — сначала пропиши токен моста" >&2
  exit 2
fi

echo "== прокси =="
sudo -n install -d -m 755 "$TARGET_DIR"
sudo -n install -m 644 "$PROXY_SRC" "$TARGET_DIR/matrica-engine-mcp.cjs"
ls -l "$TARGET_DIR/matrica-engine-mcp.cjs"

echo "== конфиг движка =="
CONFIG_JSON=$(mktemp)
cat > "$CONFIG_JSON" <<JSON
{
  "mcp": {
    "matrica": {
      "type": "local",
      "command": ["/usr/bin/node", "$TARGET_DIR/matrica-engine-mcp.cjs"],
      "environment": {
        "MATRICA_TOOLS_URL": "http://127.0.0.1:$BRIDGE_PORT",
        "MATRICA_TOOLS_TOKEN": "$TOKEN"
      }
    }
  }
}
JSON
sudo -n install -d -m 755 -o opencode -g opencode "$CONFIG_DIR"
if sudo -n test -f "$CONFIG_FILE"; then
  sudo -n cp -a "$CONFIG_FILE" "$CONFIG_FILE.bak.$(date +%Y%m%d-%H%M%S)"
fi
sudo -n install -m 600 -o opencode -g opencode "$CONFIG_JSON" "$CONFIG_FILE"
rm -f "$CONFIG_JSON"

echo "== перезапуск движка =="
sudo -n systemctl restart opencode-web.service
for _ in $(seq 1 30); do
  if curl -fsS "$ENGINE_URL/api/config" -o /dev/null 2>/dev/null; then break; fi
  if [ -n "$(sudo -n cat "$ENGINE_ENV" 2>/dev/null | grep -E '^OPENCODE_SERVER_PASSWORD=' || true)" ]; then
    ENGINE_TOKEN=$(sudo -n grep -E '^OPENCODE_SERVER_PASSWORD=' "$ENGINE_ENV" | head -1 | cut -d= -f2-)
    if curl -fsS -u "opencode:$ENGINE_TOKEN" "$ENGINE_URL/api/config" -o /dev/null 2>/dev/null; then break; fi
  fi
  sleep 2
done

echo "== проверка: какие MCP-серверы видит движок =="
ENGINE_TOKEN=$(sudo -n grep -E '^OPENCODE_SERVER_PASSWORD=' "$ENGINE_ENV" | head -1 | cut -d= -f2-)
# Движок подключает MCP-серверы лениво: сразу после рестарта /api/mcp бывает пуст
# и наполняется через несколько секунд. Проверяем не «в один заход», а ждём.
MCP_OUT=""
for _ in $(seq 1 30); do
  MCP_OUT=$(curl -fsS -u "opencode:$ENGINE_TOKEN" "$ENGINE_URL/api/mcp" || true)
  if printf '%s' "$MCP_OUT" | grep -q 'matrica'; then break; fi
  sleep 2
done
echo "$MCP_OUT"
if printf '%s' "$MCP_OUT" | grep -q 'matrica'; then
  echo "OK: движок видит MCP-сервер matrica"
else
  echo "ВНИМАНИЕ: в /api/mcp нет matrica — смотри journalctl -u opencode-web.service" >&2
  exit 3
fi
