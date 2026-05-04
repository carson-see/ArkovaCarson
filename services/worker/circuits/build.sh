#!/usr/bin/env bash
# =============================================================================
# Build the extraction-proof zk circuit artifacts from source.
#
# Inputs (versioned in git):
#   - extraction-proof.circom      (this dir)
#
# Build-time-only inputs (fetched + SHA-pinned, NEVER in package-lock.json):
#   - circomlib v2.0.5              GPL-3.0 — used solely to compile the
#                                   circuit. Output wasm/zkey/vkey ARE NOT
#                                   GPL-encumbered, the same way a binary
#                                   compiled with GCC isn't GPL-encumbered.
#                                   Keeping circomlib out of the worker's
#                                   shipped dependency graph is what
#                                   security:license-denylist enforces.
#   - powersOfTau28_hez_final_14    public hermez universal trusted setup
#
# Outputs (gitignored, regenerated):
#   - artifacts/extraction-proof_js/extraction-proof.wasm
#   - artifacts/extraction-proof_final.zkey
#   - artifacts/verification_key.json
#
# Reproducibility:
#   - circom compile is deterministic from .circom + circomlib version.
#   - `snarkjs plonk setup` is deterministic from (r1cs, ptau) — no random
#     contribution is needed for PLONK (unlike Groth16). Same r1cs + same
#     ptau ⇒ same zkey ⇒ same verification_key.json on every machine.
#   - circomlib tarball + ptau file are SHA-256-pinned before use.
#
# Required tools:
#   - circom >= 2.1.0  (https://github.com/iden3/circom/releases)
#   - npx snarkjs       (already in services/worker/package.json)
#   - curl, shasum, tar
#
# Usage:
#   bash services/worker/circuits/build.sh
#
# CI invocation: see .github/workflows/ci.yml "Build zk circuit artifacts" step.
# =============================================================================
set -euo pipefail

CIRCUITS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARTIFACTS_DIR="$CIRCUITS_DIR/artifacts"
CIRCUIT_NAME="extraction-proof"

# Powers of Tau — circuit has ~500 constraints; 2^14 = 16384 is comfortable.
PTAU_NAME="powersOfTau28_hez_final_14.ptau"
# Polygon zkEVM mirror of the public hermez ceremony ptau. The original
# hermez S3 bucket has been periodically returning 403; this GCS mirror is
# the documented stable mirror for the snarkjs ecosystem.
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/${PTAU_NAME}"
PTAU_SHA256="489be9e5ac65d524f7b1685baac8a183c6e77924fdb73d2b8105e335f277895d"
PTAU_PATH="$ARTIFACTS_DIR/$PTAU_NAME"

# circomlib (Poseidon templates) — fetched build-time only and NEVER added
# to package-lock.json. circomlib is GPL-3.0; the project's license deny-
# list (npm run security:license-denylist) blocks GPL/AGPL/SSPL in the
# shipped dependency graph. By fetching only at build time and producing
# wasm/zkey/vkey artifacts, we keep the worker runtime free of GPL code
# while still using the canonical Poseidon templates.
CIRCOMLIB_VERSION="v2.0.5"
CIRCOMLIB_TARBALL_URL="https://github.com/iden3/circomlib/archive/refs/tags/${CIRCOMLIB_VERSION}.tar.gz"
CIRCOMLIB_SHA256="6d72a4ced486bcc1868a030fbc73d0943a6bd45cdf4c9e40afdf43bd9d61eff0"
CIRCOMLIB_DIR="$ARTIFACTS_DIR/.circomlib"

mkdir -p "$ARTIFACTS_DIR"

# Pinned circom version. Must match the value in .github/workflows/ci.yml
# (currently v2.1.9). Reproducibility of extraction-proof_final.zkey +
# verification_key.json requires byte-identical inputs across every build —
# that includes the circom binary version. Different circom versions will
# produce different artifacts even with identical .circom source, so accept
# only the exact pinned version. CodeRabbit ASSERTIVE on PR #693.
EXPECTED_CIRCOM_VERSION="2.1.9"

echo "[build-circuit] Step 1/6: verify circom is installed and at the pinned version"
if ! command -v circom >/dev/null 2>&1; then
  echo "[build-circuit] ERROR: circom is not installed. Install v${EXPECTED_CIRCOM_VERSION} from https://github.com/iden3/circom/releases/tag/v${EXPECTED_CIRCOM_VERSION}" >&2
  exit 1
fi
# `circom --version` output: "circom compiler 2.1.9". Take the last whitespace-
# separated field. Any deviation from EXPECTED_CIRCOM_VERSION is a hard error.
INSTALLED_CIRCOM_VERSION="$(circom --version | awk '{print $NF}')"
if [[ "$INSTALLED_CIRCOM_VERSION" != "$EXPECTED_CIRCOM_VERSION" ]]; then
  echo "[build-circuit] ERROR: expected circom v${EXPECTED_CIRCOM_VERSION} (matches .github/workflows/ci.yml CIRCOM_VERSION pin), got v${INSTALLED_CIRCOM_VERSION}" >&2
  echo "[build-circuit] Reproducibility requires the exact pinned version. Install from https://github.com/iden3/circom/releases/tag/v${EXPECTED_CIRCOM_VERSION}" >&2
  exit 1
