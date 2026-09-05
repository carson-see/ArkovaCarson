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

## 2026-09-02 — both public Powers-of-Tau hosts answer 403; CI now depends on cache continuity

`build.sh` fetches `powersOfTau28_hez_final_14.ptau` from `storage.googleapis.com/zkevm/ptau/`
(the mirror its header calls "stable"). On 2026-09-02 that object and the original
`hermez.s3-eu-west-1.amazonaws.com` bucket both returned `403 AccessDenied` ("anonymous caller
does not have storage.objects.get … or it may not exist"), and `curl --retry` does not retry a
403. The CI artifacts cache is keyed on `services/worker/package-lock.json` among other inputs, so
the dependabot bump in PR #2606 rotated the key, the rebuild attempted the download, and `main`'s
`Tests` job went red on a lockfile change (run 33669376517; `zk-proof.test.ts` is fail-loud by
design and errors at module load when artifacts are missing — do not "fix" that by skipping).

What holds it up now: `ci.yml`'s `cache-zk-artifacts` step has a `restore-keys` prefix fallback,
so a rotated key restores the newest previous entry — which carries the SHA-256-pinned ptau and
circomlib tarball — and `build.sh` regenerates wasm/zkey/vkey from source from those inputs (its
`if missing` guards skip the downloads, and it re-verifies both pins before use). Only an exact key
hit sets `cache-hit`, so the rebuild always runs on a fallback. Pinned by
`scripts/ci/ci-workflow-contract.test.ts`.

What it does NOT solve: a cold cache. Actions caches are evicted after 7 days without access (and
by the repo-wide size cap), and there is currently no public URL to seed one from. The durable fix
is an Arkova-owned mirror (a GCS bucket in `arkova1` or a release asset — the SHA-256 pin in
`build.sh` makes the source trust-free); until then do not point `PTAU_URL` at a host you have not
fetched and hash-checked yourself. Local dev: `build.sh` skips the download when
`artifacts/powersOfTau28_hez_final_14.ptau` is already present, so copy a pinned-hash copy in from
any existing checkout and run `npm run build:circuit`.
