# ARKOVA — Claude Code Engineering Directive

> **Version:** 2026-04-16 | **Repo:** ArkovaCarson | **Deploy:** app.arkova.ai (arkova-26.vercel.app)
> **Stats:** 214 migrations | 4,127 tests (1,235 frontend + 2,892 worker) | 334 stories (280 complete + 54 remaining) | 24/24 audit + 9 pentest findings resolved | AI: **Gemini 2.5 Flash (prod extraction, v5-reasoning tuned `endpoints/8811908947217743872`, single deployed Vertex endpoint)** — v6/v7 tuned and eval'd but did NOT cut over (v7 failed DoD 2026-04-16 PM, v7.1 surgical retrain planned); Nessie v27.0 FCRA LoRA deployed RunPod `u2ojptb1i9awwt` (NOT in prod routing) | 1.41M+ public records | 1.41M+ SECURED anchors (mainnet)
> **✅ NESSIE v27.0 FCRA DEPLOYED (2026-04-16):** Pipeline proved end-to-end. Together ft-56fd901e-669e → RunPod merge pod (A40, PEFT 0.15 + autocast=False, stripped 9 incompatible adapter_config keys) → HF `carsonarkova/nessie-v27-fcra` (16.1GB merged) → RunPod endpoint `u2ojptb1i9awwt` (workersStandby=2, p50 5.6s). **v27.0 eval (8 FCRA entries):** Citation 0% (eval-framework bug — all models show 0%), Faithfulness 25% (vs v26 31%), Relevance 35% (**+21pp vs v26**), Risk Recall 6.7%, Confidence r 0.672, Latency 5.56s (**3× faster than v26**). 2/7 DoD targets met — ship as baseline, train v27.1 immediately.
> **✅ ELITE DATASET ARCHITECTURE (2026-04-16):** `services/worker/scripts/intelligence-dataset/` — anchored sources registry, hand-crafted scenarios, category-balanced leakage-free splitter, full validation (every citation.record_id must exist; non-empty risks/recs; confidence 0.55-0.99; near-duplicate detection). **Total: 343 scenarios + 209 anchored sources across 3 regulations.** FCRA v27.1 (208 scenarios, 89 sources, 169/39 split, 11 categories), HIPAA v28.0 (73 scenarios, 74 sources, 61/12 split, 5 categories), FERPA v29.0 (62 scenarios, 46 sources, 52/10 split, 10 categories). All compile clean (0 errors).
> **✅ NESSIE v27.1 DEPLOYED + EVAL'D (2026-04-16):** Together ft-e9bbf91c-9cfa → RunPod merge (A40, PEFT 0.15) → HF `carsonarkova/nessie-v27-1-fcra` → RunPod endpoint `mpdzo2pso0bkua` (nessie-v27-1-fcra-prod). **Eval gains driven ONLY by dataset quality** (same hyperparameters as v27.0): Faithfulness 25→37.5% (+12.5pp), Relevance 35→44% (+9pp), **Risk Recall 6.7→25% (+18.3pp)**, Confidence r 0.672→0.806 (+0.134), Citation 0%→12.5% (after citation-fix rerun), Latency 13s (cold-start skew; warm 6-16s). 3-4/7 DoD targets. See `services/worker/docs/eval/eval-intelligence-v27-1-vs-v27-0-2026-04-16.md`.
> **✅ NESSIE v28.0 HIPAA DEPLOYED + EVAL'D (2026-04-16):** Together ft-784c62b2-4b9e → `carsonarkova/nessie-v28-0-hipaa` → RunPod endpoint `7d1mr5m9y6nnyx` on dedicated HIPAA template `84mf78oder` (parallel to v27.1 FCRA endpoint, scale-to-zero). **Eval: Citation 56.3% (4.5× better than v27.1 FCRA's 12.5%)**, Faithfulness 43.8%, Relevance 27.5%, Risk Recall 0%, Confidence r 0.736, Latency 22s (entry 1 cold-start 96s skews). Key finding: HIPAA statute-based IDs (`hipaa-164-524-access` mirrors `45 CFR 164.524`) match model output naturally; FCRA mixed-format IDs (`fcra-604b3` vs common `§604(b)(3)`) don't. Canonical ID convention is the #1 dataset design lesson.
> **🐛 CITATION-ACCURACY EVAL FIX (2026-04-16):** `scoreCitationAccuracy` in `src/ai/eval/intelligence-eval.ts` now accepts `|`-alternative slots and matches on record_id OR source-label substring. All 8 FCRA eval entries + 8 new HIPAA eval entries now use canonical IDs from the dataset architecture. Pre-fix: all models scored 0% due to eval/training ID mismatch. Post-fix: v27.1 12.5%, v28 56.3% — reveals real model citation behavior.
> **✅ NESSIE v27.2 FCRA DEPLOYED + 50-ENTRY EVAL (2026-04-16):** Canonical-ID rewrite hypothesis **VALIDATED**. Together ft-eaf0fab8-e5f6 → RunPod endpoint `hk06uvrt2ehk8y` (nessie-v27-2-fcra-prod, replaced v27.1). Only change from v27.1: canonical ID naming (`fcra-604b3→fcra-604-b-3`, `syed-m-i-2017→syed-2017`, `safeco-burr-2007→safeco-2007`, `fcra-rights-summary→cfpb-summary-of-rights`). **50-entry FCRA eval:** Citation Accuracy **43.0%** (vs v27.1 12.5% on same training data — **+30.5pp from ID rewrite alone, 3.4× gain**). Faithfulness 45%, Relevance 31.9%, Risk Recall 11%, Confidence r 0.457, Latency 13.1s warm. v28 HIPAA 50-entry rebaseline: Citation 60%, Faith 49%, Latency 13.7s. Statistical baselines now stable. Canonical-ID convention: statute-mirror (`fcra-604-b-3`), case name-year only (`safeco-2007`), agency-type-year-num (`cfpb-bulletin-2012-09`). See `services/worker/docs/eval/eval-intelligence-v27-2-statistical-baseline-2026-04-16.md`.
> **✅ 150-ENTRY EVAL EXPANSION (2026-04-16):** `FCRA_EVAL_50`, `HIPAA_EVAL_50`, `FERPA_EVAL_50` in `scripts/intelligence-dataset/evals/*.ts`. Each 50 entries, hand-crafted, covers all training categories with pipe-alternative canonical IDs. Eval flags: `--dataset fcra50|hipaa50|ferpa50`. Replaces the unstable 8-entry evals.
> **✅ NESSIE v27.3 FCRA + v29.0 FERPA DEPLOYED (2026-04-16):** Three regulations now parallel-serving. FCRA v27.3 endpoint `ikkto3e36xllms` (277 scenarios, +33% over v27.2, replaced v27.2 endpoint), HIPAA v28.0 endpoint `7d1mr5m9y6nnyx`, FERPA v29.0 endpoint `mwcomiw9avfqom` on dedicated template `fip31f9p7u`. **v27.3 50-entry FCRA eval: Citation 57.0% (vs v27.2 43.0%, +14pp from dataset expansion alone)**, Faith 47%, Risk 20%, Relev 32%, Conf r 0.428, Latency 13.3s. **v29.0 50-entry FERPA eval baseline: Citation 27%, Faith 43%, Conf r 0.564 (best of 3).** Full-day arc: FCRA Citation 0%→57% across v27.0→v27.3 (6 deployments). Two independent levers validated: canonical-ID convention (+30.5pp at v27.2) + scenario expansion (+14pp at v27.3). See `services/worker/docs/eval/eval-intelligence-full-day-summary-2026-04-16.md`.
> **✅ CONSTRAINED DECODING PROVEN (2026-04-16):** vLLM `response_format: {type: "json_schema"}` with 89-ID FCRA whitelist enum WORKS on RunPod serverless. 10-entry proof on v27.2: Citation 50%, **Faithfulness 60% (+15pp vs unconstrained)**, Risk 26.7% (+10.7pp), Latency 23s (+10s cost). Test script: `scripts/eval-constrained.ts`. Ready to productize via per-regulation schema at inference. Trade-off: +15pp faith/reliability vs +10s latency per query.
> **✅ IMPROVED EVAL SCORING (2026-04-16):** `scoreRiskDetection` + `scoreAnswerRelevance` rewritten with content-token matching, stop-word filtering, n-gram overlap, prose-fallback (answer text checked if `risks` array phrasing differs). Cold-start retry added to eval runner (eliminates 0ms timeouts). Re-eval v27.2 showed Risk +5pp, Relevance +2pp under-scored. True model performance revealed.
> **✅ FCRA v27.4 READY (302 SCENARIOS, +45% OVER v27.2):** Next-iteration dataset compiled clean (0 errors). Adds 25 multi-regulation cross-reference scenarios (FCRA × HIPAA/ADA/GINA/SOX/GLBA/GDPR) + 13 state-variation expansion (NJ, MN, WA, CO, FL, GA, OH, OR, HI, CT, MA Level 1/2/3, multi-state remote). Training-ready at `training-output/nessie-v27.4-fcra-train.jsonl`.
> **✅ GEMINI GOLDEN v6 TRAINED + EVAL'D, CUTOVER PENDING CODE MERGE (2026-04-16):** Vertex tuningJob `240015537143283712` succeeded in 38.9 min → endpoint `740332515062972416`. 50-sample eval vs v5-reasoning: **Macro F1 73.8→77.1% (+3.3pp)**, **Weighted 80.1→83.6% (+3.5pp)**, **mean latency 11.4→3.38s (-70%)**, **tokens/req 35881→1741 (-95%)**, subType non-"other" 88%, description 100%, JSON parse 100%. 5/7 DoD met; the 2 misses are aspirational <2s p50 / <3s p95 (v6 landed at 3.24s/4.93s — still 3.5× faster than prod). Top per-type: DEGREE/ATTESTATION/PATENT 100% F1; weakest IDENTITY/REGULATION/TRANSCRIPT/RESUME (sparse golden coverage). Required at inference: `GEMINI_V6_PROMPT=true` env var + `services/worker/src/ai/prompts/extraction-v6.ts` (must match training systemInstruction verbatim) + `description` added to `ExtractedFieldsSchema`/`BASE_FIELDS`. **Cutover is NOT env-var-only — needs the code changes first** (see SCRUM-772 comment for the 10-file list and the exact `gcloud run services update` command). Confidence r regressed 0.396→0.117; calibration layer retrain queued as follow-up (not base-model retrain). Artifacts: `services/worker/docs/eval/eval-gemini-golden-v6-2026-04-16.md`.
> **❌ GEMINI GOLDEN v7 EVAL'D — FAILED DoD (2026-04-16 PM):** Vertex tuningJob `5456125087591694336` succeeded (47m 39s) → endpoint `1315385892482842624` → smoke PASS. **249-entry stratified eval FAILS 11 of 16 DoD gates.** Macro F1 80.5% (target 82%, v6 baseline 79.3%). Only **16/23 canonical types ≥75% F1** (target 23/23, v6 had 19/23 — v7 REGRESSED). **FINANCIAL −21.2pp (70.6→49.4)**, **BUSINESS_ENTITY −18.8pp (81.7→62.9)** due to `goodStandingStatus: boolean` schema mismatch triggering Zod failure → 3 retries → empty extraction. fraudSignals 7.4% (target 50%, 50-entry seed too small to teach main extractor). RESUME didn't move (53.1→53.3% despite 30 new training entries). Latency regressed: p95 4.93→8.34s (+69%), p50 3.24→3.77s (+16%). subType emission 88→73%. Token usage 1,741→1,991 (+14% cost). Bright spots: ACCREDITATION +21pp (confirming relabel hypothesis), PUBLICATION +8pp, REGULATION +6pp, calibrated confidence gap 24pp→2.9pp. **Verdict: DO NOT cut over. Prod stays at v5-reasoning.** v7 endpoint undeployed + shell deleted post-eval. v7.1 plan in `services/worker/docs/eval/eval-gemini-golden-v7-vs-v6-2026-04-16.md`: fix goodStandingStatus schema (code, not retrain), drop regressing phase-18 FINANCIAL/BUSINESS_ENTITY entries, split fraud out of main training, enforce subType quality bar. Cost <$40, ~1 day.
> **🧹 VERTEX ENDPOINT STATE (2026-04-16 PM, post-v7 cleanup):** **1 deployed endpoint:** v5-reasoning prod (`8811908947217743872`, current prod extraction). Undeployed + deleted in this session (9 → 1): v7 final + 5 intermediate checkpoints + v6 shell + fraud-v1 shell. HARD RULE codified in Section 0 — Vertex endpoint hygiene: audit before + after every run, target 1–2 deployed, never keep speculative rollback endpoints warm (model artifact preserves redeploy path).
> **🛑 NVI GATE ACTIVE (2026-04-16 PM):** `SCRUM-804 NVI` (Nessie Verification Infrastructure) is now the **highest-priority epic**. FCRA/HIPAA/FERPA training data has not been verified against authoritative primary sources — statute quotes, case cites, and agency-bulletin references in the 209-source registry were hand-written from working knowledge and may contain fabricated citations. Until NVI passes the FCRA verification + attorney-reviewed benchmark gate: (1) **Do NOT expand HIPAA or FERPA datasets**, (2) **Do NOT start new regulation training (SOX, GDPR, state-specific, etc.)**, (3) v28 HIPAA + v29 FERPA are **quarantined** (still serving but under review), (4) NDD (SCRUM-770) / NSS (SCRUM-771) / NTF (SCRUM-769) epics are **PAUSED**. Gemini Golden work (GME2 v6/v7, GME3/4/5) is **NOT affected** — those are separate tracks.
> **📋 API RICHNESS TIER ADDED (2026-04-16):** Audit found that `/verify/{publicId}`, `/ai/extract`, `/attestations/{publicId}` return ~15 fields while the DB stores 30+ per anchor (plus `extraction_manifests` including `zk_proof`, `audit_events` lifecycle, `confidence_scores`, `compliance_controls`, `parent_anchor_id`, `chain_confirmations`). New tier `API-RICH-01..05` in `docs/BACKLOG.md` ships quick-win backwards-compatible nullable fields. Zero model risk — converts already-stored data to response.

