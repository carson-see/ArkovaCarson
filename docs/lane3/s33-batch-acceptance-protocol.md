# L3 ↔ Lane 4 Corpus Batch Acceptance Protocol (Sprint 3.3)

> **Status:** interface contract, amended 2026-07-14 by binding CTO ruling 102498305 and the Wave-1 correction-topology ruling. Lane 4 owns corpus PRODUCTION; Lane 3 retains candidate selection, eval gates, A/B, leakage audit, and batch ACCEPTANCE authority (CTO R11/R12). Internal engineering notes; audited spec in Confluence (96894977).
> **Audience:** Lane 4 (corpus lane) — this is the contract your batches are accepted against. Lane 3 — this is the checklist you sign.

## 1. Batch submission format (Lane 4 → Lane 3)

Each batch is one PR (draft) containing ONLY:

1. Corpus entries under the agreed corpus root (net-new files; never edits to previously accepted entries — corrections are a new compensating batch, mirroring the migration rule).
2. A per-batch **datasheet fragment** with, per entry: real vs synthetic; source/provenance (lawful basis for real docs); generator name + version + seed (synthetic); template ID (synthetic); jurisdiction; type + concrete subType; curation author; curation date; license/consent note.
3. A batch manifest: batch id, entry count per type/domain, intended split (gate vs held-out candidate), Lane 4 self-check results against §3.

Batches that mix held-out candidates and training/gate entries in one undifferentiated pile are rejected without review — the split declaration is what the leakage audit keys on.

## 2. Lane 3 acceptance pipeline (per batch)

Run in order; stop at first failure.

1. **Structural check** — manifest parses; every entry has a strict-schema datasheet row; entry id/domain/type/order reconcile across artifacts; the committed corpus Markdown carries the exact revision, manifest digest, producer parent/predecessor, and Lane-3 support markers.
2. **Quality invariant checklist (§3)** — deterministic script + human spot-check.
3. **Whole-batch machine validation + ≥10% human cross-review** — the post-validation depth/OOD contract runs over every row, Kenya first. Lane 3 then independently re-derives ground truth for a deterministic ≥10% sample (minimum 5, capped at batch size) bound to the committed manifest digest; any material label disagreement counts as a defect. The dedicated `arkova-s33-wave2-cto-release` Ed25519 identity is the acceptance authority. A GitHub issue comment or formal review supplies durable transport metadata only; state/login/distinct-account checks do not confer authority.
4. **Prod-model-diff screening** — replay the production extraction path offline within the existing request/spend envelope; no live endpoint is required. Diff production-model output vs Lane 4 ground truth. Mismatches are not auto-defects (the model can be wrong — that is the point of the corpus); each mismatch receives human adjudication: label error → defect; model error → keep and tag as model-hard.
5. **Leakage / contamination audit** — held-out candidates must be real or independently curated, never generator-derived. Run the exact normalized token n-gram scan for every n=6–13 against the merged training leakage manifest and require **zero exact matches**. The embedding near-duplicate scan is diagnostic only: it may trigger human review but can neither pass a failed exact scan nor reject an otherwise passing exact scan by itself.
6. **Acceptance defect thresholds** — any of the following rejects the batch: >5% of cross-reviewed sample has material label defects; any §3 hard invariant fails; any leakage hit on a held-out candidate; datasheet rows missing or false (e.g., synthetic marked real — this one is a trust incident, not just a defect).

## 3. Quality invariant checklist

Hard invariants (any failure = reject):

- [ ] Every **covered** entry retains ≥5 substantive ground-truth fields **after** production `validateFieldsForType()` applies the production v6 per-type allowlist. Taxonomy labels, evaluator/reasoning fields, fraud bookkeeping, stripped type-invalid fields, and invented padding do not count.
- [ ] Every **covered** entry has a concrete `subType` — no `other`, no missing.
- [ ] Every `GD-S33-OOD-*` row is exactly `{credentialType: 'OTHER', subType: 'other', fraudSignals: []}` and is exempt from the depth and concrete-subtype floors; it is scored as abstention only.
- [ ] No two entries within a type share >80% token overlap.
- [ ] Held-out candidates: real/independently-curated only; zero generator-derived entries.
- [ ] Synthetic entries carry generator version + seed + template ID in the datasheet.
- [ ] KE entries include BOTH eCitizen-PDF/QR-style and legacy typewritten/stamped variants across the batch (research brief §7 caveat).
- [ ] Jurisdiction field populated on every AU/KE entry.
- [ ] Zero PII that would violate curation rules; zero real user documents from Arkova prod.

Soft targets (tracked per batch, trended; sustained misses escalate to the train):

- ~30% edge cases (degraded scan, expired, redacted, multi-issuer) per type.
- Per-type target counts per CTO R5 (4 professions ≥12–15 held-out each; top-15 types/domain ≥12; AU ≥10, KE ≥10).

## 4. Reject-and-return path

