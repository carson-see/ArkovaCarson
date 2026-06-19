# Lane 3 — Partnership / Integration Current-State Audit (S0-E2 + S0-E7)

**Sprint 0 · Tier T0 · READ-ONLY.** Every Jira key verified individually with `getJiraIssue` (no bulk JQL — known-unreliable here). Prod/runtime claims quoted from the 2026-06-16 CE meeting-prep doc + HANDOFF, flagged **ASSERTED** where not independently re-curled. Date: 2026-06-19.

> **Prompt-mapping corrections (important — the kickoff brief had these wrong):**
> - **SCRUM-1010 is NOT the HakiChain epic.** It is **CIBA — Compliance Intelligence & Efficient Batch Anchoring** (In Progress); HAKI-REQ-01..05 live under it. The live HakiChain launch surface is **SCRUM-1703 [API/MCP-LAUNCH]**.
> - **CPE/CLE epics are NOT 1962/1963** (those are eval-gate *stories*: 1962 CPE-eval **Done**, 1963 CLE-eval **Needs Human**). Real epics: **SCRUM-1845 [R-CPE-01]** + **SCRUM-1865 [R-LEGAL-01-CLE]**, both In Progress.

## (a) Credential Engine / CTDL
**Verified status:** real, active, *executed* partnership — but **consuming-only eval, NOT a Registry listing.** CTDL serialization is **live in prod** (`GET /api/v1/credentials/:id/ctdl` → PII-safe JSON-LD; SCRUM-1875 **Done**; `services/worker/src/ctdl/`). "No fake CTID" fix merged + live (PR #1178). did:web issuer identity live (SCRUM-1922 Done). **NOT live:** real Registry CTID storage/emission (SCRUM-1926 **To Do** — no `registry_ctid` column in prod), consuming course-ID→CTID smoke (SCRUM-1921 **To Do**, no PR), OpenID Federation (SCRUM-1923 To Do), Registry *publishing* (sandbox-gated, out of MVP). Temp API keys in Secret Manager but **never exercised** as of 6/16.

**Live clocks / obligations:**
- **FATAL (R-1): CE trial keys + complimentary services auto-expire ~2026-09-09** (3-mo "Complimentary Evaluation & API Trial Agreement," executed 6/9/2026; signed PDF in Drive). After the cliff → paid Developer Agreement + support tier. Eval terms: **consuming-only against the production Registry**, CE staff time capped at 4h.
- Contacts: **Jeanne Kitchens, CTSO (jkitchens@credentialengine.org)** — relationship owner, holds keys/agreement. **Jeff Grann** — technical/CTDL counterpart (next sync after July 4). Rachel Vilsack (COO), Scott Cheney (CEO, hands-off), Jenny Parks (origin champion). Confirmed via live Gmail threads.
- Real Arkova org CTID issued by CE: **`ce-cd077a1e-7691-4519-b653-d46d1245687f`** (6/9) — lives in the CE Registry, **NOT stored in prod DB**.
- Overdue Arkova action: dev-questions list owed to Jeff Grann.

**Jira/Confluence (per-key verified):** Epic **SCRUM-1867** In Progress (`wiki/x/AYDmAw`); **1875** Done · **1926** To Do · **1921** To Do · **1923** To Do · 2295 (credit-hours→CTDL, soaking under #1154) · 2296 (W3C VC spike) · 1961 (course_id privacy review).
**Code:** `services/worker/src/ctdl/{ctdl-serializer,ctdl-validation,ctdl-type-map}.ts`. Honest by construction: `REAL_CTID_PATTERN = /^ce-[hex]/`; `ceterms:ctid` emitted **only** on a canonical-format match; no publish path exists.

**Claims-review flags (§1.5):**
- ✅ No "listed in the CE Registry" claim in prod copy. NB: the frontend `IssuerRegistryPage`/`get_public_issuer_registry` are **Arkova's own** registry, NOT the CE Registry — keep distinct externally.
- ⚠️ "**Approved to publish to the Credential Registry**" (CE email 6/9) must **not** be paraphrased as "publishing live" / "credentials in the Registry." Approval grants the *roles* (Quality Assurance Org + Competency Framework Org) + consuming methods (Graph Search API + offline download); Arkova keeps publishing **sandbox-gated**. Live publication = NOT-yet-true.
- ⚠️ **Credential-level CTIDs = NOT-yet-true** (live CTDL emits zero `ceterms:ctid` today, deliberate).
- ⚠️ **Stale Jira:** SCRUM-2472 reportedly still says Arkova "emits fake CTIDs" — fixed by #1178, now inaccurate.
- ⚠️ **W3C VC / OB3:** direction is **W3C VC 2.0** (verbal steer); written trail says "VC and/or OB3." Arkova issues **no signed VC today** (emit-CTDL + did:web + anchored proof only). Don't claim VC issuance.

## (b) CPE / CLE Professional Education
**Verified status:** **in active development, NOT GA.** AI metadata-extraction + provider-validation + compliance-export. Real code: `services/worker/src/compliance/professional-education.ts` (26 KB — NASBA 19 fields-of-study, CPE delivery methods, CLE formats, 51 jurisdictions, `CpeMetadataSchema`/`CleMetadataSchema`, `ethics_hours` first-class, `requires_manual_review` hard boolean). Public-anchor CPE/CLE metadata shipped (PR #1031, migration 0331). Provider-registry tables in `database.types.ts`.

**Clocks/obligations:** no external partner clock (no third-party key expiry). Drivers: **Credu** (Udemy CPE use case; Udemy = confirmed NASBA sponsor) for CPE; US law practices + HakiChain for CLE. Constraint: **NASBA has no public API** → provider registry is a manually maintained internal table (quarterly refresh) → "NASBA-validated" = internal-table lookup, not a live call.

**Jira/Confluence (per-key verified):** **CPE epic SCRUM-1845 [R-CPE-01]** In Progress (`wiki/x/AYAaAw`); children 1846/1847/1848/1849; eval gate **1962 Done** (CPE F1≥0.80 met). **CLE epic SCRUM-1865 [R-LEGAL-01-CLE]** In Progress (`wiki/x/CYAgAw`); children 1868/1869/1870; eval gate **1963 Needs Human** (ethics_hours F1≥0.80 not cleared → CLE adapter 1880 not merged).
**Code:** `compliance/professional-education.ts`; `ai/prompts/{cpe,cle}-extraction-prompt.ts`; provider-registry tables in `database.types.ts`.

**Claims-review flags:** ⚠️ **"CLE GA" = NOT-true** (epic In Progress; eval gate 1963 Needs Human; adapter not merged). ⚠️ **CPE partially shipped, not complete** (extraction eval passed + public-anchor metadata live, but epic 1845 + export/dashboard children In Progress — "CPE suite live" overstates). ⚠️ **"NASBA-validated"** → state as internal-registry lookup with `nasba_status ∈ {confirmed,not_found,unknown}`; no live NASBA API.

## (c) HakiChain
**Verified status:** **LIVE pilot, real partner, consuming prod.** One of the **5 orgs** with anchored records in prod (live CTDL sample: org "HakiChain", `did:web:app.arkova.ai:orgs:ky6c3yhs9qwc`, subjectWebpage hakichain.com). HAKI-REQ set built + largely shipped: sub-org/credit allocation (**SCRUM-1170 / HAKI-REQ-01 Done**), bulk/retroactive anchoring (HAKI-REQ-02), webhook replay (HAKI-REQ-03), evidence package (HAKI-REQ-04). Outbound webhook emitter implement (**SCRUM-1736 Done**); per the canonical brief **`anchor.secured` + `anchor.revoked` are live in prod**. Open: `anchor.expired` **end-to-end verification** (SCRUM-1737, Needs Human) — producer cron implemented; partner told to poll `/verify` meanwhile.

**Clocks/obligations:**
- **R-8: HakiChain is live in prod from Kenya** on the v1 webhook + API — losing it loses the Kenya reference. Kenya team confirmed in live Gmail. Primary use case = **CLE tracking** (regulatory crossover, per Jeff Grann 6/16).
- Pilot allocation (canonical brief): **10 anchors + 5 secure-document credits** for the beta window — *planning guidance, not contractual.*
- **Q1 external gates:** **Google CASA** (OAuth/connector) + **Kenya/EAC data-protection counsel** (Kenya DPA 2019 + EAC cross-border). Neither asserted complete anywhere.

**Jira/Confluence (per-key verified):** launch epic **SCRUM-1703 [API/MCP-LAUNCH]** In Progress; story **SCRUM-1729** (outbound webhook emitter) In Progress; **1736 Done** · **1737 Needs Human** · 1735 (spec); CIBA epic **SCRUM-1010** parents HAKI-REQ-01..05. Confluence: **"Arkova Beta API and MCP Integration Brief — HakiChain"** (page **42532874**, canonical, updated 2026-05-07) + spec 42958849; SCRUM-1495 (UAT), 1491 (sign-off).
**Code:** `webhooks/delivery.ts` (signed HMAC + SSRF guard), `api/v1/webhooks.ts` (replay), `api/v1/anchor-bulk.ts` (HAKI-REQ-02), `api/v1/anchor-evidence.ts` (HAKI-REQ-04), `api/v1/orgSubOrgs.*` (HAKI-REQ-01), `api/v2/rateLimit.test.ts`, `config.ts:105`.

**Claims-review flags:** ✅ the canonical brief is commendably honest (marks `anchor.expired` as "verify under SCRUM-1737", tells partner to poll `/verify`). ⚠️ **Parent 1729/1703 still "In Progress"** despite 1736 Done + secured/revoked live → close-out/DoD lag, not a capability gap; **don't infer "webhooks not shipped" from epic status** — reconcile. ⚠️ **`anchor.expired` end-to-end = ASSERTED-not-verified** (1737 Needs Human) — don't claim full lifecycle-webhook parity until 1737 closes. ⚠️ the 10-anchor/5-credit allocation is beta guidance, not contractual.

## External-gate tracker (S0-E7)
| Gate | Owner | Target | Status | Kickoff action |
|---|---|---|---|---|
| **CE trial API key (R-1, FATAL)** | Carson (PO); Jeanne Kitchens holds keys | **~2026-09-09** | **AT RISK** — keys in Secret Manager but **never exercised**; consuming smoke (1921) To Do, no PR; paid-agreement decision pending | Run course-ID→CTID consuming smoke vs the live Registry (gate behind §1.6 course_id review SCRUM-1961); give Jeff a smoke-test date; decide paid Developer Agreement tier before Sept 9 |
| **Google CASA** | Carson / security | Q1 (no committed date) | **NOT STARTED / unverified** (no "CASA approved" claim exists — correct) | Scope CASA tier for the connector/OAuth surface; book assessor; assert nothing until an artifact exists |
| **Kenya / EAC counsel** | Carson / legal | Q1 (no committed date) | **NOT STARTED / unverified** — HakiChain already live from Kenya = standing exposure (R-8) | Engage counsel on Kenya DPA 2019 + EAC cross-border for live HakiChain traffic; capture a residual-risk note until cleared |

## Net
All three tracks are real + code-backed; none is as far along as an optimistic reading suggests. Most urgent: the **CE consuming smoke before the ~Sept-9 cliff (R-1)**. Most reusable asset: the genuinely honest claims posture already in the CTDL code + the HakiChain brief — **preserve it.**

**Primary sources:** Drive "Arkova × Credential Engine — Dev Status & Meeting Prep (2026-06-16) v2" (`1joAiDUGkEz3JcwnlSIhVNGRyNrx3KlKzRUvDQWzHcNA`); "Credential Engine — Technical Sync … June 16 2026" (`1JnmB4bPy0815i43xrebCqEyF0J2x3FqkjPZ-FIchvNE`); signed CE trial PDF (`1p2Ba_oNko4wWlT3RKCJbTWv6BEgIEhI8`); 6/9 CE approval email (Gmail `19eb16eb9378a212`); Confluence 42532874. Code as cited. No writes performed.