Read this file before every task. Rules here override all other documents.

**Reference docs** (read on demand, not every session):
- `docs/reference/FILE_MAP.md` — Full file placement map
- `docs/reference/BRAND.md` — "Precision Engine" design system (colors, typography, CSS classes, component rules, migration guide)
- `docs/reference/TESTING.md` — Test patterns, demo users, frozen API schema
- `docs/reference/STORY_ARCHIVE.md` — Completed story details (P1-P8, DH, UF, P4.5, UAT)

---

## 0. MANDATORY METHODOLOGY

> **These five mandates override everything below. No exceptions.**

### ARCHITECT MANDATE
Use `sequential-thinking` MCP tool to brainstorm and validate architecture before writing any code.

### TDD MANDATE
Red-Green-Refactor. No production code without a corresponding test written first.

### SECURITY MANDATE
Manually check for PII leakage, command injection, and vulnerable dependencies before finalizing any file. Scan for hardcoded secrets, SQL injection, XSS, path traversal. Verify RLS covers new tables/columns.

### TOOLING MANDATE
Use Playwright MCP to verify frontend UI changes. Navigate, snapshot, confirm no regressions.

### UAT MANDATE
Every UI task must conclude with UAT: dev server at desktop (1280px) and mobile (375px), screenshots confirm changes, regressions checked, bugs logged in `docs/bugs/`.

