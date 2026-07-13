# S3.3 Golden Held-Out Corpus — Datasheet (Wave 1)

**Authored by:** Lane 4 (Corpus & Data) · **Initial date:** 2026-07-10 · **Revision 7:** 2026-07-13 · **Status:** PRODUCER RESUBMISSION BLOCKED ON L3 PREREQUISITE REVIEW — NOT SUBMITTED FOR L3 ACCEPTANCE (per `docs/lane3/s33-batch-acceptance-protocol.md`, PR #1494 — producer/acceptor separation, CTO R11/R12; Lane 4 does not self-certify)
**Datasheet standard:** Datasheets for Datasets (Gebru et al.) shape — motivation, composition, collection, uses, limitations.

## Producer packet and handoff order

- Machine-readable batch manifest: `docs/lane4/s33-wave1-batch-manifest.json`.
- Machine-readable per-entry datasheet: `docs/lane4/s33-wave1-entry-datasheet.json`.
- Current producer revision: `S33-W1` revision 7; the datasheet pins the complete manifest file at SHA-256 `076346d2a6b05efd852fca1c8547215179837b99606a9b4878fc5e90c5859ef7`.
- The manifest and datasheet each contain exactly 81 unique rows in exact bijection with the corpus.
- The 11 Kenya priority-document rows are first in both artifacts so L3 can review that slice first. Acceptance remains whole-batch-only; this ordering does not claim or permit partial acceptance.
- Normalized model-input SHA-256 fingerprints are pinned per entry. Revision 2 changed only NUR-011, CPA-011, BAR-011, and PDH-010 under the RTE-authorized overlap remediation. Revision 3 removed the ungrounded `issuedDate: 2013-11-30` label from KE-010. Revision 4 corrects AU-007 `fieldOfStudy` to the explicit major `Accounting` and removes NUR-003's ungrounded ANCC accreditation assertion. Revision 5 removes unsupported labels from AU-008, NUR-004, and NUR-005, and replaces PDH-007's self-authored activity log with provider-issued completion evidence under the existing `CERTIFICATE/completion_certificate` ontology. Revision 6 removes PDH-007's unsupported extraction ground-truth jurisdiction because its source names no country or state; its recomputed normalized-input pin remains `647ce4116d8d36017f31e9cd9174157922592f1bc7e6c59135ae893d71e8d7c0`, with ten substantive fields. Revision 7 changes no corpus data: it is the clean six-file resubmission stacked on Lane 3 support commit `dd3ae1edecb005730762277daf17e15d8009459d`.

## Motivation
Held-out evaluation corpus for the S3.3 Gemini Golden A/B (RIG-TUNED vs RIG-PUBLIC), per the amended exit criteria (ART plan §4: domain-aggregate paired-bootstrap gate + no-covered-type-regresses>5pp floor + scored abstention). Held-out is curated BEFORE any synthetic generator is seeded (curate-before-seed, enforced by commit order — these data commits pre-date any Wave-1 generator work, which has not started).

## Composition (Wave 1, this PR)
| Slice | File | Entries | Edge cases | Notes |
|---|---|---|---|---|
| Professional licensing (depth-first: nursing/CME, CPA/CPE, bar/CLE, PE/PDH) | `golden-dataset-s33-licensing-heldout.ts` | 50 | 20 (40%) | subTypes incl. completion_certificate 20, general_cle 8, general_cpe 7, ethics_cpe/cle, specialized, cpa, nursing_rn, engineering_pe, law_bar_admission, good_standing; 14 US state jurisdictions + federal |
| Australia + Kenya | `golden-dataset-s33-au-ke-heldout.ts` | 22 (AU 11, KE 11) | 7 (32%) | AU: Ahpra-style registration, NSW/QLD practising certs, AQF, ASIC-style, ATO NoA; KE: NCK/KMPDC-style registration, LSK practising, TSC, KRA, KNEC — BOTH eCitizen-PDF-style and legacy stamped-paper-style variants included |
| Out-of-distribution negatives | `golden-dataset-s33-ood-negatives.ts` | 9 | 6 | Deliberately OUTSIDE the taxonomy; scored via abstention (OTHER + suggestedType), never as classification hits |
| **Total wave 1** | | **81** | **33 (41%)** | |

Shared type definitions are Lane 3-owned in the pinned base at `golden-dataset-s33-types.ts`, blob `dcc94b716f18240787640ba07dcdd4ad46a7cfe6` on commit `dd3ae1edecb005730762277daf17e15d8009459d`. That path is byte-identical to the base and absent from the producer diff, so protocol §1 packet scope passes. Lane 3's prerequisite still requires its own review and PR before this stack can be submitted or merged. CPE subtype values remain PROPOSED/unratified and are not accepted by their presence in the support file.

## Producer status — no acceptance claim

- **Within-type token overlap:** PASS after substantive independent re-authoring. Remediated pair scores are NUR 34.33%, CPA 37.33%, BAR 40.35%, and PDH 28.81%, all below the protocol's 80% ceiling. Issuer, format, scenario, field ordering, and content were varied; labels were updated to remain grounded.
- **OOD five-field semantics:** blocked for L3/CTO; Lane 4 did not pad abstention examples with invented labels.
- **CPE subtype extensions:** remain quarantined pending L3/CTO ratification.
- **Taxonomy adjudication set:** blocked for L3/CTO — KE-003, AU-003, KE-006, and AU-010 are unchanged.
- **Issued-date adjudication set:** blocked for L3/CTO — AU-002, AU-011, BAR-010, and PDH-012 are unchanged.
- **Batch-only scope:** PASS — the producer diff contains exactly the three corpus sources, manifest, and two datasheet artifacts. Lane 3 support review/PR remains a stack dependency, not a producer-file exception.
- **Acceptance/leakage:** not run by Lane 4. L3 alone owns deterministic sampling, prod-model diff, leakage audit, and the formal batch verdict.

Per protocol §1 and Confluence SCRUM-2777 AC8 (page 99057789), producer-support and Sonar-configuration files belong outside the Lane 4 packet. `.sonarcloud.properties`, `docs/lane4/s33-lane4-plan.md`, `services/worker/src/ai/eval/golden-dataset-s33-heldout.test.ts`, and `services/worker/src/ai/eval/golden-dataset-s33-types.ts` are absent from this producer diff. The shared types are supplied by the exact Lane 3 base, not copied into the batch.

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
Wave-1 entries carry `provenance: "authored-s33-lane4"`. The producer manifest pins direct parent/support base `dd3ae1edecb005730762277daf17e15d8009459d`, producer predecessor `dcbe0abd741a66401744a2cf916a583e865e2c9f`, source blobs (`ae2f9a77de929001526ce2e9571c9d217e9189e7` licensing, `af1f7228d8d9b0a33a894420d8f0902c0fb83ee8` AU/KE, and `33cf4fd3b35ef29fe90a13ed81b7a47ebc8d2fe4` OOD), and all normalized-input fingerprints. None of these producer pins is the L3 acceptance/freeze commit. Leakage wiring, formal acceptance, and the named held-out freeze remain L3-owned pre-window work.
