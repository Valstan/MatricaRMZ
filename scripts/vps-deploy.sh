#!/bin/bash
# Универсальный скрипт деплоя для VPS MatricaRMZ
# Использование: ssh -p 49412 valstan@SERVER 'bash -s' < scripts/vps-deploy.sh
set -e

cd /home/valstan/MatricaRMZ

echo "=== 1. Git sync ==="
git fetch origin --prune
git pull --ff-only origin main
echo "Current: $(git log -n 1 --oneline)"

echo "=== 2. Install & build ==="
pnpm install --frozen-lockfile 2>&1 | tail -3
pnpm --filter @matricarmz/shared build 2>&1 | tail -3
pnpm --filter @matricarmz/backend-api build 2>&1 | tail -3

echo "=== 3. Restart primary ==="
sudo systemctl restart matricarmz-backend-primary
sleep 8
PRIMARY=$(curl -s --max-time 10 http://127.0.0.1:3001/health)
echo "Primary: $PRIMARY"

echo "=== 4. Restart secondary ==="
sudo systemctl restart matricarmz-backend-secondary
sleep 6
SECONDARY=$(curl -s --max-time 10 http://127.0.0.1:3002/health)
echo "Secondary: $SECONDARY"

echo "=== 5. Final check ==="
systemctl is-active matricarmz-backend-primary matricarmz-backend-secondary nginx
echo "Git: $(git log -n 1 --oneline)"

echo "=== DEPLOY COMPLETE ==="
