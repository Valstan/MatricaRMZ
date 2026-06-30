#!/bin/bash
set -e

cd /home/valstan/MatricaRMZ

echo "=== 1. Git sync ==="
git fetch origin --prune
git pull --ff-only origin main
git log -n 2 --oneline

echo "=== 2. Install & build ==="
pnpm install --frozen-lockfile 2>&1 | tail -3
pnpm --filter @matricarmz/shared build 2>&1 | tail -3
pnpm --filter @matricarmz/backend-api build 2>&1 | tail -3

echo "=== 3. Restart primary ==="
sudo systemctl restart matricarmz-backend-primary
sleep 8
echo "Primary health:"
curl -s --max-time 10 http://127.0.0.1:3001/health
echo ""

echo "=== 4. Restart secondary ==="
sudo systemctl restart matricarmz-backend-secondary
sleep 6
echo "Secondary health:"
curl -s --max-time 10 http://127.0.0.1:3002/health
echo ""

echo "=== 5. Final check ==="
systemctl is-active matricarmz-backend-primary matricarmz-backend-secondary nginx
git -C /home/valstan/MatricaRMZ log -n 1 --oneline

echo "=== DONE ==="