### BACKLOG MANDATE
Single source of truth: `docs/BACKLOG.md`. Every backlog item must exist there + have story docs in `docs/stories/`.

### JIRA MANDATE
Every task MUST update its Jira ticket. Required fields: Definition of Ready (DoR), Definition of Done (DoD), Confluence doc links, status transitions. No task is complete until Jira reflects reality.

### CONFLUENCE MANDATE
Every task that changes schema, security, API, flows, or architecture MUST update the corresponding Confluence doc (see Doc Update Matrix in Section 4). This is not optional — it is part of Definition of Done.

### BUG LOG MANDATE
Every bug created or fixed MUST be logged in the master bug tracker spreadsheet: https://docs.google.com/spreadsheets/d/1mOReOXL7cmBNDD77TKVKF3LsdQ3mEcmDbgs5q_pTEk4/edit?gid=0#gid=0
No exceptions. Bug found? Log it. Bug fixed? Update the row. This is the single source of truth for bugs.

### CLAUDE.MD MANDATE
CLAUDE.md must stay accurate and organized. If a task introduces new rules, patterns, env vars, migrations, or changes story status — update CLAUDE.md. Don't just append; consolidate and clean up stale content. The header stats (migrations, tests, stories) must reflect reality. Every edit should leave this file leaner and more useful.

### NVI GATE MANDATE (2026-04-16)
**Scope:** Applies only to the Nessie compliance-intelligence track (FCRA/HIPAA/FERPA and future regulations). Does NOT apply to Gemini Golden (GME2/3/4/5) or any non-Nessie work.
- **Do NOT** expand HIPAA/FERPA or any regulation dataset until FCRA passes NVI verification + attorney-reviewed gold-standard benchmark (SCRUM-804).
- **Do NOT** start new regulation training (SOX, GDPR, state-specific, Kenya DPA Deep, etc.) until FCRA NVI passes.
- **NDD / NSS / NTF epics are PAUSED.** If asked to pick up a story from SCRUM-769/770/771 children, decline with a pointer to NVI status.
- v28 HIPAA + v29 FERPA **continue serving** (not un-deployed) but are considered under review until NVI gate passes — surface a caveat in customer-facing compliance UI.

### API RICHNESS MANDATE
Every new response field must be a **backwards-compatible nullable addition**. Never remove a field without a v2+ API path and 12-month deprecation (per Constitution 1.8). Prefer surfacing already-stored data (compliance_controls, confidence_scores, audit_events, zk_proof) over inventing new inference. The OpenAPI spec and TS/Python SDKs must update in the **same PR** as any response-schema change.

### VERTEX ENDPOINT HYGIENE MANDATE (HARD RULE — 2026-04-16)
**Audit Vertex endpoints BEFORE and AFTER every tuning/eval/deploy run.** Hitting the wallet is not abstract — idle replicas bill per hour, and a single tuning job can create 6+ checkpoint endpoints that silently cost hundreds of dollars a month. No exceptions.

**Before a run** (tuning, eval, smoke, cutover):
```bash
gcloud ai endpoints list --region=us-central1 --project=arkova1 \
  --format="table(name.basename(),displayName,deployedModels.model.list())"
```
Confirm the target endpoint is what you expect AND no orphan endpoints exist. If any show up that you cannot justify right now, undeploy/delete them first.

**After a run** (especially after any Vertex SFT tuning job succeeds — Vertex auto-creates one endpoint per checkpoint):
1. Keep ONLY the final-step endpoint (highest step number) + current prod + immediate rollback.
2. Undeploy every intermediate checkpoint endpoint in the same session, in parallel:
   ```bash
   gcloud ai endpoints undeploy-model <endpoint> --deployed-model-id=<deployed-model-id> \
     --region=us-central1 --project=arkova1
   ```
