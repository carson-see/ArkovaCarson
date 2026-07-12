# L3 ↔ Lane 4 Corpus Batch Acceptance Protocol (Sprint 3.3)

> **Status:** interface contract, effective immediately (2026-07-10). Lane 4 owns corpus PRODUCTION; Lane 3 retains candidate selection, eval gates, A/B, leakage audit, and batch ACCEPTANCE authority (CTO R11/R12). Internal engineering notes; audited spec in Confluence (96894977).
> **Audience:** Lane 4 (corpus lane) — this is the contract your batches are accepted against. Lane 3 — this is the checklist you sign.

## 1. Batch submission format (Lane 4 → Lane 3)

Each batch is one PR (draft) containing ONLY:

1. Corpus entries under the agreed corpus root (net-new files; never edits to previously accepted entries — corrections are a new compensating batch, mirroring the migration rule).
2. A per-batch **datasheet fragment** with, per entry: real vs synthetic; source/provenance (lawful basis for real docs); generator name + version + seed (synthetic); template ID (synthetic); jurisdiction; type + concrete subType; curation author; curation date; license/consent note.
3. A batch manifest: batch id, entry count per type/domain, intended split (gate vs held-out candidate), Lane 4 self-check results against §3.

Batches that mix held-out candidates and training/gate entries in one undifferentiated pile are rejected without review — the split declaration is what the leakage audit keys on.

## 2. Lane 3 acceptance pipeline (per batch)

Run in order; stop at first failure.

1. **Structural check** — manifest parses; every entry has a datasheet row; counts reconcile.
2. **Quality invariant checklist (§3)** — deterministic script + human spot-check.
3. **≥10% cross-review** — Lane 3 reviews a ≥10% random sample (min 5 entries), sampled with a deterministic seed derived from the batch manifest hash (reproducible; Lane 4 cannot predict the sample at authoring time). Review = independently re-derive ground truth from the document text; any material label disagreement counts as a defect.
4. **Prod-model-diff screening** — run the current prod extraction path (public `gemini-2.5-flash`, Developer-API surface, v5 prompt) over the batch via the Gemini API under **mock-sandwich caps (CTO R14)**: bounded request count per batch, kill switch in the driver, spend logged against the sprint envelope. Diff prod-model output vs Lane 4 ground truth. Mismatches are NOT auto-defects (the model can be wrong — that is the point of the corpus); each mismatch is flagged for human adjudication: label error → defect; model error → keep, tag as model-hard. Precedent: v7 design §11 ("run v6 on new entries + diff flags mismatches for human review") — the control this replaces was skipped for phase18 and cost −21pp on FINANCIAL.
5. **Leakage / contamination audit** — held-out candidates must be REAL or independently curated, never generator-derived; n-gram overlap (n=6–13) + embedding near-dup scan vs training corpus, generator templates, and tuning JSONL exports (template mimicry evades lexical checks); extends #1413's `heldout-leakage.ts` manifest once merged.
6. **Acceptance defect thresholds** — any of the following rejects the batch: >5% of cross-reviewed sample has material label defects; any §3 hard invariant fails; any leakage hit on a held-out candidate; datasheet rows missing or false (e.g., synthetic marked real — this one is a trust incident, not just a defect).

## 3. Quality invariant checklist

Hard invariants (any failure = reject):

- [ ] ≥5 non-null ground-truth fields per entry (bounds the `missing_both` F1 inflation — see eval methodology §4).
- [ ] Concrete `subType` per entry — no `other`, no missing (v6 quality bar; the phase18 subType inconsistency cost −14.9pp emission).
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

1. At corpus close (before the 48h A/B window opens, L3-S4), Lane 3 declares the final held-out set and lands a **freeze commit**: the held-out manifest (entry ids + normalized-content SHA-256 fingerprints) pinned at a named commit SHA, recorded in the rc-manifest AI section.
2. From the freeze commit onward: no held-out entry may be edited, moved, or referenced by any generator/tuning export; the leakage CI (fail-closed, #1413 pattern) enforces this mechanically.
3. **Curate-before-seed commit order** is binding: held-out entries must land in git BEFORE any synthetic generator seeding that could observe them; datasheet timestamps + commit order are the audit trail.
4. Any post-freeze corpus change voids the window evidence for affected domains (§1.11A analogue: evidence is exact-content, not vibes).

## 6. Accountability

- Every accepted batch gets a signed acceptance record (Lane 3 session, date, pipeline results, spend used by step 4) appended to the corpus datasheet.
- Lane 3's acceptance signature is what the rc-manifest AI section cites for corpus integrity. If it is not signed, it is not in the eval.
