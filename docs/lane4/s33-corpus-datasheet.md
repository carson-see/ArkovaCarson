# S3.3 Golden Held-Out Corpus — Datasheet (Wave 1, Revision 11)

**Authored by:** Lane 4 (Corpus & Data) · **Initial date:** 2026-07-10 · **Revision 11:** 2026-07-13 · **Status:** HISTORICAL_BLOCKED — exact e8 production-depth evaluation fails 32 covered rows; this structural/history checkpoint is not eligible for final acceptance
**Datasheet standard:** Datasheets for Datasets (Gebru et al.) shape — motivation, composition, collection, uses, limitations.

## Producer packet and handoff order

- Machine-readable batch manifest: `docs/lane4/s33-wave1-batch-manifest.json`.
- Machine-readable per-entry datasheet: `docs/lane4/s33-wave1-entry-datasheet.json`.
- Current producer revision: `S33-W1` revision 11; the datasheet pins the complete manifest file at exact raw-file SHA-256 `9625ed06da78fef266df49bd7f4941d4ee9b1f8825cad229e146fe34296d961d` (also recorded in `s33-wave1-entry-datasheet.json`).
- The manifest and datasheet each contain exactly 81 unique rows in exact bijection with the corpus.
- The 11 Kenya priority-document rows are first in both artifacts so L3 can review that slice first. Acceptance remains whole-batch-only; this ordering does not claim or permit partial acceptance.
- Normalized model-input SHA-256 fingerprints are pinned per entry. Revision 2 changed only NUR-011, CPA-011, BAR-011, and PDH-010 under the RTE-authorized overlap remediation. Revision 3 removed the ungrounded `issuedDate: 2013-11-30` label from KE-010. Revision 4 corrects AU-007 `fieldOfStudy` to the explicit major `Accounting` and removes NUR-003's ungrounded ANCC accreditation assertion. Revision 5 removes unsupported labels from AU-008, NUR-004, and NUR-005, and replaces PDH-007's self-authored activity log with provider-issued completion evidence under the existing `CERTIFICATE/completion_certificate` ontology. Revision 6 removes PDH-007's unsupported extraction ground-truth jurisdiction because its source names no country or state; its recomputed normalized-input pin remains `647ce4116d8d36017f31e9cd9174157922592f1bc7e6c59135ae893d71e8d7c0`, with ten substantive fields. Revision 7 changes no corpus data: it is the clean six-file resubmission stacked on Lane 3 support commit `dd3ae1edecb005730762277daf17e15d8009459d`. Revision 8 removes unsupported jurisdiction labels from NUR-004 and NUR-005 and minimally re-authors NUR-005 as an issuer-backed certificate of completion containing continuing-education transcript rows; NUR-005's new normalized-input pin is `68085d32defe764e6a6462a936c8493844e8c4213ff27943a51ff7026d0c90b9`. Revision 9 leaves every `strippedText` byte unchanged, converts all nine OOD examples to pure abstention truth (`OTHER` / `other` / empty `fraudSignals` only), and applies candidate AU-002/AU-011 `issuedDate` labels from the explicit extract-generated/prepared dates (`2026-04-22` / `2026-04-16`) instead of historical registration dates. NUR-004, NUR-005, and AU-008 were re-verified to contain no `deliveryMethod`; their already-correct corpus bytes were not changed. Revision 10 changes metadata only: it transplants the reviewed revision-9 corpus truth onto exact-head-reviewed Lane 3 support commit `ee7bba26fc0e34a7a58bb684f45e4e3c4e6b2977`. Revision 11 leaves every `strippedText` byte and normalized-input pin unchanged, changes AU-002 `issuerName` to the source-stated `Ahpra`, removes KE-009's computed exact `expiryDate` because the source states only the issue date and a twelve-month validity term, and explicitly leaves the AU-002/AU-011 issued-date policy blocked for L3/CTO adjudication.

## Motivation
Held-out evaluation corpus for the S3.3 Gemini Golden A/B (RIG-TUNED vs RIG-PUBLIC), per the amended exit criteria (ART plan §4: domain-aggregate paired-bootstrap gate + no-covered-type-regresses>5pp floor + scored abstention). Held-out is curated BEFORE any synthetic generator is seeded (curate-before-seed, enforced by commit order — these data commits pre-date any Wave-1 generator work, which has not started).

## Composition (Wave 1, this PR)
| Slice | File | Entries | Edge cases | Notes |
|---|---|---|---|---|
| Professional licensing (depth-first: nursing/CME, CPA/CPE, bar/CLE, PE/PDH) | `golden-dataset-s33-licensing-heldout.ts` | 50 | 20 (40%) | subTypes incl. completion_certificate 20, general_cle 8, general_cpe 7, ethics_cpe/cle, specialized, cpa, nursing_rn, engineering_pe, law_bar_admission, good_standing; 14 US state jurisdictions + federal |
| Australia + Kenya | `golden-dataset-s33-au-ke-heldout.ts` | 22 (AU 11, KE 11) | 7 (32%) | AU: Ahpra-style registration, NSW/QLD practising certs, AQF, ASIC-style, ATO NoA; KE: NCK/KMPDC-style registration, LSK practising, TSC, KRA, KNEC — BOTH eCitizen-PDF-style and legacy stamped-paper-style variants included |
| Out-of-distribution negatives | `golden-dataset-s33-ood-negatives.ts` | 9 | 6 | Deliberately OUTSIDE the taxonomy; pure abstention truth is exactly OTHER + `other` + empty `fraudSignals`, never a classification or extraction hit |
| **Total wave 1** | | **81** | **33 (41%)** | |

