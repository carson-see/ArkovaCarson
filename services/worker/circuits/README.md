# ZK Circuits

The `extraction-proof` zero-knowledge circuit binds an AI extraction
manifest to its source document without revealing document contents. It is
consumed by `services/worker/src/ai/zk-proof.ts` to produce PLONK proofs
that ship inside attestation evidence.

## Files

| File | Tracked in git | Purpose |
|---|---|---|
| `extraction-proof.circom` | yes | Circuit source (~500 constraints, 2 public inputs) |
| `build.sh` | yes | Reproducible build pipeline (compile + PLONK setup) |
| `README.md` | yes | This file |
| `artifacts/extraction-proof_js/extraction-proof.wasm` | no (gitignored) | Witness generator, ~2.3 MB |
| `artifacts/extraction-proof_final.zkey` | no (gitignored) | Proving key, ~27 MB |
| `artifacts/verification_key.json` | no (gitignored) | Verification key, ~2 KB |
| `artifacts/powersOfTau28_hez_final_14.ptau` | no (gitignored) | Universal trusted setup, ~18 MB |
| `artifacts/.circomlib/` | no (gitignored) | circomlib source — build-time only, see License section |

Artifacts are deliberately not checked in. They are deterministic outputs of
`build.sh` from versioned inputs, so any developer or CI runner can reproduce
them byte-for-byte. The build is cached in CI keyed on the hash of
`extraction-proof.circom` + `build.sh` + `package-lock.json`.

## License — circomlib is GPL-3.0, build-time only

`circomlib` (the iden3 collection of circom templates that defines the
Poseidon hash) is **GPL-3.0**. The project's license deny-list
(`npm run security:license-denylist`) blocks GPL/AGPL/SSPL in the worker's
shipped dependency graph. To stay compliant while still using the canonical
Poseidon templates, `build.sh` fetches a SHA-pinned circomlib tarball at
build time only — circomlib is **never** added to `package.json` or
`package-lock.json` and **never** ships in any container image. The output
wasm/zkey/vkey files are not GPL-encumbered, the same way a GCC-compiled
binary is not GPL-encumbered just by being compiled with GCC.

If you want to audit the GPL fetch, see Step 2 of `build.sh`:
fetched from `github.com/iden3/circomlib/archive/refs/tags/v2.0.5.tar.gz`,
verified against SHA-256 `6d72…1eff0`.

## Local build

```bash
cd services/worker
npm install                  # standard worker install — circomlib NOT here
npm run build:circuit        # build.sh fetches circomlib + ptau + compiles
```

You need `circom >= 2.1.0` on `PATH`. Install from
<https://github.com/iden3/circom/releases> (precompiled binaries) or build
from source via `cargo install --git https://github.com/iden3/circom.git`.

## CI

`.github/workflows/ci.yml` wires the build into the `Tests` job:

1. **Cache zk circuit artifacts** — keyed on circuit + build script hash.
2. **Install circom (cache miss only)** — pins `v2.1.9` Linux binary by
   SHA-256 (`e557…c967`) for supply-chain integrity.
3. **Build zk circuit artifacts (cache miss only)** — runs `build.sh`.
4. **Verify zk circuit artifacts present** — fail-fast canary before tests.
5. **Run worker tests with coverage** — the 3 zk-proof integration tests
   in `services/worker/src/ai/zk-proof.test.ts` exercise the artifacts.

Steady-state (cache hit): ~5 s overhead. Cold (cache miss): ~60 s including
ptau download, circom compile, and PLONK phase 2 setup.

## Reproducibility

PLONK setup is deterministic given a fixed `(r1cs, ptau)` pair — unlike
Groth16, no per-circuit ceremony contribution is required. So:

```
same .circom + same circomlib + same circom binary + same ptau
   ⇒ identical extraction-proof_final.zkey
   ⇒ identical verification_key.json
```

If two developers' verification keys differ, exactly one of the four inputs
above differs. Pin diagnostics in this order:

1. `circom --version` — must match the version pinned in `build.sh` / CI.
2. `shasum -a 256 services/worker/circuits/artifacts/circomlib-v2.0.5.tar.gz`
   — must equal `6d72a4ce…1eff0` (verified by `build.sh`).
3. `shasum -a 256 services/worker/circuits/artifacts/powersOfTau28_hez_final_14.ptau`
   — must equal `489be9e5…7895d` (verified by `build.sh`).

## Powers of Tau

`build.sh` downloads the `powersOfTau28_hez_final_14` file from the public
Polygon zkEVM mirror at
`https://storage.googleapis.com/zkevm/ptau/`. This is the artifact of the
universal hermez ceremony and is reusable across any circuit ≤ 2^14
constraints. Our circuit has ~558 non-linear constraints (well within
budget). The script verifies SHA-256
`489be9e5ac65d524f7b1685baac8a183c6e77924fdb73d2b8105e335f277895d` before
use; mismatch aborts the build and deletes the corrupt download.

## Changing the circuit

When `extraction-proof.circom` changes:

1. Bump `CIRCUIT_VERSION` in `services/worker/src/ai/zk-proof.ts`.
2. Run `npm run build:circuit` locally; commit nothing under `artifacts/`
   (still gitignored), but DO commit the .circom change.
3. The CI cache will miss on the new `.circom` hash and rebuild.
4. Existing on-chain proofs become un-verifiable against the new vkey —
   document the migration plan in the PR body before merging.
