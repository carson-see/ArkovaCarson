# services/worker/circuits

Zero-knowledge circuit for binding AI extraction manifests to source documents without revealing document contents. Consumed by `services/worker/src/ai/zk-proof.ts` to produce PLONK proofs inside attestation evidence.

## Files

- `extraction-proof.circom` — Circom circuit (~500 constraints, 2 public inputs: poseidonHash + manifestCommitment). Proves document knowledge without revealing contents.
- `build.sh` — Reproducible build pipeline. Fetches circomlib v2.0.5 (GPL-3.0, build-time only) + hermez ptau, compiles circuit, runs PLONK setup. Requires `circom v2.1.9` exactly.
- `README.md` — Build instructions, CI integration, reproducibility notes, license rationale.

## Constraints

- Artifacts (`artifacts/`) are gitignored — deterministic outputs of `build.sh`.
- circomlib is GPL-3.0 and must NEVER enter `package.json` or ship in a container image.
- Changing the circuit requires bumping `CIRCUIT_VERSION` in `zk-proof.ts` and documenting the on-chain migration plan.
