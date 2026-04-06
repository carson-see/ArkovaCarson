#!/bin/bash
# IndexNow URL Submission (GEO-10)
#
# Submits updated URLs to Bing/Yandex for instant indexing.
# Run after deployments or content changes.
#
# Usage:
#   ./scripts/indexnow-submit.sh
#   ./scripts/indexnow-submit.sh https://app.arkova.ai/verify/ARK-2026-001

set -euo pipefail

HOST="app.arkova.ai"
KEY="${INDEXNOW_KEY:?INDEXNOW_KEY not set}"
KEY_LOCATION="https://${HOST}/indexnow-key.txt"

# Default URLs to submit (public pages + sitemap entries)
DEFAULT_URLS=(
  "https://${HOST}/"
  "https://${HOST}/verify"
  "https://${HOST}/search"
  "https://${HOST}/developers"
  "https://${HOST}/about"
  "https://${HOST}/login"
  "https://${HOST}/signup"
  "https://${HOST}/privacy"
  "https://${HOST}/terms"
  "https://${HOST}/contact"
  "https://${HOST}/cle"
  "https://${HOST}/llms.txt"
  "https://${HOST}/sitemap.xml"
)

# If URLs provided as arguments, use those instead
if [ $# -gt 0 ]; then
  URLS=("$@")
else
  URLS=("${DEFAULT_URLS[@]}")
fi

echo "=== IndexNow URL Submission ==="
echo "Host: ${HOST}"
echo "Key: ${KEY}"
echo "URLs: ${#URLS[@]}"
echo ""

# Build JSON payload
URL_JSON=$(printf '"%s",' "${URLS[@]}")
URL_JSON="[${URL_JSON%,}]"

PAYLOAD=$(cat <<EOF
{
  "host": "${HOST}",
  "key": "${KEY}",
  "keyLocation": "${KEY_LOCATION}",
  "urlList": ${URL_JSON}
}
EOF
)

# Submit to IndexNow (Bing endpoint)
echo "Submitting to Bing IndexNow..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "https://www.bing.com/indexnow" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d "${PAYLOAD}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "202" ]; then
  echo "  Bing: OK (${HTTP_CODE})"
else
  echo "  Bing: ${HTTP_CODE} — ${BODY}"
fi

# Submit to Yandex IndexNow
echo "Submitting to Yandex IndexNow..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "https://yandex.com/indexnow" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d "${PAYLOAD}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "202" ]; then
  echo "  Yandex: OK (${HTTP_CODE})"
else
  echo "  Yandex: ${HTTP_CODE} — ${BODY}"
fi

echo ""
echo "Done. URLs submitted to IndexNow."
