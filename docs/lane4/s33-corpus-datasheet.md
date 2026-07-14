# S3.3 Golden Held-Out Corpus — Datasheet (Wave 1, Revision 12)

**Authored by:** Lane 4 (Corpus & Data) · **Initial date:** 2026-07-10 · **Revision 12:** 2026-07-14 · **Status:** PRODUCER_R12_CANDIDATE_PENDING_L3_FORMAL_ACCEPTANCE — exact e8 production-depth evaluation is GREEN0; Lane 4 does not self-accept
**Datasheet standard:** Datasheets for Datasets (Gebru et al.) shape — motivation, composition, collection, uses, limitations.

## Producer packet and handoff order

- Machine-readable batch manifest: `docs/lane4/s33-wave1-batch-manifest.json`.
- Machine-readable per-entry datasheet: `docs/lane4/s33-wave1-entry-datasheet.json`.
- Current producer revision: `S33-W1` revision 12; the datasheet pins the complete manifest file at exact raw-file SHA-256 `eeb7c1b4bbd71642b4a7429864c0e04e9a5e3daf74b2cd78dd26442592f56e20` (also recorded in `s33-wave1-entry-datasheet.json`).
- The manifest and datasheet each contain exactly 81 unique rows in exact bijection with the corpus.
- The 11 Kenya priority-document rows are first in both artifacts so L3 can review that slice first. Acceptance remains whole-batch-only; this ordering does not claim or permit partial acceptance.
- Normalized model-input SHA-256 fingerprints are recomputed and pinned for all 81 entries. Revisions 2–10 retain their recorded source-grounding and history-preserving corrections. Clean revision 11′ (`48c42dcee17eb121bc79323f94c62d7c5b9ff5b9`) is the direct child of live revision 10 and the honest HISTORICAL_BLOCKED production-depth RED32 checkpoint. Revision 12 applies the binding CTO surgery: the exact 20-row acceptance-only CPE evaluator set, fourteen source-grounded depth curations, exact taxonomy and issued-date adjudications, the pure-abstention OOD exception, and CTO remediation B for the exact LEAKAGE32 lexical-hit texts. Relative to revision 11′, 33 normalized inputs change: LEAKAGE32 plus the sole separately authorized, non-leakage KE-006 source-grounded depth surgery. The manifest pins every parent-to-revision-12 fingerprint transition.

## Motivation
Held-out evaluation corpus for the S3.3 Gemini Golden A/B (RIG-TUNED vs RIG-PUBLIC), per the amended exit criteria (ART plan §4: domain-aggregate paired-bootstrap gate + no-covered-type-regresses>5pp floor + scored abstention). Held-out is curated BEFORE any synthetic generator is seeded (curate-before-seed, enforced by commit order — these data commits pre-date any Wave-1 generator work, which has not started).

## Composition (Wave 1, this PR)
| Slice | File | Entries | Edge cases | Notes |
|---|---|---|---|---|
| Professional licensing (depth-first: nursing/CME, CPA/CPE, bar/CLE, PE/PDH) | `golden-dataset-s33-licensing-heldout.ts` | 50 | 20 (40%) | Exact acceptance-only CPE evaluator set: 10 NUR + 10 PDH, in addition to 11 CPA CPE rows; NUR-004 remains CERTIFICATE/training_certificate and PDH-002 remains LICENSE/engineering_pe |
| Australia + Kenya | `golden-dataset-s33-au-ke-heldout.ts` | 22 (AU 11, KE 11) | 7 (32%) | AU: Ahpra-style registration, NSW/QLD practising certs, AQF, ASIC-style, ATO NoA; KE: NCK/KMPDC-style registration, LSK practising, TSC, KRA, KNEC — BOTH eCitizen-PDF-style and legacy stamped-paper-style variants included |
| Out-of-distribution negatives | `golden-dataset-s33-ood-negatives.ts` | 9 | 6 | Deliberately OUTSIDE the taxonomy; pure abstention truth is exactly OTHER + `other` + empty `fraudSignals`, never a classification or extraction hit |
| **Total wave 1** | | **81** | **33 (41%)** | |

Shared evaluator definitions are Lane 3-owned in the separate CTO-approved support DAG: `golden-dataset-s33-types.ts`, blob `fbc05660e4575c3c527204658571246f9294ceb9` on commit `e8a9ba3d2ba8023fe59781b6a0499c8208cc59af`. The support commit is intentionally not an ancestor of the producer chain; the final F12 materialization gate joins the two DAGs. The acceptance-only `general_cpe`, `specialized_cpe`, and `ethics_cpe` values do not change `V6_SUBTYPE_TAXONOMY` and are not tuning-export approved. A prod-parity subtype mismatch is `MODEL_HARD`, never a corpus `LABEL_DEFECT`.

## Producer status — no acceptance claim