Shared evaluator definitions are Lane 3-owned in the separate CTO-approved support DAG at `golden-dataset-s33-types.ts`, blob `fbc05660e4575c3c527204658571246f9294ceb9` on commit `e8a9ba3d2ba8023fe59781b6a0499c8208cc59af`. The support commit is intentionally not an ancestor of this producer checkpoint, and the types path is absent from the producer diff. `CTO_APPROVED_DUAL_DAG_R12_EVALUATOR_ROOT` approves the evaluator-root architecture only; it is not corpus acceptance, a merge claim, or a launch-readiness claim. CPE subtype values remain PROPOSED/unratified at revision 11′.

## Producer status — no acceptance claim

- **Production depth:** HISTORICAL_BLOCKED — exact support head `e8a9ba3d2ba8023fe59781b6a0499c8208cc59af` rejects 32 covered rows after production validation. The ordered failure-ID array is pinned in the manifest at SHA-256 `c3e588bbc990c7d913b2c21c0ab232c9624bbde86f803d1ba3fcd1a561f327eb`; revision 11 is retained only as the history checkpoint for revision 12 surgery.
- **Within-type token overlap:** PASS after substantive independent re-authoring. Remediated pair scores are NUR 34.33%, CPA 37.33%, BAR 40.35%, and PDH 28.81%, all below the protocol's 80% ceiling. Issuer, format, scenario, field ordering, and content were varied; labels were updated to remain grounded.
- **OOD protocol contradiction:** BLOCKED for L3/CTO. Revision 9 truthfully encodes pure abstention with only two substantive fields (`credentialType: OTHER`, `subType: other`) plus empty `fraudSignals`. Protocol §3 simultaneously requires ≥5 non-null ground-truth fields and forbids `subType: other` for every entry. Lane 4 did not restore invented issuer/date/jurisdiction labels to manufacture compliance; L3/CTO must amend or explicitly adjudicate the OOD exception before acceptance.
- **CPE subtype extensions:** remain quarantined pending L3/CTO ratification.
- **Taxonomy adjudication set:** blocked for L3/CTO — KE-003, AU-003, KE-006, and AU-010 are unchanged.
- **Issued-date adjudication set:** AU-002 and AU-011 carry candidate revision-9 labels using their explicit document extract/prepared dates instead of historical registration dates; Lane 4 does not self-certify that policy. AU-002, AU-011, BAR-010, and PDH-012 remain blocked for L3/CTO adjudication.
- **Batch-only scope:** PASS — the immediate revision-10→revision-11′ edge changes exactly the declared nonempty four-path A/M subset: the two datasheet artifacts, manifest, and AU/KE source. The separate Lane-3 support DAG is a documented evaluator dependency, not a producer-file exception.
- **Acceptance/leakage:** REJECTED_HISTORICAL_BLOCKED — Lane 3 rejects this exact checkpoint on the pinned 32-row production-depth failure set. Lexical leakage audit, deterministic sampling, prod-model diff, and final whole-batch acceptance remain revision-12 work.

Per protocol §1 and Confluence SCRUM-2777 AC8 (page 99057789), producer-support and Sonar-configuration files belong outside the Lane 4 packet. `.sonarcloud.properties`, `docs/lane4/s33-lane4-plan.md`, `services/worker/src/ai/eval/golden-dataset-s33-heldout.test.ts`, and `services/worker/src/ai/eval/golden-dataset-s33-types.ts` are absent from this producer diff. The shared types remain in the separately pinned Lane-3 evaluator DAG and are not copied into the batch or inherited from its parent.

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
Wave-1 entries carry `provenance: "authored-s33-lane4"`. Revision 11 has sole physical parent and direct base `1018e36844834537df29fb60eb871cb54475bc14`; its logical producer predecessor is exact commit `1018e36844834537df29fb60eb871cb54475bc14`. The separate Lane-3 evaluator root is `e8a9ba3d2ba8023fe59781b6a0499c8208cc59af`. The producer manifest pins source blobs (`4ac117c1663c6aefb63c7715440744af0e0b6a23` licensing, `a1578a511e47bd839fda9ae31e5f3f93c99a3857` AU/KE, and `a261cf690c930040f7dee0361ed29d73d1d23426` OOD), all 81 entries, all normalized-input fingerprints, and all per-entry datasheet rows. Revision 11′ honestly retains the known depth, CPE-contract, OOD, taxonomy, and issued-date blockers and is formally `REJECTED_HISTORICAL_BLOCKED`; neither the producer pins nor the dual-DAG architecture ruling is a freeze or launch decision.
