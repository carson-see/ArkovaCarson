# ARKOVA — Claude Code Engineering Directive

> **Version:** 2026-04-09 | **Repo:** ArkovaCarson | **Deploy:** app.arkova.ai (arkova-26.vercel.app)
> **Stats:** 182 migrations | 3,898 tests (1,476 frontend + 2,422 worker) | 298 stories (201 complete + 49 NCE/GME + 38 DEP/REG planned, ~67%) | 24/24 audit + 9 pentest findings resolved | AI: Gemini Golden v2 (98% type accuracy) / Nessie Intelligence v2 (5 domains) / Nessie v5 (87.2% F1) | 1.41M+ public records | 1.41M+ SECURED anchors (mainnet)

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

**Current:** 182 files (0001-0180, 0033+0078 skipped, 0068 split into 0068a/0068b, 0088 split into 0088/0088b, 0147 skipped numbering gap, 0174-0179 renumbered from duplicates). All migrations applied to production through 0180. Migration 0180 also applied directly to production (PostgREST v12 JWT claim fix + batch anchor scaling indexes).

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
| Nessie Model Training | 5/6 | 0 | 1 | 83% |
| Dependency Hardening | 1/10 | 0 | 9 | 10% |
| International Compliance | 0/28 | 0 | 28 | 0% |
| **Total** | **203/254** | **2/254** | **49/254** | **~80%** |

### Incomplete Stories

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

**AI Infrastructure (Session 12+ — ALL COMPLETE):**
- AI-EVAL-01: Golden dataset + scoring engine (1,330 entries across 8 phases, 447 tests)
- AI-EVAL-02: Live Gemini eval baseline (F1=82.1%, confidence r=0.426)
- AI-PROMPT-01: Prompt version tracking (migration 0092)
- AI-PROMPT-02: Few-shot expansion (11→130 examples, covering all 21 credential types + OCR)
- AI-FRAUD-01: Fraud audit CLI framework
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

**Nessie Model Training (1 not started):**
- ~~NMT-01 (P0): Gemini Golden fine-tuned eval~~ — **DONE** (90.4% F1, deployed to Cloud Run)
- ~~NMT-02 (P1): JSON comment stripping~~ — **DONE** (stripJsonComments utility, 447 tests)
- ~~NMT-03 (P1): Nessie confidence recalibration~~ — **DONE** (piecewise linear calibration, 8 knots, PR #225)
- ~~NMT-04 (P1): Full-precision GPU eval~~ — **DONE** (v5: 87.2% F1, v4: 65.6% F1, fp16 ≈ 4-bit)
- NMT-05 (P2): Upload model weights to HuggingFace — not started
- ~~NMT-06 (P2): Nessie v5 training + condensed prompt~~ — **DONE** (v5 trained, 87.2% F1, condensed prompt deployed)
- See `docs/stories/21_nessie_model_training.md` and `docs/BACKLOG.md` for details

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

**International Regulatory Compliance (28 not started) — Release R-REG-01:**
- REG-01–04 (FERPA): Disclosure log, directory info opt-out, DUA template, requester verification
- REG-05–10 (HIPAA): MFA enforcement, session timeout, audit report, BAA template, breach notification, emergency access
- REG-11–14 (Shared): Data subject rights workflow, SCC framework, breach procedures, privacy notices
- REG-15–16 (Kenya): ODPC registration, DPIA
- REG-17–19 (Australia): APP 8 assessment, NDB procedure, data correction
- REG-20–22 (South Africa): Information Regulator registration, POPIA Section 72, privacy notice
- REG-23–25 (Nigeria): NDPC registration, SCCs, privacy notice
- REG-26–28 (Dashboard): Compliance mapping update, international badges, DPO designation
- See `docs/stories/27_international_compliance.md` and `docs/BACKLOG.md` for details

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
FRONTEND_URL=http://localhost:5173
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
GEMINI_MODEL=gemini-2.5-flash
GEMINI_EMBEDDING_MODEL=gemini-embedding-001
AI_PROVIDER=mock                    # gemini | nessie | together | cloudflare | replicate | mock
GEMINI_TUNED_MODEL=                 # optional — fine-tuned Gemini model path
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

_Directive version: 2026-04-09 | 182 migrations | 3,898 tests (1,476 frontend + 2,422 worker) | 298 stories (201 complete + 49 NCE/GME + 38 DEP/REG planned) | 24/24 audit + 9 pentest resolved | Golden dataset: 1,665 entries | Gemini Golden v2: 98% type accuracy | Nessie Intelligence v2: 5 domains_
_Reference docs: `docs/reference/` (FILE_MAP, BRAND, TESTING, STORY_ARCHIVE)_
