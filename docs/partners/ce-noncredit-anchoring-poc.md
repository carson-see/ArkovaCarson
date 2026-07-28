# CE Noncredit Data Taxonomy 3.0 — Anchoring POC

**Item:** L3-A6 (revised 2026-07-28, founder amendment A4 — supersedes the earlier generic "Registry Snapshot Anchoring" (R12) framing)
**Status:** POC code-complete, DRAFT PR, 72h soak per T2 tier. Not yet demoed to Credential Engine.
**Internal engineering note only** — per CLAUDE.md §4, this is NOT the canonical documentation record. If this POC proceeds to a partner conversation, the durable spec belongs on a Confluence page (`SCRUM-N — CE Noncredit Anchoring POC`), not this file.

---

## 1. The thesis

Credential Engine (CE) published, on **2026-07-16**, a **State Noncredit Data Taxonomy Benchmark Model** mapping Rutgers EERC's **Noncredit Data Taxonomy (NDT) 3.0** — 90+ data elements across four sections (Purpose & Design, Student Outcomes, Enrollment & Demographics, Finance & Policy) — to CTDL classes and properties. The project's state partners are Iowa, Louisiana, Maryland, New Jersey, Oregon, South Carolina, Tennessee, and Virginia (the **State Noncredit Data Project**, funded by the Strada Education Foundation, with Rutgers EERC as the research lead). CE's guidance is now actively asking states and institutions to **begin publishing noncredit records to the Credential Registry**.

Roughly **4.1 million community-college students** are enrolled in noncredit offerings nationally — certificate programs, workforce-training courses, continuing-education sequences — that structurally lack the verification substrate degree-seeking students take for granted: no registrar record, no transcript, frequently no institutional record retention policy at all. That is precisely the credential class Arkova exists to serve: **tamper-evident, independently-timestamped proof that a specific record existed with specific content at a specific point in time**, for exactly the population with no other way to get it.

Arkova's angle is narrow and honest: we are not a taxonomy, not a registry, and not a publishing tool. We are the **proof layer** underneath a registry record CE (or a state, or an institution) already published — supplying the one thing the CTDL registry publishing act itself does not supply: a durable, third-party-verifiable fingerprint of the record's exact content at a moment in time, independent of whether that registry record is later edited, moved, or removed.

## 2. Research — what the benchmark model actually specifies

**Sources (fetched 2026-07-28):**
- Guidance / publishing template: <https://guidance.credentialengine.org/noncredit-data-taxonomy/>
- Announcement: <https://credentialengine.org/2026/07/16/mapping-the-noncredit-data-taxonomy-3-0-to-the-ctdl-a-new-benchmark-model-for-noncredit-education-data/>
- Benchmark model (class dropdown, not directly linkable): <https://credreg.net/registry/benchmarks?benchmark=noncreditdata>
- Publishing template (Google Sheet, "BU Template" + Data Dictionary): <https://docs.google.com/spreadsheets/d/13wsjilm9o5S2dBba-S9mRZOljXRS-rQgDBG-xIFG6es>
- CTDL types reference: <https://credreg.net/page/typeslist>, <https://credreg.net/ctdl/terms/LearningProgram>, <https://credreg.net/ctdl/terms/LearningOpportunityProfile>
- Taxonomy source document: <https://sndp.noncreditresearch.org/wp-content/uploads/2026/06/EERC_Noncredit-Data-Taxonomy-3.0_June-2026.pdf>
- Project home: <https://sndp.noncreditresearch.org/>

