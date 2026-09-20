#!/usr/bin/env bash
set -euo pipefail

# Fetch the repository-pinned Powers of Tau without ever exposing a partial
# download at the path consumed by snarkjs. Environment overrides exist only
# so the shell contract can be exercised against local fixtures.
PTAU_NAME="${PTAU_NAME:-powersOfTau28_hez_final_14.ptau}"
PTAU_SHA256="${PTAU_SHA256:-489be9e5ac65d524f7b1685baac8a183c6e77924fdb73d2b8105e335f277895d}"
PTAU_MIRROR_URL="${PTAU_MIRROR_URL:-https://storage.googleapis.com/arkova1-public-build-artifacts/zk/${PTAU_NAME}}"

destination="${1:?usage: fetch-pinned-ptau.sh DESTINATION}"
mkdir -p "$(dirname "$destination")"

sha256_of() {
  local input_path="${1:?sha256_of requires a path}"
  shasum -a 256 "$input_path" | awk '{print $1}'
}

if [[ -f "$destination" ]] && [[ "$(sha256_of "$destination")" == "$PTAU_SHA256" ]]; then
  echo "[build-circuit] existing $PTAU_NAME SHA-256 OK"
  exit 0
fi

# A stale/corrupt destination is never reused, and each candidate is downloaded
# to a sibling temporary file so rename into place is atomic on the same FS.
if [[ -e "$destination" ]]; then
  rm -f "$destination"
fi
temporary="$(mktemp "${destination}.download.XXXXXX")"
trap 'rm -f "$temporary"' EXIT

echo "[build-circuit] downloading $PTAU_NAME from $PTAU_MIRROR_URL"
if ! curl --proto '=https' --proto-redir '=https' -fsSL \
  --connect-timeout 10 --max-time 120 --retry 2 --retry-max-time 180 \
  -o "$temporary" "$PTAU_MIRROR_URL"; then
  echo "[build-circuit] ERROR: Arkova mirror unavailable" >&2
  exit 1
fi
actual="$(sha256_of "$temporary")"
if [[ "$actual" != "$PTAU_SHA256" ]]; then
  echo "[build-circuit] ERROR: Arkova mirror SHA-256 mismatch" >&2
  exit 1
fi
mv "$temporary" "$destination"
trap - EXIT
echo "[build-circuit] PTAU SHA-256 OK ($actual)"
