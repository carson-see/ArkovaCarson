# L3 ↔ Lane 4 Corpus Batch Acceptance Protocol (Sprint 3.3)

> **Status:** interface contract, amended 2026-07-14 by binding CTO ruling 102498305. Lane 4 owns corpus PRODUCTION; Lane 3 retains candidate selection, eval gates, A/B, leakage audit, and batch ACCEPTANCE authority (CTO R11/R12). Internal engineering notes; audited spec in Confluence (96894977).
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
3. **Whole-batch machine validation + ≥10% human cross-review** — the post-validation depth/OOD contract runs over every row, Kenya first. Lane 3 then independently re-derives ground truth for a deterministic ≥10% sample (minimum 5) bound to the committed manifest digest; any material label disagreement counts as a defect. GitHub exact-head review and CI are the trust root; no salt commitment/reveal or external signer is required.
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

1. At corpus close, Lane 3 records the final held-out set at the exact #1498 single-parent head. Revision 12 uses two independent histories: the Lane-4 producer history (`r10 → r11′ → r12`) and the Lane-3 support history (`support baseline → S12`). The support tree is never treated as the producer's parent and `support..producer` is never accepted as provenance.
2. The code-owned revision-12 descriptor pins r10, the support baseline, S12, r11′, r12, their unique merge base, nonempty exact declared subsets of the six packet paths on both producer edges, all six packet blobs/digests, the historical r11′ failure set/digest, and all CTO adjudication objects. r11′ must be the exact direct single-parent child of r10: intermediate commits and tamper-then-revert history are forbidden. Each producer edge permits only `A`/`M` regular non-executable `100644` blobs inside the six packet paths; deletes, renames, copies, type changes, symlinks, gitlinks, executable bits, and outside paths fail closed.
3. The lexical transition universe is exact: the code-owned **LEAKAGE32** set plus the sole separately authorized non-leakage transition `GD-S33-KE-006` under `CTO_R12_TAXONOMY_AND_DEPTH_ADJUDICATION`. Those sets must be disjoint; their 33-entry union must equal the raw `strippedText` changes, source-text-change list, normalized-input-change list, recomputed-fingerprint keys, and parent-to-r12 transition keys. LEAKAGE32 alone owns the leakage hit set/counters; every other r11′ raw `strippedText` byte sequence and normalized fingerprint must remain unchanged.
4. r11′ is retained as `HISTORICAL_BLOCKED` and its final Lane-3 acceptance is rejected against its exact expected failure set. r12 must independently pass the full 81-row packet/manifest/datasheet/source bijection, digest pins, adjudications, and zero post-validation ground-truth failures.
5. Lane 3 proves the histories compose without rewriting either one: the pinned merge base to r12 is exactly six `100644` additions; `git merge-tree --write-tree S12 r12` must be conflict-free; and the final freeze F12 must be a single-parent child of S12 whose tree equals that virtual merge tree. `S12 → F12` is exactly six `100644` additions, every F12 packet blob equals r12, and the Lane-3 support/types blob equals S12.
6. The freeze identity is F12's head SHA and Git tree SHA plus the committed manifest's raw and canonical SHA-256 digests and the dual-DAG verification-report digest.
7. From the freeze commit onward: no held-out entry may be edited, moved, or referenced by any generator/tuning export; the leakage CI (fail-closed, #1413 pattern) enforces this mechanically.
8. **Curate-before-seed commit order** is binding: held-out entries must land in git BEFORE any synthetic generator seeding that could observe them; datasheet timestamps + commit order are the audit trail.
9. Any post-freeze corpus change voids the window evidence for affected domains (§1.11A analogue: evidence is exact-content, not vibes).

## 6. Accountability

- Every accepted batch gets a separate machine-readable Lane-3 acceptance artifact. It binds the #1498 PR number, producer head/tree, committed manifest digests, GitHub exact-head approval, successful CI checks, cross-review evidence, offline prod-model-diff evidence, and zero-hit exact leakage evidence. It does not mutate the frozen producer packet.
- GitHub authentication and CI are the Wave-1 trust root. No external signing key, signer identity, monotonic registry, salt commitment/reveal, or separate ceremony is required.
- Embedding evidence is recorded as `diagnostic-only` with `canOverrideExactScan: false`.
- The rc-manifest AI section cites the machine-readable artifact digest. Without that exact-head artifact, the batch is not accepted and is not in the eval.