**CTDL classes involved.** CTDL's model for a noncredit offering is a **`ceterms:LearningProgram`** — a documented subclass of **`ceterms:LearningOpportunityProfile`** ("a set of learning opportunities that leads to an outcome, usually a credential like a degree or certificate," per the CTDL schema definition), with `ceterms:Course` as a sibling subclass for course-level noncredit offerings. This is the key structural fact: **a noncredit program record is a PROGRAM/OPPORTUNITY class, not a CREDENTIAL class** in CTDL terms — a direct consequence of "noncredit" itself, since many noncredit offerings never award a formal credential (degree/certificate/license) at all. The benchmark's other referenced classes (`ceterms:CredentialOrganization` for the issuing institution, `ceterms:ConditionProfile` / `ceterms:CostProfile` for enrollment/finance detail, per the general CTDL pattern already used elsewhere in Arkova's importer) follow the same shape as CE's existing credential-record graphs.

**No live noncredit registry record found.** We searched the public registry (`credreg.net`) and web for any already-published NDT-3.0-shaped record and found none. This matches the guidance page's own framing — CE is asking partners to **start** publishing now, not pointing to examples already live. That is an honest finding, not a gap in our research: **the registry has no NDT-3.0 noncredit records yet, as of this research pass (2026-07-28)**. The POC therefore anchors against a **template-shaped fixture** built from the benchmark model's own documented class semantics (`services/worker/src/ctdl/__fixtures__/ce-template-noncredit-learning-program.json`), not a fetched live record — clearly labeled as such in the fixture's companion test file. The anchoring PATH itself (fetch → hash → parse → anchor) is proven against this template shape and is otherwise identical to the live-record path already proven for credential-class records in `ctdl-importer.real-fixtures.test.ts` (SCRUM-2913 / PR #1603).

## 3. The technical finding — our parser silently dropped noncredit records

This is the load-bearing result of this POC. Arkova's CTDL importer (`services/worker/src/ctdl/ctdl-importer.ts`) ships a credential-class filter (`credentialNodesOnly: true`, added SCRUM-2913 / PR #1603) that admits a record only when its `@type` is one of 20 enumerated `ceterms:` credential classes (`Certificate`, `Certification`, `License`, `Degree`, `Badge`, …) or matches a fallback pattern for credential-shaped class names. This filter exists to solve a real problem: a real CE `/graph/<ctid>` envelope carries the credential node plus organization / concept / profile nodes, and without a filter, ~83% of a typical graph fetch turns into junk records.

**We verified — did not assume — that `ceterms:LearningProgram` fails this filter.** It is not in the 20-class enumeration, and it does not match the fallback pattern (`Certificat|Licen|Degree|Badge|Diploma|Credential` substrings — "LearningProgram" contains none of them). Worse, the filter's own veto suffix list (which exists to reject `ceterms:CredentialOrganization`/`ceterms:QACredentialOrganization`-style false positives) also happens to end in `...LearningOpportunity` and `...Profile` — meaning even a looser keyword match would have been vetoed. **Before this PR, feeding a real noncredit `ceterms:LearningProgram` record through the exact mode the demo-able consumer route (`GET /api/v1/credentials/ctdl/import`) uses returned zero records — filtered out as non-credential junk, the same bucket as an org node.** That is the opposite of what this POC needs, since noncredit is precisely the record class it exists to anchor.

The proof is in `services/worker/src/ctdl/ctdl-importer.noncredit.test.ts`: a test explicitly demonstrates `parseCtdlEnvelope(fixture, { credentialNodesOnly: true })` → 0 records against the noncredit fixture, alongside the fix (`includeNoncreditProgramClasses: true`, additive, default `false`) → 1 correctly-typed, correctly-issuer-resolved record.

**The fix** adds a second, explicit, small enumeration — `CTDL_NONCREDIT_PROGRAM_CLASSES` (`ceterms:LearningProgram`, `ceterms:LearningOpportunityProfile`, `ceterms:LearningOpportunity`, `ceterms:Course`) — admitted only when a new `includeNoncreditProgramClasses` option is explicitly set. It never widens the existing `CTDL_CREDENTIAL_CLASSES` enumeration (noncredit programs are a genuinely different CTDL class family, not a credential subtype), and it defaults to `false`, so every existing caller (the SCRUM-2913 consumer route as previously deployed, the fuzz suite, `ctdl-importer.real-fixtures.test.ts`) is byte-for-byte unaffected.

## 4. What the POC demonstrates end-to-end

1. **Parse** — a noncredit `ceterms:LearningProgram` (or `LearningOpportunityProfile` / `LearningOpportunity` / `Course`) node is correctly admitted, typed, and issuer-resolved (`services/worker/src/ctdl/ctdl-importer.ts`, `ctdl-importer.noncredit.test.ts`).
2. **Fetch, hash, discard (§1.6A)** — `POST /api/v1/credentials/ctdl/registry-anchor` reuses the EXACT SSRF-hardened `safeFetch` → `fetchRegistryGraph` primitives already shipped for the credential-class consumer (`credentials-ctdl-import.ts`) — no second outbound-fetch implementation. Raw registry bytes are SHA-256'd in memory and discarded; only the fingerprint + bounded, already-public metadata (CTID, registry URL, envelope SHA-256, retrieval time, record name/type, issuer name) ever reach `anchors.metadata`.
3. **Claims guard (R-7)** — the assembled response is passed through `assertNoProhibitedClaimInJsonLd` before an anchor is ever created, so a hostile or careless registry record's own free text can never smuggle a "listed in the Credential Registry"-shaped claim into Arkova's own output.
4. **Anchor** — an Arkova anchor is created (`status: PENDING`, `credential_type: 'OTHER'` — see §6), fingerprinted deterministically from `sha256(ctid + envelope_sha256)` so re-anchoring the same registry state is idempotent (`duplicate: true`, no second row).
5. **UI** — `src/components/credentials/CtdlRegistryImportDialog.tsx`, reachable from the "Imported Records" page (`/my-credentials`) via a new "From Public Registry" button, next to the existing "Add Source" entry point. Two-step UX: look up (shows record name/type/issuer + fingerprint) → add (shows the resulting record link).

## 5. What is measured, what is asserted, what is NOT asserted (§1.5)

**Measured** (facts Arkova can independently stand behind):
- The exact bytes returned by `credentialengineregistry.org/graph/<ctid>` at `retrievedAt`, fingerprinted as `envelopeSha256`.
- That those bytes parsed as a specific CTDL node of a specific `@type`, with a specific `ceterms:name` and issuer reference.
- That an Arkova anchor exists whose fingerprint is derived from that exact envelope hash, independently timestamped.

**Asserted** (Arkova's own claim, clearly scoped):
- "This record references Credential Engine Registry CTID `<ctid>`, retrieved `<retrievedAt>`, envelope fingerprint `<sha256>`." That is the full extent of the claim.
- Arkova is **CE-Approved to publish** to the Credential Registry (a real, held status) — this is a statement about Arkova's own publisher approval, not about any specific record's registry status.

**NOT asserted — explicitly, per R-7:**
- Arkova is **NOT** "listed in the Credential Registry." Being approved to publish is not the same as any given record being listed, and this POC does not publish anything back to CE — it is read-only against the public registry.
- Arkova does **NOT** assert that the underlying registry record is accurate, current, or endorsed by Credential Engine. `envelopeSignatureVerified` is emitted as `null` (unchecked) and is never rendered as CE endorsement of Arkova — a verified envelope signature (were we to check it) would only mean "these bytes came from CE's registry unaltered," never an endorsement.
- Arkova does **NOT** assert that the noncredit program itself confers any credit, credential, or formal outcome — that determination belongs entirely to the issuing institution and the registry record's own content.

`ctdl-claims-guard.ts`'s `assertNoProhibitedClaimInJsonLd` mechanically enforces the first two points at the code level (fail-closed: a prohibited phrase anywhere in the assembled response blocks the anchor, not just the render).

## 6. Honest limits

- **No dedicated noncredit `credential_type`.** Arkova's `anchors.credential_type` is a fixed Postgres enum (`DEGREE` / `LICENSE` / `CERTIFICATE` / … / `OTHER`) with no noncredit-program value. Adding one is a schema change (migration + `database.types.ts` regen + Confluence Data Model update) — explicitly out of scope for this POC. Anchors created by this route use `credential_type: 'OTHER'`; all noncredit-specific provenance lives in the unconstrained `anchors.metadata` jsonb column instead.
- **No live noncredit CTID exists yet to demo against.** Per §2, the POC's fixture is template-shaped, not a fetched live record. The path is proven against real credential-class records (SCRUM-2913 real fixtures) and against the noncredit template shape; it has not yet been proven against a real, CE-published noncredit record because none exists as of this research pass.
- **Anchors the FIRST admitted node only.** A `/graph/<ctid>` envelope can carry multiple admitted nodes (e.g. a `LearningProgram` plus a nested `Course`); this POC anchors the first one encountered in document order. A future iteration might anchor every admitted node, or let the caller pick.
- **No CI/isolated soak specific to a real noncredit CTID** — the 72h T2 soak this PR rides exercises the code path generically (synthetic + the template fixture), not a live CE fetch, because none exists to fetch yet.
- **Not yet reviewed by Credential Engine / Jeanne Kitchens.** This is an internal POC. Per `memory/feedback_no_premature_partner_outreach.md`, no partner-facing communication about this POC has been sent; a CE conversation is a founder-timed decision, not something this PR triggers.
- **No bulk / Search-API path.** This POC is single-CTID. A Search-API-driven bulk noncredit-anchoring path (searching the registry for NDT-3.0-tagged records at scale) is explicitly queued post-launch per the ratified sprint plan (R12).

## 7. Where the code lives

| Concern | File |
|---|---|
| Noncredit class enumeration + filter fix | `services/worker/src/ctdl/ctdl-importer.ts` |
| Noncredit parser tests (the "before/after" proof) | `services/worker/src/ctdl/ctdl-importer.noncredit.test.ts` |
| Template-shaped noncredit fixture | `services/worker/src/ctdl/__fixtures__/ce-template-noncredit-learning-program.json` |
| Shared fetch primitives (reused, not duplicated) | `services/worker/src/api/v1/credentials-ctdl-import.ts` |
| Registry-anchor route | `services/worker/src/api/v1/credentials-ctdl-registry-anchor.ts` |
| Registry-anchor route tests | `services/worker/src/api/v1/credentials-ctdl-registry-anchor.test.ts` |
| UI entry point | `src/components/credentials/CtdlRegistryImportDialog.tsx` |
| UI wiring | `src/pages/MyCredentialsPage.tsx` |
| UI copy | `src/lib/copy.ts` (`CE_REGISTRY_IMPORT_LABELS`, `MY_CREDENTIALS_LABELS.ADD_FROM_REGISTRY`) |
| E2E | `e2e/ctdl-registry-import.spec.ts` |
