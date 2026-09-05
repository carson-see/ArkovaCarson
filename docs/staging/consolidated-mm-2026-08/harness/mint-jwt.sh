#!/usr/bin/env bash
# Mint a real ES256 session for the seed fixture user (ORG_ADMIN) via the
# admin generate_link -> verify exchange (hand-rolled HS256 fails: PGRST301).
set -uo pipefail
D="$HOME/arkova-soak/consolidated-mm-2026-08"
. "$D/env.cmm"
SR="$(cat "$SR_KEY_FILE")"; ANON="$(cat "$ANON_KEY_FILE")"
HT=$(curl -s -m 20 -X POST "$SUPA/auth/v1/admin/generate_link" \
  -H "apikey: $SR" -H "Authorization: Bearer $SR" -H "Content-Type: application/json" \
  -d '{"type":"magiclink","email":"seed-fixture-user@seed-fixture.invalid"}' \
  | jq -r '.hashed_token // empty')
[ -n "$HT" ] || exit 1
curl -s -i -m 20 "$SUPA/auth/v1/verify?token=$HT&type=magiclink&redirect_to=http://localhost:3000" \
  -H "apikey: $ANON" | grep -i '^location:' | sed -E 's/.*access_token=([^&]*).*/\1/' | tr -d '\r\n'
