#!/usr/bin/env bash
# Shared helper for Guino scheduled jobs. Requires GUINO_BASE_URL and CRON_SECRET.
set -euo pipefail

ENDPOINT="${1:?Usage: guino-cron.sh /api/cron/warm}"
BASE="${GUINO_BASE_URL:-http://127.0.0.1:8000}"
SECRET="${CRON_SECRET:?Set CRON_SECRET in the environment}"

URL="${BASE%/}${ENDPOINT}"
curl -fsS -X POST "$URL" \
  -H "Authorization: Bearer ${SECRET}" \
  -H "Accept: application/json"