- **Production depth:** PASS — the exact e8 evaluator accepts all 72 covered rows with post-validation depth ≥5 and all nine strict OOD rows; GREEN0 follows the pinned revision-11′ RED32 checkpoint.
- **Within-type token overlap:** PASS after substantive independent re-authoring. All 687 same-type pairs were recomputed with zero violations; the maximum observed coefficient is 49.15%. The four historically remediated pair scores are NUR 36.21%, CPA 33.33%, BAR 33.93%, and PDH 28.81%, all below the protocol's 80% ceiling.
- **Lexical leakage precheck:** PASS_PRODUCER_AND_RTE_INDEPENDENT_PENDING_L3 — the exact #1413/e8 scanner (`e8a9ba3d2ba8023fe59781b6a0499c8208cc59af`, `heldout-leakage.ts` blob `908e52a16e27c1a269f0526d449f30dcf9555ee0`) initially rejected 341 exact normalized n=6–13 hits across LEAKAGE32. CTO remediation B re-authored LEAKAGE32 Kenya-first without changing grounded truth; KE-006 is not in LEAKAGE32 and changed only under the separate taxonomy-and-depth adjudication. The independent RTE rerun against the full 307-file corpus reports zero hits at every n. This is pre-acceptance evidence, not Lane 3's formal verdict.
- **Privacy:** PASS producer precheck — 81/81 entries remain synthetic-realistic, broader numeric matches are source-grounded synthetic document identifiers, and the targeted email, SSN, formatted-phone, payment-card, and private-key scan reports zero unexpected PII. No Arkova production document is present.
- **OOD:** PASS_CTO_L3_R12_PURE_ABSTENTION — the exact nine rows contain only `OTHER` / `other` / `[]`; no issuer, date, jurisdiction, or other extraction truth is padded.
- **CPE subtype extensions:** PASS for Wave-1 acceptance/evaluation only; v6 prompt/runtime remains byte-preserved and tuning export remains forbidden.
- **Taxonomy:** PASS_CTO_L3_R12 — AU-003 and KE-003 are LICENSE/law_bar_admission; KE-006 is IDENTITY/government_id; AU-010 is FINANCIAL/tax_return.
- **Issued dates:** PASS_CTO_L3_R12 — AU-002 `2026-04-22`, AU-011 `2026-04-16`, BAR-010 `2026-01-05`, PDH-012 `2026-04-28`.
- **Batch-only scope:** PASS — the r11′→r12 edge changes the exact declared five-path subset (three docs plus licensing and AU/KE sources), while all six packet files are fully validated at the r12 head; OOD source bytes remain intentionally unchanged.
- **Formal acceptance:** pending. Producer and independent RTE leakage/field-contract prechecks pass, but L3 alone owns deterministic sampling, prod-model diff, authenticated leakage artifacts, embedding diagnostic, and the formal whole-batch verdict.

Per protocol §1 and Confluence SCRUM-2777 AC8 (page 99057789), producer-support and Sonar-configuration files belong outside the Lane 4 packet. `.sonarcloud.properties`, `docs/lane4/s33-lane4-plan.md`, `services/worker/src/ai/eval/golden-dataset-s33-heldout.test.ts`, and `services/worker/src/ai/eval/golden-dataset-s33-types.ts` are absent from this producer diff. Shared evaluator types are supplied by the separately pinned Lane 3 support DAG and verified only when F12 materializes the conflict-free dual-DAG join; they are not copied into the producer packet or inherited from its parent.

## Collection / authorship
Every entry is **independently authored** by Lane 4 (`provenance: "authored-s33-lane4"`): synthetic-realistic documents with fictional people and organizations (Kenya DPA / GDPR safe — no real personal data), varied layouts and wording. **NO entry is template-generator-derived** — generators have not been seeded (curate-before-seed). Kenya entries deliberately span the modern eCitizen-PDF+QR generation and legacy typewritten/stamped paper. AU state variants treated as intra-type variation per the research-brief guidance.

## Held-out coverage NOT provided in Wave 1 (datasheet-marked N/A; R-7: no coverage claims)
- LEGAL / FINANCIAL / EDUCATION top-15-types-per-domain slices — **remaining scope**, next Lane-4 wave (floor: ≥12 each for top-15 types/domain).
- The 13 non-depth-first professions — synthetic-only by design this sprint, held-out coverage: N/A.
- Stretch scope (top-25 types/domain, AU/KE ≥15, +2 professions) — unlocks only as fast as L3 acceptance absorbs (CTO R13 governor).
- Audio/image modalities — out of corpus scope (L3-S6 spike governs).

## Uses & limitations
For eval gates only; **excluded from any tuning export**. Small-n slices (AU/KE, per-type) are directional — gates run at domain aggregate; per-type numbers are diagnostics (n=12–15 ⇒ ±25pp 95% CI). Historical Golden eval figures are contaminated upper bounds (~224/249) — this corpus exists to replace them.

## Provenance & integrity
Wave-1 entries carry `provenance: "authored-s33-lane4"`. Revision 12 has sole physical parent and direct base `48c42dcee17eb121bc79323f94c62d7c5b9ff5b9`; its logical producer predecessor is exact commit `48c42dcee17eb121bc79323f94c62d7c5b9ff5b9`. The separate Lane-3 evaluator root is `e8a9ba3d2ba8023fe59781b6a0499c8208cc59af`. The manifest pins source blobs (`78090443bad793d248fdd1e3d22f7e468d618777` licensing, `7826dc6a34b475bdf2c73f9059026b8d19ec1b1f` AU/KE, and unchanged `a261cf690c930040f7dee0361ed29d73d1d23426` OOD), all 81 entries, all normalized-input fingerprints, the exact RED341→GREEN0 remediation record, and all per-entry datasheet rows. These pins are the producer candidate, not formal L3 acceptance or the named freeze.
