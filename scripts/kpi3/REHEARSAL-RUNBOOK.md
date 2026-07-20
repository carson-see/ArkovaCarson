# KPI-3 dress-rehearsal runbook (SCRUM-2912 / SCRUM-2986)

**Goal of the recording (due Jul 25):** show a stranger verifying already-issued Arkova records on a *public* Bitcoin explorer with zero help from us, then show a **deliberately faked proof being rejected**. Demo day (Aug 9) becomes a replay of this.

## Assets (this folder)
- [`external-verify.mjs`](./external-verify.mjs) — the stranger's verifier. No Arkova deps; queries `blockstream.info` (independent of Arkova's `mempool.space` path). Library + CLI.
- [`external-verify.test.mjs`](./external-verify.test.mjs) — TDD spec, **18/18 green** (`node --test scripts/kpi3/external-verify.test.mjs`). Offline/deterministic (injected explorer with full SPV dataset).
- [`fixtures.mjs`](./fixtures.mjs) — VALID_PROOF (real prod anchor `ARK-2026-D2959176`, with real merkle proof + block header + treasury address) + TAMPERED_PROOF (negative control: one-nibble fingerprint flip).

## What the verifier actually proves (hardened after Bitcoin-engineer review)
It is genuine SPV, **not** explorer-trust. For a record it checks, in order: **COMMIT** — the fingerprint sits at the *canonical byte offset* of an OP_RETURN (ARKV magic at offset 0, fingerprint at bytes [4:36]; a fixed-offset match mirroring the worker's `signet.ts:extractAnchorFingerprint`, **not** a substring scan); **DEPTH** — ≥6 confirmations vs the chain tip; **INCLUDE** — the tx's merkle proof recomputes the block header's merkle_root (double-SHA256); **HEADER** — that header hashes to the stated block hash (binds the root to a specific proof-of-work block); **ISSUER** (optional `--issuer`) — the tx was funded by Arkova's treasury address. What it does **NOT** assert (§1.5): that the block is on the most-work chain (a full header-chain check is out of scope; confirmation depth mitigates). Without `--issuer`, it proves "this fingerprint is committed to Bitcoin", not "Arkova put it there" — state the claim you're making on camera accordingly.

## Recording script (on camera)
1. **Frame the claim.** "These records were secured on the public Bitcoin network. Anyone can verify them without Arkova." Show the source document; compute its SHA-256 fingerprint locally (`shasum -a 256 <file>` — the same value Arkova stored, never sent anywhere).
2. **Independent verify (per demo record).** Run:
   ```
   node scripts/kpi3/external-verify.mjs --live \
     --fingerprint <hex> --txid <hex> --block <height> \
     --issuer bc1qtm2kk33k6ht4agt48kh7rfkmmhfkapqn4zwerc
   ```
   Narrate the output: `verified=true` with `fingerprintCommitted` (the document's own hash is committed at the canonical offset), `confirmations` (thousands deep), `merkleIncluded` + `headerBinds` (the tx is provably in a real proof-of-work block — recomputed locally, not taken on the explorer's word), and `issuerMatch` (funded by Arkova's treasury). Optionally cross-check by opening `https://blockstream.info/tx/<txid>` in a browser. **Per-record wall-clock ≈ ~1s** (4 explorer round-trips at ~0.26s each; CPU is ~microseconds — perf review); a 15-record run is well under a minute.
3. **The negative control (the "fake proof").** Present a document whose fingerprint differs by one character (or `--fingerprint` a single flipped nibble). Run the same command. Narrate: `verified=false`, `reason=fingerprint_not_committed_in_op_return`. **"A forged or altered document cannot pass — the math simply doesn't match the chain."**
4. **One command that does both** (quick take): `node scripts/kpi3/external-verify.mjs --rehearse` runs VALID then TAMPERED against the live explorer back-to-back.

## Which records to demo
Pull the canonical KPI-1 set from **SCRUM-2912** (the 15-record list — see Task-1 D1: not resolvable this session without Jira). Any record used **must be a `direct_anchored` anchor** (fingerprint committed directly in OP_RETURN). The four verified HakiChain anchors (`ARK-2026-D2959176/547B119A/1F070188/8F862179`, Task-1) are known-good direct anchors and are valid rehearsal stand-ins until the 15-set is confirmed.
**Do NOT** demo a record whose proof relies on a downloadable two-layer `proof_bundle` — those are `already_complete` batch rows (only 6,110 exist) and use a different verification path.

## SPOF note (SCRUM-2986)
The verifier is explorer-agnostic (`blockstreamFetch(base)` is swappable). For the recording, cross-verify at least one record on a **second independent explorer** (e.g. mempool.space's public tx view in a browser) so the KPI-3 evidence does not hinge on a single explorer being up.

_Lane 1 (Trust & Chain), 2026-07-20. Script skeleton + negative-control fixture ready per the 24h exit criterion; full recording is the Jul 22–25 workstream._
