#!/usr/bin/env bash
# Build the temporary RIG-B1 Bitcoin Core image locally. This script never
# pushes; publication is a separate CTO-gated release action using the exact
# locally inspected image ID.

set -euo pipefail

BITCOIN_CORE_VERSION="31.1"
BITCOIN_CORE_ARCHIVE="bitcoin-${BITCOIN_CORE_VERSION}-x86_64-linux-gnu.tar.gz"
BITCOIN_CORE_URL="https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_CORE_VERSION}/${BITCOIN_CORE_ARCHIVE}"
BITCOIN_CORE_SHA256="b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e"
DEFAULT_TAG="arkova-rig-b1-bitcoin-core:31.1-local"

TAG="${1:-$DEFAULT_TAG}"
if [[ ! "$TAG" =~ ^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$ \
  || "$TAG" == *:latest ]]; then
  echo "ERROR: pass one explicit non-latest local image tag." >&2
  exit 2
fi

for command in curl docker shasum; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "ERROR: required command '$command' is unavailable." >&2
    exit 2
  }
done

SCRIPT_DIR="$(cd -P -- "$(dirname -- "$0")" && pwd -P)"
CONTEXT="$(mktemp -d "${TMPDIR:-/tmp}/arkova-rig-b1-bitcoin-image.XXXXXX")"
cleanup() {
  rm -rf -- "$CONTEXT"
}
trap cleanup EXIT

curl --fail --location --silent --show-error \
  --output "$CONTEXT/$BITCOIN_CORE_ARCHIVE" \
  "$BITCOIN_CORE_URL"
OBSERVED_SHA256="$(shasum -a 256 "$CONTEXT/$BITCOIN_CORE_ARCHIVE" | awk '{print $1}')"
if [[ "$OBSERVED_SHA256" != "$BITCOIN_CORE_SHA256" ]]; then
  echo "ERROR: Bitcoin Core archive digest mismatch." >&2
  exit 1
fi

docker buildx build \
  --platform linux/amd64 \
  --file "$SCRIPT_DIR/rig-b1-bitcoin-core-image.Dockerfile" \
  --tag "$TAG" \
  --load \
  "$CONTEXT"

IMAGE_ID="$(docker image inspect "$TAG" --format '{{.Id}}')"
if [[ ! "$IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "ERROR: local image did not resolve to one immutable image ID." >&2
  exit 1
fi
printf 'RIG_B1_BITCOIN_CORE_LOCAL_IMAGE=%s\n' "$TAG"
printf 'RIG_B1_BITCOIN_CORE_LOCAL_IMAGE_ID=%s\n' "$IMAGE_ID"
printf 'RIG_B1_BITCOIN_CORE_SOURCE_SHA256=%s\n' "$BITCOIN_CORE_SHA256"
