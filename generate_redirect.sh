#!/usr/bin/env bash
set -euo pipefail

# -------------------------------------------------------------
# Usage:
#   ./generate-redirect.sh connection.json
#
# Env vars:
#   GUAC_URL=http://localhost:8080
#   CLIENT_URL=http://localhost:8080   # where UI is served
#   API_KEY=local-dev-api-key
#   TTL=300
#   OUTPUT=url      # url | token | full
# -------------------------------------------------------------

JSON_FILE="${1:-}"

if [[ -z "$JSON_FILE" ]]; then
  echo "Usage: $0 <connection.json>"
  exit 1
fi

if [[ ! -f "$JSON_FILE" ]]; then
  echo "Error: file '$JSON_FILE' not found"
  exit 1
fi

if ! command -v jq >/dev/null; then
  echo "Error: jq is required"
  exit 1
fi

GUAC_URL="${GUAC_URL:-http://localhost:8080}"
CLIENT_URL="${CLIENT_URL:-http://localhost:8080}"
API_KEY="${API_KEY:-local-dev-api-key}"
TTL="${TTL:-300}"
OUTPUT="${OUTPUT:-url}"

REQUEST_BODY=$(jq --arg ttl "$TTL" '{connection: ., ttl: ($ttl|tonumber)}' "$JSON_FILE")
echo "$REQUEST_BODY" | jq .

RESPONSE=$(curl -s -X POST "$GUAC_URL/token" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d "$REQUEST_BODY")

if ! echo "$RESPONSE" | jq -e 'has("token")' >/dev/null 2>&1; then
  echo "Error generating token:"
  echo "$RESPONSE" | jq .
  exit 1
fi

TOKEN=$(echo "$RESPONSE" | jq -r '.token')

case "$OUTPUT" in
  token)
    echo "$TOKEN"
    ;;
  full)
    echo "$RESPONSE" | jq .
    ;;
  url|*)
    REDIRECT_URL="${CLIENT_URL%/}/?token=${TOKEN}"
    echo "$REDIRECT_URL"
    ;;
esac

