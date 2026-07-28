# ARKOVA — RATIFIED FINAL 2-SPRINT PLAN (CTO, 2026-07-28)
_Council: L1/L2/L3 leads + RTE + RM, all plans received and reconciled. This document is the binding plan of record for the sprint. Builders read this + their item brief._

## CTO rulings (binding)
R1. Wave G (T0 gate fixes) merges ahead of everything via normal Mergify T0 path — "nothing soaks" ≠ "nothing merges"; T0 needs no soak per §1.12.
R2. #1717 (undici 8): CLOSED as deferred (real undici-8 API break in safe-fetch; post-launch follow-up ticket).
R3. #1654 Drive connector: FINISH (consumer QUEUE-06 already on main via #1366; SCRUM-2492 hardening already on main — Jira stale). One wiring PR (L3-B1).
R4. Ledger canon: `org_credits` is canonical for org-scoped money ops (0341 atomicity). User-scoped `credits` remains for individuals until post-launch consolidation. `unified_credits` deprecated as read-model — no NEW writes. A3 fail-closed fix still lands (live code). B8 ships reconciliation view across all three.
R5. Instant-Secure (L2-A2): build DARK, flag OFF, code-complete. Satisfies SCRUM-2894's "hidden until built". Flip is post-soak founder decision.
R6. SCRUM-2538 fail-closed + auto-provisioning trigger: ONE PR (L2-A3), pairing is the safety.
R7. A5 admin credit adjust targets org_credits now (consistent with R4).
R8. Member-level credit delegation: DEFERRED post-soak (Sprint C). Listed honestly in the founder report.
R9. Fraud metadata (SCRUM-2972): PURGE historical fraud_* values (batched migration, rollback notes) + rename signals going forward (L3-A7/B8). 
R10. DocuSign "auto-connect all members": reframed to correct per-member attribution (L3-B2) + low-friction member connect nudge; no fake org-level token reuse. ENABLE_ORG_CREDIT_ENFORCEMENT flip stays founder-gated post-soak.
R11. CTDL xTRA RFP: do-not-bid RATIFIED.
R12. CE POC: single-CTID Registry Snapshot Anchoring (L3-A6) is the sprint deliverable; Search-API bulk POC queued post-launch.
R13. Migration cap: named table below + spares only. RTE arbitration on collisions.
R14. Orphaned-export lint: fail-closed for exports NEWLY introduced in a PR; warn-only for pre-existing.
R15. SCRUM-3031: root-cause-driven — fix if confirmed in RPC, else diagnostics + defensive worker-side timeout/backoff.
R16. SCRUM-2486: verify-and-close (0357 trigger live). SCRUM-2603: verify-and-close (fixed 7ed0f687) after L2-A7 residual. SCRUM-2492/3028: verify-and-close. Housekeeping wave batches all Jira transitions at end (Atlassian MCP was flaky 07-27).
R17. 72h soak runs ENABLE_ORG_CREDIT_ENFORCEMENT=ON and ENABLE_OUTBOUND_WEBHOOKS=ON in the rig (deliberate, documented divergence from prod — launch-target evidence). Soak includes SCRUM-3031 regression check. RM's wave plan (G→M→D→F→S) + master manifest rc-2026-08-launch-72h.json ratified.
R18. PR ownership dedupe: #1615+#1652=L1; #1618+#1711=L3; SCRUM-2538+3010=L2; SCRUM-2238=L2 (B2); L1 HARDEN bundle = 2239/2240/2241 + 2242-verify.