fi
echo "[build-circuit] circom version OK (v${INSTALLED_CIRCOM_VERSION})"

echo "[build-circuit] Step 2/6: fetch circomlib tarball (build-time only, GPL-3.0)"
# Invalidate the extracted circomlib dir if its recorded version doesn't match
# CIRCOMLIB_VERSION. Without this, a stale .circomlib from an older
# CIRCOMLIB_VERSION (different SHA-pinned tarball) would be silently reused
# because line 76 only checks dir existence — same reproducibility failure
# mode the circom version check above prevents. CodeRabbit ASSERTIVE on PR #693.
CIRCOMLIB_VERSION_STAMP="$CIRCOMLIB_DIR/.version"
if [[ -f "$CIRCOMLIB_VERSION_STAMP" ]] && [[ "$(cat "$CIRCOMLIB_VERSION_STAMP")" != "$CIRCOMLIB_VERSION" ]]; then
  echo "[build-circuit] circomlib version drift detected ($(cat "$CIRCOMLIB_VERSION_STAMP") on disk vs $CIRCOMLIB_VERSION pinned) — invalidating $CIRCOMLIB_DIR"
  rm -rf "$CIRCOMLIB_DIR"
fi

if [[ ! -d "$CIRCOMLIB_DIR/circuits" ]]; then
  TARBALL="$ARTIFACTS_DIR/circomlib-${CIRCOMLIB_VERSION}.tar.gz"
  if [[ ! -f "$TARBALL" ]]; then
    echo "[build-circuit] downloading circomlib ${CIRCOMLIB_VERSION} ..."
    curl -fsSL --retry 5 --retry-delay 5 --max-time 300 -o "$TARBALL" "$CIRCOMLIB_TARBALL_URL"
  fi
  ACTUAL_CL_SHA="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
  if [[ "$ACTUAL_CL_SHA" != "$CIRCOMLIB_SHA256" ]]; then
    echo "[build-circuit] ERROR: circomlib tarball SHA-256 mismatch" >&2
    echo "[build-circuit]   expected: $CIRCOMLIB_SHA256" >&2
    echo "[build-circuit]   actual:   $ACTUAL_CL_SHA" >&2
    rm -f "$TARBALL"
    exit 1
  fi
  echo "[build-circuit] circomlib SHA-256 OK ($ACTUAL_CL_SHA)"
  mkdir -p "$CIRCOMLIB_DIR"
  tar -xzf "$TARBALL" -C "$CIRCOMLIB_DIR" --strip-components=1
  printf '%s\n' "$CIRCOMLIB_VERSION" > "$CIRCOMLIB_VERSION_STAMP"
fi

echo "[build-circuit] Step 3/6: download Powers of Tau (if missing)"
if [[ ! -f "$PTAU_PATH" ]]; then
  echo "[build-circuit] downloading $PTAU_NAME (~35 MB) ..."
  curl -fsSL --retry 5 --retry-delay 5 --max-time 1800 -o "$PTAU_PATH" "$PTAU_URL"
fi

echo "[build-circuit] Step 4/6: verify Powers of Tau SHA-256"
ACTUAL_SHA="$(shasum -a 256 "$PTAU_PATH" | awk '{print $1}')"
if [[ "$ACTUAL_SHA" != "$PTAU_SHA256" ]]; then
  echo "[build-circuit] ERROR: Powers of Tau SHA-256 mismatch" >&2
  echo "[build-circuit]   expected: $PTAU_SHA256" >&2
  echo "[build-circuit]   actual:   $ACTUAL_SHA" >&2
  rm -f "$PTAU_PATH"
  exit 1
fi
echo "[build-circuit] PTAU SHA-256 OK ($ACTUAL_SHA)"

echo "[build-circuit] Step 5/6: compile circuit + run PLONK setup"
cd "$CIRCUITS_DIR"

# Compile .circom -> r1cs + wasm. -l points circom at the SHA-pinned
# circomlib copy under artifacts/.circomlib/circuits.
circom "${CIRCUIT_NAME}.circom" \
  --r1cs --wasm \
  -o "$ARTIFACTS_DIR" \
  -l "$CIRCOMLIB_DIR/circuits"

# PLONK setup: deterministic given (r1cs, ptau).
cd "$ARTIFACTS_DIR"
npx --yes snarkjs plonk setup \
  "${CIRCUIT_NAME}.r1cs" \
  "$PTAU_NAME" \
  "${CIRCUIT_NAME}_final.zkey"

# Export verification key (deterministic from zkey).
npx --yes snarkjs zkey export verificationkey \
  "${CIRCUIT_NAME}_final.zkey" \
  verification_key.json

echo "[build-circuit] Step 6/6: done"
echo "[build-circuit] Artifacts:"
ls -lh \
  "$ARTIFACTS_DIR/${CIRCUIT_NAME}_js/${CIRCUIT_NAME}.wasm" \
  "$ARTIFACTS_DIR/${CIRCUIT_NAME}_final.zkey" \
  "$ARTIFACTS_DIR/verification_key.json"
