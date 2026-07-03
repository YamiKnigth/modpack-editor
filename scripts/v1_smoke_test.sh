#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

api="http://localhost:3000"

echo "[smoke] health"
curl -fsS "$api/healthz" >/dev/null

echo "[smoke] create modpack"
create_payload='{"nombre":"Smoke Pack 1.20.1","versionMinecraft":"1.20.1","modloaderTipo":"Fabric","modloaderVersion":"0.16.10"}'
create_res=$(curl -fsS -X POST "$api/api/v1/modpacks" -H 'Content-Type: application/json' -d "$create_payload")
modpack_id=$(echo "$create_res" | node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(j.data.id));')

echo "[smoke] search mods"
search_res=$(curl -fsS "$api/api/v1/mods/search?modpackId=$modpack_id&searchFilter=create&pageSize=1")
project_id=$(echo "$search_res" | node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(j.data[0].projectId));')
file_id=$(echo "$search_res" | node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String((j.data[0].latestFiles||[])[0]?.fileId||""));')

if [[ -z "$file_id" ]]; then
  echo "No compatible file found in first search result"
  exit 1
fi

echo "[smoke] add mod"
add_payload=$(printf '{"curseforgeProjectId":%s,"curseforgeFileId":%s,"entornoDestino":"BOTH"}' "$project_id" "$file_id")
curl -fsS -X POST "$api/api/v1/modpacks/$modpack_id/mods" -H 'Content-Type: application/json' -d "$add_payload" >/dev/null

echo "[smoke] enqueue export"
export_res=$(curl -fsS -X POST "$api/api/v1/modpacks/$modpack_id/exports" -H 'Content-Type: application/json' -d '{"target":"BOTH"}')
job_id=$(echo "$export_res" | node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(j.data.id));')

echo "[smoke] wait job completion"
for _ in {1..30}; do
  status=$(curl -fsS "$api/api/v1/exports/$job_id" | node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(j.data.status));')
  if [[ "$status" == "completed" ]]; then
    break
  fi
  if [[ "$status" == "failed" ]]; then
    echo "Export failed"
    exit 1
  fi
  sleep 1
done

if [[ "$status" != "completed" ]]; then
  echo "Export job did not complete in time"
  exit 1
fi

echo "[smoke] download check"
curl -fsSI "$api/api/v1/exports/$job_id/download" >/dev/null

echo "Smoke test passed"