## Migration assignments (RTE table, final)
| # | Item | Owner |
|---|---|---|
| 0361 | reserved SCRUM-2916 watermark index — #1615 builder claims it if the file is in-branch, else strikes the reservation row | L1 |
| 0367 | SCRUM-3010 step 2 org-records RLS role-gate | L2-B5 |
| 0368 | SCRUM-2971 billing_events idempotency | L2-A8 |
| 0369 | SCRUM-2600 credit-ledger reconciliation view | L2-B8 |
| 0370 | SCRUM-3031 batch_insert_anchors fix | L1 |
| 0371 | SCRUM-2538 fail-closed + auto-provision | L2-A3 |
| 0372 | SCRUM-2242 get_public_anchor leak (verify-first vs 0334; use only if needed) | L1 |
| 0373 | SCRUM-3013 search_public_issuers trigram+CTE | L2-B6 |
| 0374 | SCRUM-2972 fraud_* purge | L3-B8 |
| 0375–0378 | spares (HARDEN 2241 if schema-touching; CE POC source enum if CHECK-constrained) | RTE arbitrates |
Protocol: reservation-row commit FIRST (one row, one commit), re-fetch origin/main before claiming, RTE arbitrates races.

## Sprint A (today)
**Wave 0 — gate fixes + shepherding (launch first):**
- G1 (RTE): migration-drift.yml `types:[...,edited]` + stale-checks runbook (SCRUM-3029/3030) [T0/T1]
- G2 (RTE): staging-gate stale-checkout fix + mint-fresh-event helper (SCRUM-3026) [T1]
- G3 (RTE): orphaned-export lint per R14 (SCRUM-3032/3033/3034) [T1]
- S1 (L1): rebase #1615 design-preserving (0359/0360 + KPI-3 CLI; 0361 decision) [T3]
- S2 (L3): rebase #1618 + wire registry_url/ce_envelope_sha256 into ctdl-serializer [T3]
- S3 (L1): rebase #1652 [T3]
- S4 (L3): merge main into #1711, drift+E2E green [T1]
- CTO direct: close #1717 w/ comment + follow-up note.

**Wave 1 — Sprint A builds:**
- L1: SCRUM-3031 wedge fix (0370, R15) · materializer-EXECUTE runbook + read-only preflight script (2983/2984 prereqs) · SCRUM-3021 tip-height retry/fallback · SCRUM-2632 pooler path fix
- L2: A1 Queue UX Phase 1 (Add to Queue + queue page + buy-credits redirect) · A2 Instant-Secure dark (R5) · A3 0371 fail-closed+provision (R6) · A4 invite flow provision-on-accept (SCRUM-3012) · A5 admin credit adjust (R7) · A6 MCP manifest parity + CI check · A7 legacy verify-anchor limiter parity · A8 0368 billing idempotency
- L3: A5 Haki format-intake widening + soft-fail parity (SCRUM-2911) · A6 CE Registry Snapshot Anchoring POC (R12) · A7 fraud-signal relabel (labels only) · A8 terminology S2 close-out (8 baseline violations; merges before other copy.ts PRs)

## Sprint B (tomorrow)
- L1: HARDEN bundle 2239/2240/2241+2242-verify (R18) · SCRUM-3022 advisory-lock mutex · SCRUM-3017+3020 SUBMITTED-age monitoring bundle · SCRUM-3016 MEMPOOL_API_URL contract · SCRUM-2509 scoped circuit-breaker (no second provider) · SCRUM-2228 signed-bundle format behind PROOF_SIGNING_* (unsigned=not-asserted copy) · SDK/verifier MIT license + publish-prep polish
- L2: B1 digest recipients + 6pm EST scheduler note (America/New_York, ask founder EST-fixed vs local) · B2 SCRUM-2238 delivery_log hardening · B3 webhook enablement runbook + Developer tab · B4 sdks/mcp-server real bin+stdio bootstrap · B5 0367 org-records RLS (R4-consistent tests) · B6 0373 search fix · B7 health-exposure lockdown (SCRUM-2653) · B8 0369 ledger reconciliation view (R4)
- L3: B1 finish #1654 wiring (R3) · B2 DocuSign per-member attribution (cross-review w/ L2 money path) · B3 queue-vs-instant rule admin UI (code dark where credit-dependent) · B4 Gemini defaults fix (gemini-config.ts + GEMINI_DISTILLATION_MODEL env) · B5 Haki KPI-2 weekly reconciliation export · B6 (conditional) scanned-PDF OCR fallback + legacy .doc — first to drop · B7 CE claims/copy honesty pass (R-7) · B8 0374 fraud purge (R9)
- RTE: SCRUM-2980 72h-E2E runbook (T0 docs) · RM: draft rc-2026-08-launch-72h.json + covered_main_shas discipline note.

