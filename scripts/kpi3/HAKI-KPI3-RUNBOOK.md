# KPI-3 Haki bundle-verification runbook (Lane 1 — Trust & Chain)

Operator guide for verifying the **15 KPI-1 Haki demo anchors** with the clean-room external verifier ([`external-verify.mjs`](./external-verify.mjs), PR #1611) via the Haki bridge ([`haki-bundle-verify.mjs`](./haki-bundle-verify.mjs)). Companion to the recording script in [`REHEARSAL-RUNBOOK.md`](./REHEARSAL-RUNBOOK.md).

## The 15-anchor context — and the honest empty state

The KPI-1 demo set is 15 HakiChain anchors. They split into two proof shapes:

- **Batch anchors** — `GET /api/v1/verify/:publicId/proof` returns a non-null `proof_bundle` (fingerprint, merkle_proof, merkle_root, tx_id, block header, ARKV||root OP_RETURN payload). These get the **two-layer** check below.
- **4 DIRECT anchors** (`ARK-2026-D2959176` / `…547B119A` / `…1F070188` / `…8F862179`) — one document per transaction. The proof endpoint returns **404 `{proof_error_code: "NO_BATCH_PROOF"}`** and there is **no downloadable bundle. This empty state is HONEST, not a gap:**
  - What a partner sees: no bundle download; the bridge reports `bundle: "none_direct_anchor"` and notes that merkle fields are absent because no batch tree exists for the anchor.
  - What we DO assert: the document's fingerprint is committed directly in the tx's OP_RETURN (`ARKV` magic at offset 0, fingerprint at bytes [4:36]) in a confirmed, header-bound Bitcoin block — the commitment itself is the proof, verified by SPV.
  - What we do NOT assert (§1.5): a Merkle inclusion branch (there is none), and — without `--issuer` — that Arkova funded the tx. Never present a fabricated bundle for these four; the tool never synthesizes one.

## Commands

All verification is library-first (`verifyHakiBundle(responseJson, opts, fetchPath)`); the CLI wraps it. The explorer mode is always explicit: `--offline` (fixture fetcher, zero network) or `--live` (blockstream.info). **`--live` runs are operator/Carson-gated** — they hit the public `blockstream.info` explorer; do not run them from automation or CI.

### Path A — batch anchor (bundle present)

```
# response.json = the full GET /api/v1/verify/<publicId>/proof body (or use --bundle for a bare proof_bundle)
node scripts/kpi3/haki-bundle-verify.mjs --response response.json --live \
  [--issuer bc1qtm2kk33k6ht4agt48kh7rfkmmhfkapqn4zwerc] [--min-conf 6]
```

Two layers, both must pass (`verdict: "verified"`), otherwise the output names the failed layer:
1. **(a) app-tree** — locally folds `merkle_proof` over `fingerprint` (double-SHA256, left/right per position; CVE-2012-2459 self-pair guard armed by `merkle_index` + `leaf_count`) and requires the result to equal `merkle_root`. Failure → `failed_app_tree` (chain layer is skipped: the bundle is internally inconsistent).
2. **(b) chain** — full SPV via the #1611 verifier with `fingerprint := merkle_root` (for a batch tx the 32 bytes at OP_RETURN [4:36] ARE the root): commit + ≥6-conf depth + Bitcoin merkle inclusion + header binding (+ optional issuer). Failure → `failed_chain` with the SPV reason.

### Path B — direct anchor (the 4 Haki directs; honest empty state)

```
node scripts/kpi3/haki-bundle-verify.mjs --direct --live \
  --fingerprint <64-hex from the anchor record> \
  --txid <64-hex from the Network Receipt> \
  [--block <height>] [--issuer bc1q...]
```

(Equivalently: `--response no-batch-404.json --fingerprint … --txid …` — a `NO_BATCH_PROOF` 404 routes to the same path.) Output: `bundle: "none_direct_anchor"`, `app_tree: null`, and the SPV result on the fingerprint itself. If fingerprint or txid is missing/malformed the verdict is `unverifiable_missing_inputs` with the exact missing list — never a fake pass.

### Offline / test mode (no network — what CI and rehearsal dry-runs use)

```
node --test scripts/kpi3/*.test.mjs        # 40/40 green, fully offline
node scripts/kpi3/haki-bundle-verify.mjs --response response.json \
  --offline --fixtures ./my-fixture-fetch.mjs   # module exporting fetchPath(path)
```

## Rehearsal step (Jul 22–25 recording prep)

1. **Dry-run offline first**: run the test suite above; then exercise both CLI paths with fixture fetchers so the narration is rehearsed before any network call.
2. **#1611 rehearsal**: `node scripts/kpi3/external-verify.mjs --rehearse` — runs VALID then TAMPERED (negative control) for the direct anchor `ARK-2026-D2959176` against the live explorer.
3. **The two new modes on camera**: Path A on one batch record (narrate both layers passing), then Path B on one of the 4 direct anchors — explicitly narrating the honest empty state: "this record has no downloadable bundle because the document's own fingerprint is committed directly on-chain; here is that commitment verifying via SPV."
4. Reminder: steps 2–3 use `--live` and hit `blockstream.info` — **operator/Carson-gated**; cross-check at least one record on a second explorer per the SPOF note in REHEARSAL-RUNBOOK.md.

_Lane 1 (Trust & Chain), 2026-07-21._
