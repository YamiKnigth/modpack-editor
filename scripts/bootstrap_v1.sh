#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[1/4] Installing npm dependencies..."
npm install

echo "[2/4] Starting docker services..."
docker compose up -d --build database cache-broker backend-api queue-worker frontend

echo "[3/4] Running DB migration..."
docker compose exec -T backend-api npm run migrate

echo "[4/4] Checking health endpoint..."
curl -fsS http://localhost:3000/healthz >/dev/null

echo "V1 bootstrap completed"
echo "API: http://localhost:3000"
echo "UI:  http://localhost:8080"