3. Delete empty endpoint shells once undeployed (shells don't bill but count against quota):
   ```bash
   gcloud ai endpoints delete <endpoint> --region=us-central1 --project=arkova1 --quiet
   ```
4. Document the census in the post-run summary: `N deployed → M deployed, kept [list], undeployed [list]`.

**Target: only deploy what's actively serving production OR the target of an eval/deploy currently in flight.** Nothing else. A "rollback target" endpoint sitting cold is NOT a reason to keep an endpoint deployed — the model artifact (`projects/.../models/NNN`) is preserved after undeploy, and you can redeploy to a fresh endpoint in ~10 min. **Do not pay to keep a cold spare warm.**

Expected steady state: **1–2 deployed endpoints.** Prod + (optionally) the next candidate you're about to cut over to. Three deployed is already unusual and needs a live justification.

**Never defer Vertex cleanup to "later."** Later is 2026-04-16, $XXX lost while the intermediate checkpoints idled. Cleanup is part of Definition of Done for any task that touches Vertex.

---

## 0.1. READ FIRST — EVERY SESSION

```
1. CLAUDE.md          <- You are here. Rules + Constitution (frozen).
2. docs/BACKLOG.md    <- Single source of truth for ALL open work.
3. HANDOFF.md         <- Current state, open blockers, decisions.
4. The relevant agents.md in any folder you are about to edit.
```

**Do NOT read** `docs/archive/MEMORY_deprecated.md` or `ARCHIVE_memory.md` — these are historical only.
If a folder contains an `agents.md`, read it before touching anything.

---

## 1. THE CONSTITUTION — RULES THAT CANNOT BE BROKEN

### 1.1 Tech Stack (Locked)

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | React 18 + TypeScript + Tailwind CSS + shadcn/ui + Lucide React | Vite bundler |
| Database | Supabase (Postgres + Auth) | RLS mandatory on all tables |
| Validation | Zod | All write paths validated before DB call |
| Routing | react-router-dom v6 | Named routes in `src/lib/routes.ts` |
| Worker | Node.js + Express in `services/worker/` | Webhooks, anchoring jobs, cron |
| Payments | Stripe (SDK + webhooks) | Worker-only, never browser |
| Chain | bitcoinjs-lib + AWS KMS (target) | MockChainClient for tests |
| Testing | Vitest + Playwright + RLS test helpers | `npm test`, `npm run test:coverage`, `npm run test:e2e` |
| Formal Verification | TLA PreCheck (TLA+ model checking) | `machines/bitcoinAnchor.machine.ts` — anchor lifecycle proven correct |
| Ingress | Cloudflare Tunnel (`cloudflared`) | Zero Trust, no public ports |
| Edge Compute | Cloudflare Workers + `wrangler` | Peripheral only (Queues, R2, AI fallback). NOT core worker logic. |
| Observability | Sentry | PII scrubbing mandatory |
| AI | Gemini (primary), `@cloudflare/ai` (fallback), `replicate` (QA only) | See 1.6 for processing boundary |

**Hard constraints:**
- Never use Next.js API routes for long-running jobs
- New AI libraries require explicit architecture review
- No server-side document processing (see 1.6)
- `@cloudflare/ai` is fallback-only, gated by `ENABLE_AI_FALLBACK` (default: `false`)
- `replicate` is QA-only, hard-blocked in production
- Sentry: no user emails, document fingerprints, or API keys in events

### 1.2 Schema-First (Non-Negotiable)

- Define DB schema + RLS **before** building UI that depends on it
- Once a table exists, **never use mock data or useState arrays** — query Supabase
- Schema changes require: migration + rollback comment + regenerated `database.types.ts` + seed update + Confluence page update
- Never modify an existing migration — write a compensating migration

### 1.3 Terminology (UI Copy Only)

**Banned in user-visible strings:** `Wallet` `Gas` `Hash` `Block` `Transaction` `Crypto` `Blockchain` `Bitcoin` `Testnet` `Mainnet` `UTXO` `Broadcast`

| Banned | Use Instead |
|--------|-------------|
| Wallet | Fee Account / Billing Account |
| Transaction | Network Receipt / Anchor Receipt |
| Hash | Fingerprint |
| Testnet / Mainnet | Test Environment / Production Network |

All UI copy in `src/lib/copy.ts`. CI enforced: `npm run lint:copy`. Internal code may use technical names.

### 1.4 Security (Mandatory)

- RLS + `FORCE ROW LEVEL SECURITY` on all tables
- SECURITY DEFINER functions must include `SET search_path = public`
- Never expose `supabase.auth.admin` or service role key to browser
- Never hardcode secrets anywhere. Treasury keys: server-side only, never logged.
- Stripe webhooks must call `stripe.webhooks.constructEvent()`
- API keys: HMAC-SHA256 with `API_KEY_HMAC_SECRET`. Raw keys never persisted after creation.
- `anchor.status = 'SECURED'` is worker-only via service_role

### 1.5 Timestamps & Evidence

- Server timestamps: Postgres `timestamptz`, UTC
- Bitcoin timestamps displayed as "Network Observed Time"
- Proof packages state: what is measured, asserted, and NOT asserted
- Jurisdiction tags are informational metadata only

### 1.6 Client-Side Processing Boundary

**Documents never leave the user's device.** Foundational privacy guarantee.

- `generateFingerprint` runs in browser only — never import in `services/worker/`
- Client-side OCR (PDF.js + Tesseract.js) extracts text on device
- Client-side PII stripping removes all PII before anything leaves browser
- Only PII-stripped structured metadata + fingerprint may flow to server
- Gated by `ENABLE_AI_EXTRACTION` flag (default: `false`). No "raw mode" bypass.

### 1.7 Testing

- RLS tests: `src/tests/rls/helpers.ts` `withUser()` / `withAuth()`
- Tests must not call real Stripe or Bitcoin APIs — use mock interfaces
- Every task keeps repo green: `typecheck`, `lint`, `test`, `lint:copy`
- Coverage: `@vitest/coverage-v8`, 80% thresholds on critical paths
- E2E: `e2e/` with Playwright, shared fixtures from `e2e/fixtures/`, isolated specs
- New user-facing flows require E2E spec before COMPLETE

### 1.8 API Versioning

- Verification API schema frozen once published. No breaking changes without v2+ prefix + 12-month deprecation.
- Additive nullable fields allowed without versioning.

### 1.9 Feature Flags

- `ENABLE_VERIFICATION_API` controls `/api/v1/*`. `ENABLE_PROD_NETWORK_ANCHORING` gates Bitcoin calls.
- `/api/health` always available.

### 1.10 Rate Limiting

Anonymous: 100 req/min/IP. API key: 1,000 req/min. Batch: 10 req/min. Headers on every response. 429 + `Retry-After`.

---

## 2. HOW TO RECEIVE A TASK

**Format A — Story ID:** Read story card, check Section 8 status, verify dependencies, state plan before coding.
**Format B — Direct instruction:** Map to closest story ID, proceed as Format A.
**Format C — Brand/UI task:** Read `docs/reference/BRAND.md` first.

---

## 3. TASK EXECUTION RULES

### Before writing code
- [ ] Read story card + story doc in `docs/stories/`
- [ ] Confirm dependencies met
- [ ] Read `agents.md` in folders you will touch
- [ ] State your plan
- [ ] **TESTS FIRST** — Write failing test(s) for the change BEFORE any production code (TDD MANDATE)

### While writing code
- [ ] One story at a time
- [ ] New tables: migration + rollback + RLS + `database.types.ts` + seed
- [ ] New components: `src/components/<domain>/` with barrel export
- [ ] Validators in `src/lib/validators.ts`. UI strings in `src/lib/copy.ts`.
- [ ] **Tests pass** — Green before moving on. No skipping, no `test.skip`, no "will add later"

### After writing code
```bash
npx tsc --noEmit && npm run lint && npm run test:coverage && npm run lint:copy
npm run gen:types    # if schema changed
npm run test:e2e     # if user-facing flow changed
```

### MANDATORY COMPLETION GATES (every single task, no exceptions)

**GATE 1 — Tests (TDD MANDATE)**
- [ ] Tests written FIRST, saw them fail, then made them pass
- [ ] `typecheck` + `lint` + `test` + `lint:copy` all green
- [ ] Coverage thresholds met on changed files

**GATE 2 — Jira (JIRA MANDATE)**
- [ ] Jira ticket updated: status, DoR checklist, DoD checklist
- [ ] Confluence doc links attached to ticket
- [ ] Acceptance criteria checked off in ticket

**GATE 3 — Confluence (CONFLUENCE MANDATE)**
- [ ] All changed areas have corresponding Confluence docs updated (see Doc Update Matrix)
- [ ] Story docs in `docs/stories/` updated

**GATE 4 — Bug Log (BUG LOG MANDATE)**
- [ ] Any bugs found during this task: logged in [Bug Tracker Spreadsheet](https://docs.google.com/spreadsheets/d/1mOReOXL7cmBNDD77TKVKF3LsdQ3mEcmDbgs5q_pTEk4/edit?gid=0#gid=0)
- [ ] Any bugs fixed during this task: row updated with resolution + regression test reference
- [ ] Production blockers also noted in CLAUDE.md Section 8

**GATE 5 — agents.md**
- [ ] `agents.md` updated in every modified folder

**GATE 6 — CLAUDE.md (CLAUDE.MD MANDATE)**
- [ ] If the task introduced new rules, patterns, conventions, tools, env vars, migrations, or story status changes: update CLAUDE.md
- [ ] Keep CLAUDE.md organized — consolidate, remove stale info, don't just append. Every edit should leave the file cleaner than you found it.
- [ ] Migration count, test count, story stats in the header must reflect reality after schema/test/story changes

> **A task is NOT complete until all 6 gates are passed.** Announce gate status at end of every task.

---

## 4. DOCUMENTATION & MIGRATION PROCEDURES

### Doc Update Matrix

| What Changed | Update |
|-------------|--------|
| Schema | `docs/confluence/02_data_model.md` |
| RLS | `docs/confluence/03_security_rls.md` |
| Audit events | `docs/confluence/04_audit_events.md` |
| Bitcoin/chain | `docs/confluence/06_on_chain_policy.md` |
| Billing | `docs/confluence/08_payments_entitlements.md` |
| Webhooks | `docs/confluence/09_webhooks.md` |
| Verification API | `docs/confluence/12_identity_access.md` |
| Feature flags | `docs/confluence/13_switchboard.md` |
| Anchor lifecycle | `machines/bitcoinAnchor.machine.ts` (re-verify with `check`) |
| Story status | `docs/stories/` (group doc) + `00_stories_index.md` |

### Migration Procedure

```bash
# 1. Create: supabase/migrations/NNNN_descriptive_name.sql (with -- ROLLBACK: at bottom)
# 2. Apply: npx supabase db push
# 3. Types: npx supabase gen types typescript --local > src/types/database.types.ts
# 4. Seed:  Edit supabase/seed.sql
# 5. Test:  npx supabase db reset
# 6. Docs:  Update docs/confluence/02_data_model.md
```

**Never modify an existing migration.** Write a compensating migration.

**Current:** 211 files (0001-0211, 0033+0078 skipped, 0068 split into 0068a/0068b, 0088 split into 0088/0088b, 0147 skipped numbering gap, 0174-0180 have intentional duplicate numbers from parallel branches). Migrations 0190-0193: RLS caching, BRIN indexes, pg_stat_statements, job queue (PERF sprint). Migrations 0194-0196: NCE compliance engine (jurisdiction_rules, compliance_scores, feature flags). **Migrations 0197-0211: REG compliance** (FERPA disclosure log, HIPAA MFA/audit, directory opt-out, emergency access, privacy notices, data subject rights). All migrations applied to production through 0185; 0186-0211 pending deploy.

**IMPORTANT — Post-db-reset step:** After `supabase db reset`, migration 0068a's `ALTER TYPE anchor_status ADD VALUE 'SUBMITTED'` silently fails inside the transaction. You must manually run:
```bash
docker exec -i $(docker ps --filter "name=supabase_db" -q | head -1) psql -U postgres -c "ALTER TYPE anchor_status ADD VALUE IF NOT EXISTS 'SUBMITTED';"
docker exec -i $(docker ps --filter "name=supabase_db" -q | head -1) psql -U postgres -c "NOTIFY pgrst, 'reload schema';"
```

---

## 5. STORY STATUS — INCOMPLETE WORK ONLY

> For completed story details, see `docs/reference/STORY_ARCHIVE.md`.

| Priority | Complete | Partial | Not Started | % Done |
|----------|----------|---------|-------------|--------|
| P1-P6, P4-E1/E2 | 32/32 | 0 | 0 | 100% |
| P7 Go-Live | 11/13 | 0 | 2 | 85% |
| P4.5 Verification API | 13/13 | 0 | 0 | 100% |
| DH Deferred Hardening | 12/12 | 0 | 0 | 100% |
| MVP Launch Gaps | 25/27 | 0 | 2 | 93% |
| P8 AI Intelligence | 19/19 | 0 | 0 | 100% |
| AI Infrastructure (S12) | 6/6 | 0 | 0 | 100% |
| UX Overhaul (S9-10) | 7/7 | 0 | 0 | 100% |
| Phase 1.5 Foundation | 15/16 | 1 | 0 | 94% |
| INFRA Edge & Ingress | 7/8 | 1 | 0 | 88% |
| UAT + UF | 27/27 | 0 | 0 | 100% |
| GEO & SEO | 12/17 | 2 | 3 | 71% |
| Beta (BETA-01–13) | 13/13 | 0 | 0 | 100% |
| ATS & Background Checks | 8/8 | 0 | 0 | 100% |
| NCE Compliance Engine (Jira) | 20/20 | 0 | 0 | 100% (Jira) — now gated by NVI |
| Nessie Model Training | 14/14 | 0 | 0 | 100% |
| ~~Gemini Migration (GME)~~ | ~~20/20~~ | — | — | **SUPERSEDED** by GME2/3/4/5 |
| **Integration Surface (INT)** | **8/9** | **0** | **1** | **89% — INT-09 webhook CRUD open** |
| Dependency Hardening | 4/23 | 0 | 19 | 17% |
| International Compliance | 0/28 | 2 | 26 | 7% |
| **NVI (Nessie Verification Infrastructure)** ★ NEW, HIGHEST | **0/12** | **0** | **12** | **0% — gates NDD/NSS/NTF** |
| **GME2 (Gemini Golden v6/v7)** ★ ACTIVE (SCRUM-772) | **2/5** | **0** | **3** | **40% — v6 + v7 trained & eval'd, both FAILED DoD, v7.1 surgical retrain planned** |
| **GME3/4/5 (Gemini Domain Experts)** ★ NEW | **0/3** | **0** | **3** | **0% — gated on v7 + GME8** |
| **NCA (Nessie Compliance Audit)** ★ ACTIVE | **0/10** | **0** | **10** | **0% — product-facing, not model-gated** |
| **API Richness (API-RICH)** ★ NEW | **0/5** | **0** | **5** | **0% — zero model risk, quick wins** |
| **NDD / NSS / NTF (paused by NVI)** | 0/29 | 0 | 29 | 0% — **PAUSED** |
| **TRUST (SOC 2 Type II / ISO / cyber)** ★ NEW | 0/7 | 0 | 7 | 0% — external-vendor-gated |
| **INTL (SE Asia / LatAm regulatory)** ★ NEW | 0/6 | 0 | 6 | 0% — customer-gated |
| **Total** | **~280/370+** | **4** | **~90+** | **~76%** |

### 🚨 NESSIE STRATEGY RESET — 2026-04-15 (READ FIRST)

> **The "v5 87.2% F1 / 75.7% macro F1" headline numbers cannot be trusted.** They were measured against a Together-hosted model that is now confirmed **non-serverless** (returns `400 model_not_available` without a paid dedicated endpoint). The "v2 baseline 0% F1 / 272s latency" numbers from `eval-nessie-v2-baseline-2026-04-15.md` were measured against a `RUNPOD_ENDPOINT_ID` that no longer exists. **All extraction in production has been base `gemini-2.0-flash` since launch — no fine-tuned model is deployed anywhere.**
>
> **What changed today (2026-04-15):**
> 1. ✅ Created RunPod endpoint `mmw8uthnsqzbbt` (nessie-v2-prod) pointing at `carsonarkova/nessie-v2-llama-3.1-8b` (HuggingFace, fully uploaded)
> 2. ✅ Submitted **Nessie DEGREE-only LoRA** to Together: `ft-dc07b30c-8203` (157 hand-validated training examples, 39 held-out test, 3 epochs, LoRA r=16)
> 3. ✅ Submitted **Gemini fraud v1** to Vertex AI: `tuningJobs/6279500967121518592` (18 hand-crafted fraud examples from FTC actions, GAO reports, Oregon ODA, gemini-2.5-pro, 5 epochs)
> 4. ✅ Wrote separated training-parameter docs (Nessie ≠ Gemini): `docs/plans/nessie-training-parameters-v1.md`, `docs/plans/gemini-training-parameters-v1.md`, `docs/plans/training-infra-runbook-2026-04-15.md`
> 5. ✅ Dropped 8 dead Supabase indexes (~37MB freed) via migration 0214
> 6. ✅ Freed 51GB local /tmp model artifacts
>
> **The new rule:** Nessie does narrow extraction (one credential type per LoRA, mastered before next), Gemini does fraud + reasoning. Each model trained on its own platform with locked parameters. No more 12-domain generalist sprawl. No more training without an end-to-end deploy proof. See `docs/plans/nessie-strategy-reset-2026-04-15.md` for full diagnosis + plan.

### ⚠ Nessie Production Hardening — original assessment (now superseded by Strategy Reset above)

> **Jira says NMT and NCE are "Done." The eval data says otherwise.** Nessie has scaffolding and initial training complete, but is NOT production/enterprise-ready. The following gaps are measured from actual eval runs and codebase inspection, not estimates.
> ⚠️ **Note:** the per-type F1 numbers below were measured against a non-serverless Together model and may overstate or understate true performance. Re-baseline against the new RunPod v2 endpoint before treating these numbers as authoritative.

**Model Quality Gaps (training needed):**

| Gap | Evidence | What's Needed |
|-----|----------|---------------|
| **fraudSignals: 0% F1** | All eval runs (v4, v5, DPO) show 0% extraction | Hundreds of fraud-labeled training examples + dedicated fraud detection fine-tuning |
| **Macro F1: 75.7%** | v5 eval on 100 samples (2026-03-31) | Target ≥85% macro F1 — requires more training on weak types |
| **Confidence correlation: 0.539** | v5 eval | Target ≥0.7 — model doesn't know when it's wrong |
| **BADGE: 67.6% F1** | v5 per-type breakdown | More BADGE training examples (only 8 in eval set) |
| **OTHER: 54.8% F1** | v5 per-type breakdown | "OTHER" is a catch-all — needs better disambiguation training |
| **MILITARY: 76.0% F1** | v5 per-type breakdown | Only 3 eval samples — unreliable metric, needs 50+ |
| **PUBLICATION: 75.0% F1** | v5 per-type breakdown | Only 3 eval samples — unreliable metric, needs 50+ |
| **v4 overconfidence: 29.7pp gap** | 90-100% confidence bucket = 65.8% actual accuracy | Confidence calibration needs retraining, not just post-hoc correction |

**Golden Dataset Coverage Gaps (data needed):**

| Credential Type | Golden Entries | Status |
|----------------|---------------|--------|
| MEDICAL | 1 | Statistically meaningless — need 50+ |
| IDENTITY | 1 | Statistically meaningless — need 50+ |
| RESUME | 2 | Unreliable — need 30+ |
| FINANCIAL | 2 | Unreliable — need 30+ |
| TRANSCRIPT | 2 | Unreliable — need 30+ |
| CLE | 2 | Unreliable — need 30+ |
| LEGAL | 3 | Unreliable — need 30+ |
| MILITARY | 3 | Unreliable — need 30+ |
| PUBLICATION | 3 | Unreliable — need 30+ |
| INSURANCE | 4 | Marginal — need 20+ |
| PATENT | 4 | Marginal — need 20+ |
| REGULATION | 4 | Marginal — need 20+ |
| CHARITY | ~0 | Phase 14 added some, but extraction rules missing |
| FINANCIAL_ADVISOR | ~0 | Extraction rules missing |
| BUSINESS_ENTITY | ~0 | Extraction rules missing |

**Infrastructure Gaps:**

| Gap | Status |
|-----|--------|
| Domain adapters: Professional | Placeholder model ID — NOT TRAINED |
| Domain adapters: Identity | Placeholder model ID — NOT TRAINED |
| Domain adapters: Legal, Regulatory | Trained but using DRY-RUN model IDs — NOT DEPLOYED to production |
| Domain adapters: SEC, Academic | Trained (45K examples each) — deployed status unclear |
| Embedding NDCG@10 benchmark | Framework exists, never executed — search quality unknown |
| Fraud audit | Framework exists (fraud-audit.ts), never run — false positive rate unknown |
| Cold start latency | Unmeasured — RunPod serverless, no benchmarks |
| No Gemini fallback for extraction | Intelligence queries fall back to Gemini; extraction does NOT |
| Production error rate monitoring | No metrics on extraction failures, circuit breaker trips |

**What "Production-Ready Nessie" Actually Requires:**
1. **~300+ hours of additional training** across expanded golden dataset, fraud signals, weak credential types
2. **Golden dataset expansion** from 1,905 → ~5,000+ entries with balanced type distribution
3. **Deploy trained domain adapters** (swap DRY-RUN IDs for real model IDs)
4. **Train Professional + Identity adapters** (currently placeholder)
5. **Build and run fraud signal training pipeline** (currently 0% F1)
6. **Run NDCG@10 embedding benchmark** and iterate on retrieval quality
7. **Confidence retraining** (not just post-hoc calibration) to get correlation >0.7
8. **Add extraction fallback to Gemini** (parity with intelligence query path)
9. **Production observability**: error rates, latency percentiles, circuit breaker dashboard
10. **Cold start mitigation**: RunPod warming strategy or minimum worker count

### Incomplete Stories

**~~Integration Surface (INT) — ALL 9 STORIES COMPLETE:~~**
> Jira Epic SCRUM-641 + all children (SCRUM-642–650) are Done. TypeScript SDK, MCP tools, embed.js, webhook CRUD, Python SDK, Zapier/Make, Clio, Bullhorn, screening embed — all shipped.

**P7 Go-Live (2 not started):**
- P7-TS-04, P7-TS-06: No individual scope defined

**MVP Launch Gaps (2 post-launch):**
- ~~MVP-12 (LOW): Dark mode toggle~~ — **DONE** (sidebar ThemeToggle)
- MVP-13 (LOW): Organization logo upload — post-launch
- MVP-14 (LOW): Embeddable verification widget — post-launch
> ~~MVP-20 (LinkedIn badge integration)~~ — Superseded by BETA-09
> ~~MVP-30 (MEDIUM): GCP CI/CD pipeline~~ — Post-launch

**Phase 1.5 Foundation (1 partial):**
- PH1-PAY-02: Self-hosted x402 facilitator — flag enabled, needs USDC address + facilitator deploy
- ~~PH1-SDK-02: Python SDK~~ — **COMPLETE** (sdks/python/arkova/client.py)

**AI Infrastructure (Session 12+ — Jira COMPLETE, quality gaps remain):**
- AI-EVAL-01: Golden dataset + scoring engine (1,905 entries across 14 phases) — **but 8 types have <5 entries**
- AI-EVAL-02: Live Gemini eval baseline (F1=82.1%, confidence r=0.426) — **Nessie v5: 87.2% weighted, 75.7% macro**
- AI-PROMPT-01: Prompt version tracking (migration 0092)
- AI-PROMPT-02: Few-shot expansion (11→130 examples, covering all 21 credential types + OCR)
- AI-FRAUD-01: Fraud audit CLI framework — **framework only, never actually run against production data**
- AI-OBS-01: Admin AI metrics dashboard (/admin/ai-metrics)

**INFRA (1 partial):**
- INFRA-07: Sentry integration — code complete (30 tests + vite plugin + init), needs SENTRY_AUTH_TOKEN + DSN env vars in Vercel/Cloud Run

**GEO & SEO (3 not started, 2 partial):**
- GEO-02: LinkedIn entity collision — PARTIAL (sameAs fixed, LinkedIn page + Wikidata = external tasks)
- GEO-09: Community & brand presence — NOT STARTED (external: ProductHunt, Reddit, G2, Crunchbase)
- GEO-10: IndexNow for Bing — NOT STARTED
- GEO-11: YouTube explainer content — NOT STARTED
- GEO-15: Image alt text — PARTIAL (full names done, product screenshots needed)
- See `docs/stories/15_geo_seo.md` for details

**~~ATS & Background Checks (8/8 COMPLETE):~~**
- All 8 stories implemented: employment/education verification forms, batch API, ATS webhooks, credential portfolios, evidence upload, OpenAPI docs, expiry alerts.
- See `docs/stories/18_ats_background_checks.md` for details

**~~Nessie Model Training (14/14 Jira COMPLETE — but see Nessie Production Hardening above):~~**
> NMT stories built the training pipeline, initial models, and eval framework. But eval results show Nessie is NOT production-ready: 75.7% macro F1, 0% fraud signal extraction, 0.539 confidence correlation, 2 placeholder domain adapters, 8 credential types with <5 golden entries. The pipeline works — the model needs hundreds more hours of training. See "Nessie Production Hardening" section above.

**Dependency Hardening (10 not started) — Release R-DEP-01:**
- DEP-01 (P0): Supabase Disaster Recovery Plan & Cold Standby
- DEP-02 (P0): Cloudflare Tunnel Failover Procedure
- DEP-03 (P0): Document Missing Security-Critical Dependencies
- DEP-04 (P1): Upgrade Express to v5
- DEP-05 (P1): Upgrade ESLint to v9 + Flat Config
- DEP-06 (P1): Pin Security-Critical Dependency Versions
- DEP-07 (P2): Email Delivery Monitoring
- DEP-08 (P2): Dependency Update Cadence & Policy
- DEP-09 (P2): SBOM Generation in CI
- DEP-10 (P2): License Audit — GPL Compatibility Review
- See `docs/stories/26_dependency_hardening.md` and `docs/BACKLOG.md` for details

**International Regulatory Compliance (2 partial, 26 not started) — Release R-REG-01:**
- REG-01–04 (FERPA): Disclosure log, directory info opt-out, DUA template, requester verification
- REG-05–10 (HIPAA): MFA enforcement, session timeout, audit report, BAA template, breach notification, emergency access
- REG-11–14 (Shared): Data subject rights workflow, SCC framework, breach procedures, privacy notices
- ~~REG-15 (Kenya): ODPC registration~~ — **DRAFT COMPLETE, COUNSEL ENGAGED** (2026-04-11; `docs/compliance/kenya/odpc-registration.md` + README + privacy notice; blocked only on DPO + fee payment + portal submission)
- ~~REG-16 (Kenya): DPIA~~ — **DRAFT COMPLETE** (v0.1 at `docs/compliance/kenya/dpia.md`, 10-risk register, awaiting DPO review)
- REG-17–19 (Australia): APP 8 assessment, NDB procedure, data correction
- REG-20–22 (South Africa): Information Regulator registration, POPIA Section 72, privacy notice
- REG-23–25 (Nigeria): NDPC registration, SCCs, privacy notice
- REG-26–28 (Dashboard): Compliance mapping update, international badges, DPO designation
- See `docs/stories/29_international_compliance.md` and `docs/BACKLOG.md` for details

### Remaining Production Blockers

| Task | Detail |
|------|--------|
| ~~AWS KMS signing~~ | ~~Key provisioning for mainnet~~ — **DONE** (AWS + GCP KMS providers complete, 69 tests, GCP KMS configured in Cloud Run) |
| ~~Mainnet treasury funding~~ | ~~Fund production treasury wallet~~ — **DONE** (treasury funded, 116 mainnet TXs confirmed) |
| ~~Flip to mainnet~~ | ~~Change to mainnet~~ — **DONE** (BITCOIN_NETWORK=mainnet, 166K+ SECURED anchors) |
| ~~Deploy migrations~~ | ~~Apply to production~~ — **DONE** (all migrations through 0157 applied) |

### Pre-Launch Tasks

| Task | Detail |
|------|--------|
| DNS + custom domain | `app.arkova.io` or equivalent |
| ~~Seed data strip~~ | ~~Remove demo users~~ — **DONE** (Session 6: OPS-02 executed) |
| ~~SOC 2 evidence~~ | ~~Begin collection~~ — **DONE** (`docs/compliance/soc2-evidence.md` + branch protection CC6.1) |

**~~Gemini Migration (GME) — ALL 20 STORIES COMPLETE:~~**
> Jira Epic SCRUM-612 + all children (SCRUM-613–634) are Done. Migrated to Gemini 3 Flash, Golden v3 retrained (2,000+ entries), embedding model migrated, structured output, multimodal, batch optimization, latency benchmarking, model pinning — all shipped. See `docs/stories/28_gemini_migration_evolution.md`.

**Dependency Upgrades (13 new Jira tickets — SCRUM-684–696):**
> Added 2026-04-14 from closed dependabot PRs. 3 completed (jsdom 29, @types/node 25, @types/mime 4). 10 remaining include TypeScript 6, Stripe 22, Zod 4, Vitest 4, ESLint 10, Lucide 1.x, node-cron 4, React 19, grouped bumps.

### Do NOT Start
- MVP-13/14 (post-launch polish)
- OpenTimestamps (decision made: direct OP_RETURN only)

---

## 6. COMMON MISTAKES

| Mistake | Do This Instead |
|---------|-----------------|
| `useState` for Supabase table data | `useXxx()` hook querying Supabase |
| `supabase.insert()` without Zod validation | Call validator first |
| SECURITY DEFINER without `SET search_path = public` | Always add it |
| Text directly in JSX | `src/lib/copy.ts` |
| Schema change without `gen:types` | Regenerate types |
| Real Stripe/Bitcoin calls in tests | Mock interfaces |
| `anchor.status = 'SECURED'` from client | Worker-only via service_role |
| Exposing `user_id`/`org_id`/`anchors.id` publicly | Only `public_id` + derived fields |
| `generateFingerprint` in worker | Client-side only |
| `jurisdiction: null` in API response | Omit when null (frozen schema) |
| Changing anchor lifecycle without updating TLA+ model | Edit `machines/bitcoinAnchor.machine.ts` first, run `check` |
| Raw API key in DB | HMAC-SHA256 hash |
| `current_setting('request.jwt.claim.role', true)` in DB functions | Use `get_caller_role()` helper — supports both PostgREST v11 and v12+ JWT claim formats |
| Function overloads differing only by DEFAULT params | PostgREST v12 can't disambiguate — use single function with DEFAULT |
| Deploying DB function changes without `NOTIFY pgrst, 'reload schema'` | Always reload PostgREST schema cache after function DDL changes |

---

## 7. ENVIRONMENT VARIABLES

Never commit. Load from `.env` (gitignored). Worker fails loudly if required vars missing.

```bash
# Supabase (browser)
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=

# Supabase (worker only)
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_JWT_SECRET=                # optional — local JWT verification (eliminates auth network call)
SUPABASE_POOLER_URL=                # optional — PgBouncer connection pooler URL

# Stripe (worker only)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Bitcoin (worker only)
BITCOIN_TREASURY_WIF=               # never logged (Constitution 1.4)
BITCOIN_NETWORK=                    # "signet" | "testnet4" | "testnet" | "mainnet" (currently mainnet)
BITCOIN_RPC_URL=                    # optional
BITCOIN_RPC_AUTH=                   # optional
BITCOIN_UTXO_PROVIDER=mempool      # "rpc" | "mempool" | "getblock"
MEMPOOL_API_URL=                    # optional — mempool.space API URL override
BITCOIN_FEE_STRATEGY=              # optional — "static" | "mempool"
BITCOIN_STATIC_FEE_RATE=           # optional — sat/vB when strategy is "static"
BITCOIN_FALLBACK_FEE_RATE=         # optional — fallback sat/vB
BITCOIN_MAX_FEE_RATE=              # optional — max sat/vB, anchor queued if exceeded (PERF-7)
FORCE_DYNAMIC_FEE_ESTIMATION=      # optional — force dynamic fees on signet/testnet (INEFF-5)

# KMS signing (worker only)
KMS_PROVIDER=                       # "aws" | "gcp" — required for mainnet
BITCOIN_KMS_KEY_ID=                 # AWS KMS key ID
BITCOIN_KMS_REGION=                 # AWS region for KMS key
GCP_KMS_KEY_RESOURCE_NAME=          # GCP KMS key resource path
GCP_KMS_PROJECT_ID=                 # optional — defaults to application default

# Worker
WORKER_PORT=3001
NODE_ENV=development
LOG_LEVEL=info
FRONTEND_URL=http://localhost:5173  # REQUIRED in production (SCRUM-534 / PR #347) — worker fails loudly if NODE_ENV=production and FRONTEND_URL is unset. No localhost fallback.
USE_MOCKS=false
ENABLE_PROD_NETWORK_ANCHORING=false
BATCH_ANCHOR_INTERVAL_MINUTES=10    # batch processing interval
BATCH_ANCHOR_MAX_SIZE=100           # max anchors per batch TX (max: 10000)
MAX_FEE_THRESHOLD_SAT_PER_VBYTE=   # optional — batch anchor fee ceiling
ANCHOR_CONFIDENCE_THRESHOLD=0.4     # confidence threshold for anchor decisions

# Verification API (worker only)
ENABLE_VERIFICATION_API=false
API_KEY_HMAC_SECRET=
CORS_ALLOWED_ORIGINS=*

# Cron auth
CRON_SECRET=                        # min 16 chars
CRON_OIDC_AUDIENCE=

# Cloudflare (edge workers)
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_TUNNEL_TOKEN=            # never logged (INFRA-01, ADR-002)

# x402 payments (worker only)
X402_FACILITATOR_URL=               # x402 facilitator URL (PH1-PAY-01)
ARKOVA_USDC_ADDRESS=                # USDC receiving address on Base
X402_NETWORK=eip155:84532           # Base Sepolia default
BASE_RPC_URL=                       # Base network RPC for payment verification

# Email (worker only)
RESEND_API_KEY=                     # Resend transactional email (BETA-03)
EMAIL_FROM=noreply@arkova.ai        # verified sender address

# Public record fetchers (worker only)
EDGAR_USER_AGENT=                   # required by SEC for EDGAR API
COURTLISTENER_API_TOKEN=            # CourtListener legal records API
OPENSTATES_API_KEY=                 # OpenStates legislative data API
SAM_GOV_API_KEY=                    # SAM.gov federal contractor records

# Redis rate limiting (optional)
UPSTASH_REDIS_REST_URL=             # Upstash Redis REST URL
UPSTASH_REDIS_REST_TOKEN=           # Upstash Redis REST token

# Sentry
VITE_SENTRY_DSN=
SENTRY_DSN=
SENTRY_SAMPLE_RATE=0.1

# AI
ENABLE_AI_FALLBACK=false
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3-flash          # migrated from 2.5-flash (GME complete)
GEMINI_EMBEDDING_MODEL=gemini-embedding-001  # text-embedding-004 does NOT exist; gemini-embedding-2-preview is available but preview-only
AI_PROVIDER=mock                    # gemini | nessie | together | cloudflare | replicate | mock
GEMINI_TUNED_MODEL=                 # optional — fine-tuned Gemini model path (e.g. projects/arkova1/locations/us-central1/endpoints/740332515062972416 for v6)
GEMINI_V6_PROMPT=false              # GME2-03 — when true, use prompts/extraction-v6.ts system+user prompts (required for v6 tuned endpoint). Also activates v6 isotonic calibration knots in calibration.ts. See docs/runbooks/v6-cutover.md.
GEMINI_TUNED_RESPONSE_SCHEMA=false  # optional — when true, attach responseSchema on tuned Gemini 2.0/2.5-flash calls. Default off: base Gemini 3 over-generates optional fields with responseSchema; keep this flag off unless evaluating tuned-only endpoints.
REPLICATE_API_TOKEN=                # QA only
AI_BATCH_CONCURRENCY=3              # concurrent AI extraction requests (min: 1)
CF_AI_MODEL=                        # Cloudflare AI model (default: @cf/nvidia/nemotron)

# Together.ai (fallback LLM provider)
TOGETHER_API_KEY=
TOGETHER_MODEL=                     # default: meta-llama/Llama-3.1-8B-Instruct
TOGETHER_EMBEDDING_MODEL=           # Together.ai embedding model

# Nessie (RunPod vLLM — pipeline extraction)
RUNPOD_API_KEY=
RUNPOD_ENDPOINT_ID=                 # e.g., hmayoqhxvy5k5y
NESSIE_MODEL=nessie-v2              # Nessie extraction model on RunPod vLLM (legacy)
NESSIE_INTELLIGENCE_MODEL=          # Nessie intelligence model (compliance analysis, recommendations)
NESSIE_DOMAIN_ROUTING=false         # enable domain-based Nessie routing
ENABLE_SYNTHETIC_DATA=false
TRAINING_DATA_OUTPUT_PATH=          # optional — JSONL export path for training data
```

---

_Directive version: 2026-04-14 | 211 migrations | 4,127 tests | ~280/334 stories complete | GME: 20/20 DONE | NCE: 20/20 DONE | INT: 9/9 DONE | NMT: 14/14 DONE (pipeline built, model needs training) | Golden dataset: 1,905 entries (need ~5,000+) | Nessie v5: 87.2% weighted F1, 75.7% macro F1, 0% fraudSignals, 0.539 confidence correlation | Gemini 3 Flash migrated | Major remaining: Nessie production hardening, DEP (19 not started), REG (26 not started)_
_Reference docs: `docs/reference/` (FILE_MAP, BRAND, TESTING, STORY_ARCHIVE)_
