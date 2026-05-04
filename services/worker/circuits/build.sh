#!/usr/bin/env bash
# =============================================================================
# Build the extraction-proof zk circuit artifacts from source.
#
# Inputs (versioned in git):
#   - extraction-proof.circom      (this dir)
#   - circomlib (npm devDep)        (services/worker/node_modules/circomlib)
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
#   - The Powers of Tau file is downloaded from the hermez ceremony URL and
#     verified against a pinned SHA-256 before use.
#
# Required tools:
#   - circom >= 2.1.0  (https://github.com/iden3/circom/releases)
#   - npx snarkjs       (already in services/worker/package.json)
#   - curl, shasum
#
# Usage:
#   bash services/worker/circuits/build.sh
#
# CI invocation: see .github/workflows/ci.yml "Build zk circuit artifacts" step.
# =============================================================================
set -euo pipefail

CIRCUITS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$(cd "$CIRCUITS_DIR/.." && pwd)"
ARTIFACTS_DIR="$CIRCUITS_DIR/artifacts"
CIRCUIT_NAME="extraction-proof"

# Powers of Tau — circuit has ~500 constraints; 2^14 = 16384 is comfortable.
# This file is the output of the public hermez universal trusted setup
# ceremony and is not specific to our circuit.
PTAU_NAME="powersOfTau28_hez_final_14.ptau"
# Polygon zkEVM mirror of the public hermez ceremony ptau. The original
# hermez S3 bucket has been periodically returning 403; the GCS mirror is
# the documented stable mirror for the snarkjs ecosystem.
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/${PTAU_NAME}"
PTAU_SHA256="489be9e5ac65d524f7b1685baac8a183c6e77924fdb73d2b8105e335f277895d"
PTAU_PATH="$ARTIFACTS_DIR/$PTAU_NAME"

mkdir -p "$ARTIFACTS_DIR"

echo "[build-circuit] Step 1/5: verify circom is installed"
if ! command -v circom >/dev/null 2>&1; then
  echo "[build-circuit] ERROR: circom is not installed. Install from https://github.com/iden3/circom/releases" >&2
  exit 1
fi
circom --version

echo "[build-circuit] Step 2/5: ensure circomlib is available (in worker node_modules)"
if [[ ! -d "$WORKER_DIR/node_modules/circomlib" ]]; then
  echo "[build-circuit] ERROR: circomlib not found at $WORKER_DIR/node_modules/circomlib" >&2
  echo "[build-circuit] Run 'npm install' in $WORKER_DIR first." >&2
  exit 1
fi

echo "[build-circuit] Step 3/5: download Powers of Tau (if missing)"
if [[ ! -f "$PTAU_PATH" ]]; then
  echo "[build-circuit] downloading $PTAU_NAME (~35 MB) ..."
  curl -fsSL --retry 5 --retry-delay 5 -o "$PTAU_PATH" "$PTAU_URL"
fi

echo "[build-circuit] Step 4/5: verify Powers of Tau SHA-256"
ACTUAL_SHA="$(shasum -a 256 "$PTAU_PATH" | awk '{print $1}')"
if [[ "$ACTUAL_SHA" != "$PTAU_SHA256" ]]; then
  echo "[build-circuit] ERROR: Powers of Tau SHA-256 mismatch" >&2
  echo "[build-circuit]   expected: $PTAU_SHA256" >&2
  echo "[build-circuit]   actual:   $ACTUAL_SHA" >&2
  rm -f "$PTAU_PATH"
  exit 1
fi
echo "[build-circuit] PTAU SHA-256 OK ($ACTUAL_SHA)"

echo "[build-circuit] Step 5/5: compile circuit + run PLONK setup"
cd "$CIRCUITS_DIR"

# Compile .circom -> r1cs + wasm. -l adds the circomlib include path.
circom "${CIRCUIT_NAME}.circom" \
  --r1cs --wasm \
  -o "$ARTIFACTS_DIR" \
  -l "$WORKER_DIR/node_modules"

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

echo "[build-circuit] Done. Artifacts:"
ls -lh \
  "$ARTIFACTS_DIR/${CIRCUIT_NAME}_js/${CIRCUIT_NAME}.wasm" \
  "$ARTIFACTS_DIR/${CIRCUIT_NAME}_final.zkey" \
  "$ARTIFACTS_DIR/verification_key.json"
