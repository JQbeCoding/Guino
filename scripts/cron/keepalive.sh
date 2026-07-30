#!/usr/bin/env bash
# Ping Guino so hosts like Render free tier stay awake (no CRON_SECRET required).
set -euo pipefail

BASE="${GUINO_BASE_URL:-http://127.0.0.1:8000}"
URL="${BASE%/}/api/health"

curl -fsS "$URL" -H "Accept: application/json"
