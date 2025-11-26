#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------------
# Usage:
#   TOKEN_SECRET=... CLIENT_URL=http://localhost:8080 ./generate_and_redirect.sh connection.json [ttl]
#
# Generates:
#   CLIENT_URL/?token=<BASE64_TOKEN>
#
# Requirements:
#   - jq
#   - openssl
#   - xxd
#   - python3 (for URL-encoding)
# ------------------------------------------------------------------

JSON_FILE="${1:-}"
TTL="${2:-300}"

if [[ -z "$JSON_FILE" ]]; then
  echo "Usage: $0 <connection.json> [ttl]"
  exit 1
fi

if [[ ! -f "$JSON_FILE" ]]; then
  echo "Error: file '$JSON_FILE' not found"
  exit 1
fi

for cmd in jq openssl xxd python3; do
  if ! command -v "$cmd" >/dev/null; then
    echo "Error: $cmd is required"
    exit 1
  fi
done

TOKEN_SECRET="${TOKEN_SECRET:-}"
if [[ -z "$TOKEN_SECRET" ]]; then
  echo "Error: set TOKEN_SECRET env var"
  exit 1
fi

CLIENT_URL="${CLIENT_URL:-http://localhost:8080}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# 1) Add _expires into the connection JSON
NOW=$(date +%s)
EXPIRY=$((NOW + TTL))

jq \
  --arg expires "$EXPIRY" \
  '. + { "_expires": ($expires | tonumber) }' \
  "$JSON_FILE" > "$TMP_DIR/conn.json"

# 2) Derive AES-256 key = sha256(TOKEN_SECRET)
KEY_HEX=$(printf '%s' "$TOKEN_SECRET" | openssl dgst -sha256 -binary | xxd -p -c 256)

# 3) Generate random IV (16 bytes)
IV_HEX=$(openssl rand -hex 16)

# 4) Encrypt with AES-256-CBC + PKCS#7 padding
openssl enc -aes-256-cbc -K "$KEY_HEX" -iv "$IV_HEX" \
  -in "$TMP_DIR/conn.json" -out "$TMP_DIR/ct.bin"

# 5) Base64 encode IV and ciphertext
IV_B64=$(printf "%s" "$IV_HEX" | xxd -r -p | base64 | tr -d '\n')
CT_B64=$(base64 < "$TMP_DIR/ct.bin" | tr -d '\n')

# 6) Build token JSON package and base64-encode it
printf '{"iv":"%s","value":"%s"}' "$IV_B64" "$CT_B64" > "$TMP_DIR/pkg.json"
TOKEN=$(base64 < "$TMP_DIR/pkg.json" | tr -d '\n')

# 7) URL-encode token and print redirect URL
ENCODED_TOKEN=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.stdin.read().strip(), safe=''))" <<< "$TOKEN")

echo "${CLIENT_URL%/}/?token=${ENCODED_TOKEN}"