## Deliberately excluded (honest list for founder report)
Member credit delegation (R8) · full 3-ledger consolidation backfill · bulk Instant-Secure · multimodal audio · second chain-read provider · v7.1 retrain/A-B · SCRUM-2265/1981/3004 (fold-in if slack) · MCP registry submission (needs account) · xTRA RFP (R11). Founder-reserved gates: npm/PyPI, Resend DNS, SIGN-01, flag flips, drain D1, materializer prod EXECUTE scheduling, Haki invoice/counsel, CE demo CTID, mystery rig origin check.

## FOUNDER AMENDMENTS 2026-07-28 (mid-sprint, binding)
A1. **Bulk uploads are launch-critical, day 1.** Mixed-format batch anchoring (e.g. .csv + .pdf + Drive doc + .xml in ONE action) must work from ALL five surfaces: dashboard, REST API, SDKs, MCP, webhook/connectors. Spreadsheets must be anchorable AS DOCUMENTS (kill the bulk-metadata hijack) AND extractable at 100+ rows → anchors. Currently failing. Audit in flight; its work items enter Sprint A/B as P0, displacing lower-priority items if capacity demands (L3-B6 conditional and L2 slack items are first to move).
A2. **"Everything that should have a UI component needs one."** Plan-wide rule: any PR shipping a user-facing capability ships its UI in the same PR (or an explicitly paired PR landing the same sprint). No hook/endpoint counts as done without a reachable UI surface. Applies to: queue UX (A1/A2), admin credit adjust (A5), invite flow (A4), Developer tab (B3), folders (done via #1721), bulk uploads (A1 amendment), DocuSign rule UI (L3-B3), CE POC (needs at least a minimal trigger surface, not just an endpoint). Builders must state in the PR body where the UI entry point is. The G3 orphaned-export lint enforces the pattern mechanically.

A3. **All 22 LOI formats must work COMPLETELY (accept → hash → anchor → extract), not accept+soft-fail.** Founder ruling 2026-07-28: soft-fail-to-manual-entry does NOT meet the KPI bar. This supersedes the A5 "accept+soft-fail parity" scope and un-conditions B6. New L3 P0 format workstream (all client-side per §1.6, lazy-loaded parsers to protect bundle size):
- F1 Spreadsheet dual-mode (founder clarification 2026-07-28): row-mode (each row = a distinct user's credential — the ORIGINAL INTENT, keep it) remains for credential issuance and must work reliably at 100+ rows (extract → anchor per row); PLUS a new "anchor this file as one document" mode for non-credential spreadsheets (.xls/.xlsx/.ods/.csv via SheetJS extraction). Upload flow presents an explicit mode choice (or smart default with an override) — neither mode hijacks the other. UI copy must pass §1.3 (lint:copy).
- F2 Zip-XML family: .odt/.odp/.pptx/.epub text extraction (JSZip + XML walk).
- F3 Text family completion: RTF control-word stripper (kill the garbage output), SVG text extraction, verify .md/.html/.xml/.json/.txt with per-format tests.
- F4 Image family completion: TIFF decode (tiff.js→canvas→Tesseract), HEIC decode (wasm→canvas→OCR), scanned-PDF OCR fallback (pdf.js page render→Tesseract), verify png/jpg/gif/webp.
- F5 Legacy binary: .doc and .ppt (CFB container parsing) — highest technical risk of the sprint; if a browser-grade extractor proves unreachable in-window, escalate to CTO immediately with options (do NOT silently soft-fail).
- F6 KPI evidence: 22-format fixture corpus + automated matrix test (every format: upload→extract→anchor) — this artifact IS the KPI proof.
Displacement: F1-F6 are P0; L3's B7 (claims polish) and lower-priority L2 slack items yield capacity if needed. The 72h soak's edge-case pillar must include the 22-format matrix.

A4. **CE POC retargeted (founder correction 2026-07-28)** — supersedes R12's generic "registry snapshot" framing. The CE news the founder meant is the **Noncredit Data Taxonomy (NDT) 3.0 → CTDL mapping**, published 2026-07-16 (credentialengine.org/2026/07/16/mapping-the-noncredit-data-taxonomy-3-0-to-the-ctdl-...): CE released a **State Noncredit Data Taxonomy Benchmark Model** mapping Rutgers EERC's NDT 3.0 (90+ data elements across Purpose/Design, Student Outcomes, Enrollment/Demographics, Finance/Policy) to CTDL classes+properties. Partners: Rutgers EERC, UNC Charlotte, U Michigan, UC Irvine, 8 states (IA, LA, VA, MD, NJ, OR, SC, TN), funded by Strada. Guidance + publishing template at guidance.credentialengine.org/noncredit-data-taxonomy/. CE is actively asking states/institutions to START PUBLISHING noncredit records to the Credential Registry now.
**Why this is the better POC:** ~4.1M community-college students are in noncredit offerings — credentials with NO registrar, NO transcript, NO existing verification substrate. That is precisely the credential class that most needs tamper-evident proof, and it's being structured into CTDL *right now* with state + funder momentum. Arkova anchoring a noncredit CTDL record supplies the one thing noncredit inherently lacks: independent, durable evidence that the record existed as stated at a point in time.
**Revised POC scope (L3):** (1) read the NDT-3.0 benchmark model + publishing template from CE's guidance site, enumerate the actual CTDL classes/properties it uses; (2) verify our CTDL importer/parser handles noncredit-shaped records (the benchmark's classes may include ones our 20-class filter from #1603 doesn't cover — LearningProgram/LearningOpportunityProfile-family etc.; VERIFY, don't assume); (3) anchor a real noncredit registry record end-to-end via the §1.6A-compliant fetch→SHA-256→discard path; (4) UI surface per rule A2; (5) a short partner-facing writeup for Jeanne framing Arkova as the proof layer for the noncredit publishing push. Keep the earlier link-rot evidence (2 of 6 sampled CE records already 404) as supporting narrative.

## BULK AUDIT RESULTS (verified 2026-07-28) — corrections + work items
**Corrections to earlier claims:** There is NO MIME allowlist on the single-doc path (no accept attr, no extension gate, no size cap). 20 of 22 formats DO anchor today (some with soft-failed extraction, which never blocks anchoring). ONLY .csv/.xlsx/.xls are un-anchorable as documents (intercepted by isBulkUploadFile FileUpload.tsx:16-22 before hashing). The "22/22" claim was true for hashing only.
**KEY ASSET FOUND:** `POST /api/v1/anchor/bulk` (services/worker/src/api/v1/anchor-bulk.ts, router.ts:468) is COMPLETE + tested: ≤1000 pre-computed fingerprints, dry-run, dedup strategies, credit deduction, per-row errors. ZERO callers in src/. Third instance of the orphaned-feature pattern. Bulk is therefore WIRING, not backend work — no migrations needed for W1-W8.
**BUGS:** (1) mixed multi-file drop SILENTLY DISCARDS all files (BulkUploadWizard.tsx:97-99 finds no spreadsheet → null → empty prompt, no error). (2) row-mode auto-generates "fingerprints" by hashing ROW TEXT when no fingerprint column mapped (csvParser.ts:413-430, 541-559) — not document anchoring; INTEGRITY QUESTION ESCALATED TO FOUNDER (label distinctly vs block). (3) Python SDK has NO anchor() at all (read-only client). (4) sdks/mcp-server has NO anchor tool. (5) edge MCP anchor_document writes public_records, not org anchors — conflates two pipelines.
**GOOD NEWS:** 100+ row extraction already works (10,000-row cap, 10MB, batches of 10 via bulk_create_anchors).
**Work items W1-W9** (all L2 unless noted, NO migrations): W1 dashboard mixed-batch (DISPATCHED) · W2 spreadsheet mode selector (DISPATCHED) · W3 TS SDK anchorBulk (DISPATCHED) · W4 Python SDK anchor()+anchor_bulk (DISPATCHED) · W5 sdks/mcp-server anchor tools (needs hashing-responsibility design note) · W6 edge MCP array support + pipeline disambiguation (L3) · W7 DocuSign mixed-format envelope verify (L3) · W8 Drive batch-trigger UI+fan-out (L3) · W9 UI-reachability gate per PR (rule A2).

## R19 (CTO ruling 2026-07-28) — row-derived vs document-derived evidence classes
Row-mode's synthesized fingerprint (hash of row text when no fingerprint column is mapped, csvParser.ts:413-430/541-559) is NOT blocked and NOT removed — it is a real commitment to asserted record content and serves the credential-issuance path. It IS separated into a distinct evidence class, load-bearing at the DATA layer (DB column + API response + proof package + public verify page), never cosmetic UI copy alone:
- **Document-derived**: a real file's bytes were fingerprinted client-side (§1.6). Existing behavior.
- **Record-derived (issuer attestation)**: the issuer's asserted record content was fingerprinted; NO source document was supplied to Arkova. Proof/verify copy must state this affirmatively per §1.5 (measured vs asserted vs NOT asserted) and must not imply document custody or document verification.
Implementation: ride the EXISTING evidence-level / `proof_completeness_class` machinery (do not invent a parallel concept); this also discharges SCRUM-2481 (server-side evidence-level trust, open P0) for this surface. Row-import UI adds an issuer-attestation acknowledgement ("I am the issuing authority for these records"). Public verify page + /api/v1 responses must render the class distinctly. R-7 claims gate applies: no wording that implies we verified a document we never received.
Founder directive 2026-07-28: technical decisions are CTO's — stop routing them up.

## Review battery (per /loop directive)
Every PR when ready: /code-review + /debug pass + /simplify; tla-precheck for machine.ts touchers; /engineering:tech-debt sweep at sprint close. Findings → backlog (Jira batch at housekeeping wave).

## FOUNDER DIRECTIVES 2026-07-28 (second batch, BINDING)
D1. **Soak network = SIGNET.** All soaks (this 72h one and the post-pentest full-app soak) run on signet, not mainnet. Update the 72h runbook accordingly.
D2. **Two-soak structure.** This 72h soak covers all functionality merged in the last 45 days. It PRECEDES a separate ONE-WEEK soak of the ENTIRE application, which happens AFTER pen testing. Do not conflate them.
D3. **CE is a priority, time-boxed by the trial.** Everything for Credential Engine must be excellent so we get a full MONTH of robust testing against their API key before the trial expires (~2026-09-09). CE work is not "nice to have" this sprint.
D4. **LOI: all 22 formats must be verified against the ACTUAL LOI**, not a sample. Reader dispatched.
D5. **MCP/SDK must be MIT + one-click install.** Verify licenses genuinely (LICENSE files present, package.json consistent) and deliver a real one-click/`npx` install path for the MCP server. Counsel agent verifying licenses; install path is a build item.
D6. **Audit ALL endpoints.** Dispatched.
D7. **DB/schema/migrations must be working and accurate.** Full DBA audit dispatched.
D8. **Enable things in prod.** Sprint success = the 72h soak actually starting, with the workflows we began now closed out, their bugs/gaps fixed, features ENABLED in prod (flag flips), failures checked and everything verified. Flag flips remain founder-executed but I must surface the exact list, with rationale and rollback, rather than leaving them vague.
D9. **Legal questions go to general counsel**, not the founder. Counsel-role agent dispatched for the LGPL/licensing memo.
D10. Usage limits are tight — batch reporting, prioritize soak-start over breadth.
