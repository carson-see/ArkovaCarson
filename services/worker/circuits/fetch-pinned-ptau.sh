#!/usr/bin/env bash
set -euo pipefail

# Fetch the repository-pinned Powers of Tau without ever exposing a partial
# download at the path consumed by snarkjs. Environment overrides exist only
# so the shell contract can be exercised against local fixtures.
PTAU_NAME="${PTAU_NAME:-powersOfTau28_hez_final_14.ptau}"
PTAU_SHA256="${PTAU_SHA256:-489be9e5ac65d524f7b1685baac8a183c6e77924fdb73d2b8105e335f277895d}"
PTAU_MIRROR_URL="${PTAU_MIRROR_URL:-https://storage.googleapis.com/arkova1-public-build-artifacts/zk/${PTAU_NAME}}"
PTAU_UPSTREAM_URL="${PTAU_UPSTREAM_URL:-https://storage.googleapis.com/zkevm/ptau/${PTAU_NAME}}"

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

for url in "$PTAU_MIRROR_URL" "$PTAU_UPSTREAM_URL"; do
  : > "$temporary"
  echo "[build-circuit] downloading $PTAU_NAME from $url"
  if ! curl --proto '=https' --proto-redir '=https' -fsSL --retry 5 --retry-delay 5 --max-time 1800 -o "$temporary" "$url"; then
    echo "[build-circuit] source unavailable; trying next pinned source" >&2
    continue
  fi
  actual="$(sha256_of "$temporary")"
  if [[ "$actual" != "$PTAU_SHA256" ]]; then
    echo "[build-circuit] source SHA-256 mismatch; trying next pinned source" >&2
    continue
  fi
  mv "$temporary" "$destination"
  trap - EXIT
  echo "[build-circuit] PTAU SHA-256 OK ($actual)"
  exit 0
done

echo "[build-circuit] ERROR: no source produced the repository-pinned $PTAU_NAME" >&2
exit 1