- Rejection returns the WHOLE batch with a per-entry defect list within 1 business day of submission. No partial acceptance — cherry-picking accepted entries out of a defective batch destroys the sampling guarantee behind the 10% cross-review.
- Lane 4 fixes and resubmits as a new batch revision (same batch id, revision bump). Re-review runs the full pipeline; the cross-review sample re-randomizes (new manifest hash → new seed).
- Two consecutive rejections of the same batch id escalate to the train (RTE + CTO) — that is a process problem, not an entry problem.
- Disputes on individual adjudications: Lane 4 may contest with evidence; Lane 3 decision is final at batch level (R12), CTO arbitrates only on escalation.

## 5. Held-out freeze (before the eval window)

1. At corpus close, Lane 3 records the final held-out set at the exact #1544 single-parent head. Revision 12 uses two independent histories: the Lane-4 producer history (`r10 → r11′ → r12`) and the Lane-3 support history (`support baseline → S12`). The support tree is never treated as the producer's parent and `support..producer` is never accepted as provenance.
2. The code-owned revision-12 descriptor pins r10, the support baseline, S12, r11′, r12, their unique merge base, nonempty exact declared subsets of the six packet paths on both producer edges, all six packet blobs/digests, the historical r11′ failure set/digest, and all CTO adjudication objects. r11′ must be the exact direct single-parent child of r10: intermediate commits and tamper-then-revert history are forbidden. Each producer edge permits only `A`/`M` regular non-executable `100644` blobs inside the six packet paths; deletes, renames, copies, type changes, symlinks, gitlinks, executable bits, and outside paths fail closed.
3. The lexical transition universe is exact: the code-owned **LEAKAGE32** set plus the sole separately authorized non-leakage transition `GD-S33-KE-006` under `CTO_R12_TAXONOMY_AND_DEPTH_ADJUDICATION`. Those sets must be disjoint; their 33-entry union must equal the raw `strippedText` changes, source-text-change list, normalized-input-change list, recomputed-fingerprint keys, and parent-to-r12 transition keys. LEAKAGE32 alone owns the leakage hit set/counters; every other r11′ raw `strippedText` byte sequence and normalized fingerprint must remain unchanged.
4. r11′ is retained as `HISTORICAL_BLOCKED` and its final Lane-3 acceptance is rejected against its exact expected failure set. r12 must independently pass the full 81-row packet/manifest/datasheet/source bijection, digest pins, adjudications, and zero post-validation ground-truth failures.
5. Lane 3 proves the histories compose without rewriting either one: the pinned merge base to r12 is exactly six `100644` additions; `git merge-tree --write-tree S12 r12` must be conflict-free; and the final correction freeze F12C (§5.1) must be a single-parent child of S12 whose tree equals that virtual merge tree. `S12 → F12C` is exactly six `100644` additions, every F12C packet blob equals r12, and the Lane-3 support/types blob equals S12. The earlier F12 attempt is historical and is not an acceptance identity.
6. The freeze identity is F12C's head SHA and Git tree SHA plus the committed manifest's raw and canonical SHA-256 digests and the dual-DAG verification-report digest authenticated by A12C (§5.1).
7. From the freeze commit onward: no held-out entry may be edited, moved, or referenced by any generator/tuning export; the leakage CI (fail-closed, #1413 pattern) enforces this mechanically.
8. **Curate-before-seed commit order** is binding: held-out entries must land in git BEFORE any synthetic generator seeding that could observe them; datasheet timestamps + commit order are the audit trail.
9. Any post-freeze corpus change voids the window evidence for affected domains (§1.11A analogue: evidence is exact-content, not vibes).

### 5.1 Revision-12 correction topology (binding)

- `S12` means immutable support/protocol commit `0323711347c32eb8a6adf899bdfe768a8c9181fb`; the later #1545 delivery tip is not `S12` and may not be substituted for it.
- `F12C` is create-only ref `refs/heads/codex/s33-wave1-f12c-freeze-20260714` at commit `447326ddd2225524895f35cbafda58b15555ed30`, tree `52b6a2dd7201783f93325c24c999bc3e6bb8ee25`, with sole parent `S12`. Its edge from `S12` is exactly the six packet paths as added regular non-executable `100644` blobs; its packet blobs equal immutable r12.
- `A12C` is create-only ref `refs/heads/codex/s33-wave1-a12c-evidence-20260714` at commit `3508e5e9c7e100e9c55c0cba129d8d7b9d123bec`, with sole parent `F12C`. Its only delta is an added regular `100644` blob at `docs/lane3/evidence/s33-wave1-r12-dual-dag-verification.json`. The evidence is deliberately `selfPinned: false`; compiled trusted-main code pins the A12C commit and evidence blob instead of asking the commit to authenticate itself.
- The A12C evidence blob is `c74b9d6e001355d7701640b2d062473c8bcbed76`; its raw SHA-256 is `02d8026546b14c64af447e8e12544b9e40d6618d9d1020a7a21086b83e425cb7`, canonical SHA-256 is `8a98c148bce14678a94e5ac0b8bac97b76147ca93a8b0058169544d32d439b72`, and recomputed report digest is `049ac9c08f168fc335cd277796c52f5fcc53bfe32097f7510ea0c609b5279a5e`.
- The four edge universes remain distinct: r11′→r12 is exactly five modified paths; merge-base→r12 is exactly six added packet paths; S12→F12C is exactly six added packet paths; F12C→A12C is exactly the one added evidence path. All six r12 packet blobs are authenticated regardless of the five-path immediate producer edge.
- Both trusted-main workflows fetch the complete r12 and A12C histories into one data-only bare Git object database and run the same authoritative producer verifier. No producer/evidence checkout, import, install, or execution is permitted. The prerequisite workflow must fail before GCP credentials or model calls; acceptance independently recomputes the same fixed-Git proof before consuming it.
- Historical F12/A12 refs are evidence of earlier rejected attempts only. They, the #1545 delivery tip, moved refs, shallow histories, replacement objects, or caller-supplied pins must fail closed.

### 5.2 Executable reachability trace

Each binding criterion below must retain all four production links plus its negative proof. A green unit test for an otherwise unreachable verifier is not acceptance evidence.

| Criterion | Implementation entry point | Workflow invocation and order | Authenticated artifact / field | Final consumer | Required negative proof |
| --- | --- | --- | --- | --- | --- |
| Exact tuple dispatch and four DAG edges | `verifyS33Wave1ProducerHead()` dispatches the exact revision/status tuple to `verifyS33Wave1R12Evidence()` | Prerequisite and acceptance workflows call the shared verifier after complete data-only fetch; prerequisite call is before GCP authentication | Recomputed dual-DAG facts and report digest | Prerequisite runner, workflow-report raw/final/reload, and Lane-3 acceptance | Unknown tuple, missing A12C history, old F12/A12, repair-tip-for-S12, or any altered edge fails |
| Fixed A12C bytes, schema, and topology | `verifyS33Wave1R12Evidence()` uses the code-owned commit/blob/raw/canonical/report anchor | Both workflows fetch the fixed A12C ref into the same bare database before verification | Existing private authenticated bundle carries the recomputed S12/F12C/A12C/r12 identities and digests | `createS33Wave1AcceptanceArtifactFromAuthenticatedEvidence()` | Moved ref, wrong parent/mode/path/blob/digest, duplicate or unknown key, invalid UTF-8, `selfPinned: true`, or report tamper fails |
| No execution across the producer boundary | Hardened Git-only readers and literal TypeScript parser | Trusted-main dependencies are installed before producer fetch is parsed; no producer/evidence checkout or import occurs | Git object ids, modes, bytes, and recomputed report only | Every non-test producer-verification caller | Shallow history, replacement object, special-mode path, or executable/computed producer syntax fails |
| Downstream acceptance binding | Existing authenticated-bundle and GitHub-evidence builders consume branded recomputed facts | Acceptance verifies GitHub exact-head trust after dual-DAG and prerequisite authentication, then uploads before posting a new immutable comment | Existing `lane3-acceptance.json`, GitHub evidence/report/comment fields bind S12/F12C/A12C/r12 and the evidence/report digests | GitHub acceptance comment and later rc-manifest AI consumer | Forged/cloned/unbranded bundle, omitted or mismatched dual fact, stale review/check, or comment-before-upload fails |

An exported trust-boundary verifier with no non-test call site is an automatic release blocker. The static trace test must prove these entrypoint → workflow → artifact → consumer links and the T0 import-graph/candidate-surface gate must prove no runtime or corpus path became reachable.

## 6. Accountability

- Every Wave-2 batch gets a separate machine-readable Lane-3 acceptance envelope. Its Ed25519 signature binds repository/PR, candidate base/head/tree, batch/revision, manifest path and raw/canonical digests, source/datasheet blobs, preflight digest, base/result registry digests, exact top-15 registry path/raw/canonical digests, signed time, entry order/set, live GitHub transport tuple, and the machine/human/model/leakage proof digests.
- Every accepted entry is individually fingerprinted over its id, top-15 registry type id, batch/revision, credential type/subtype, normalized input and ground-truth digests, exact authorship method (`real-source` or `independently-authored`), generator/training exclusions, held-out split, production-valid substantive-field count, edge flag, and source blob. Lane 4 counts only these verified facts; caller-supplied labels are never acceptance evidence.
- The production public SPKI/fingerprint remains `null` and fail-closed until the CTO commits the reviewed release trust root. Tests may inject generated Ed25519 keys only under `NODE_ENV=test`; there is no environment-variable or caller-supplied production key path.
- Mergify routes any PR touching a Wave-2 packet path—including mixed-path PRs—to a single-item corpus queue requiring `S3.3 Wave 2 Exact-Head Acceptance`. The workflow preserves the signed envelope before publishing that exact-head status, then post-merge re-verifies the signature/live transport and proves every merged packet blob equals the signed candidate before producing trusted-main consumption evidence.
- Embedding evidence is recorded as `diagnostic-only` with `canOverrideExactScan: false`.
- The rc-manifest AI section cites the machine-readable artifact digest. Without that exact-head artifact, the batch is not accepted and is not in the eval.
