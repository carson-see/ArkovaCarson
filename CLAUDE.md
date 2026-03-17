# ARKOVA — Claude Code Engineering Directive

> **Version:** 2026-03-17 | **Repo:** ArkovaCarson | **Deploy:** arkova-carson.vercel.app
> **Stats:** 67 migrations | 1,814 tests | 163 stories (151 complete, 93%) | 24/24 audit findings resolved

Read this file before every task. Rules here override all other documents.

**Reference docs** (read on demand, not every session):
- `docs/reference/FILE_MAP.md` — Full file placement map
- `docs/reference/BRAND.md` — Nordic Vault design system (colors, typography, CSS classes, component rules)
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

---

## 0.1. READ FIRST — EVERY SESSION

```
1. CLAUDE.md          <- You are here.
2. HANDOFF.md         <- Living state. Phase 3/4 tracking, blockers, decisions.
3. docs/BACKLOG.md    <- Single source of truth for all open work.
4. ARCHIVE_memory.md  <- Historical context from prior phases.
5. The relevant agents.md in any folder you are about to edit.
```

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

### While writing code
- [ ] One story at a time
- [ ] New tables: migration + rollback + RLS + `database.types.ts` + seed
- [ ] New components: `src/components/<domain>/` with barrel export
- [ ] Validators in `src/lib/validators.ts`. UI strings in `src/lib/copy.ts`.

### After writing code
```bash
npx tsc --noEmit && npm run lint && npm run test:coverage && npm run lint:copy
npm run gen:types    # if schema changed
npm run test:e2e     # if user-facing flow changed
```

Update `docs/confluence/` if schema/security/API changed. Update story docs + `agents.md` in modified folders.

### Definition of Done
- All acceptance criteria met, tests passing, `typecheck` + `lint` + `test` + `lint:copy` green
- UAT verified at desktop + mobile
- No regressions

### Bug Documentation
- **Production blockers** -> CLAUDE.md Section 8 Critical Blockers
- **All other bugs** -> MEMORY.md Bug Tracker
- Required: steps to reproduce, expected vs actual, root cause, actions taken, resolution, regression test

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
| Verification API | `docs/confluence/12_verification_api.md` |
| Feature flags | `docs/confluence/13_switchboard.md` |
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

**Current:** 67 files (0001-0067, 0033 skipped). Last: `0067_add_performance_indexes.sql`. 0001-0058 applied to production. 0059-0067 pending.

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
| INFRA Edge & Ingress | 7/8 | 1 | 0 | 88% |
| UAT + UF | 27/27 | 0 | 0 | 100% |
| GEO & SEO | 5/12 | 2 | 5 | 42% |
| **Total** | **151/163** | **3/163** | **9/163** | **~93%** |

### Incomplete Stories

**P7 Go-Live (2 not started):**
- P7-TS-04, P7-TS-06: No individual scope defined

**MVP Launch Gaps (5 not started):**
- MVP-12 (LOW): Dark mode toggle
- MVP-13 (LOW): Organization logo upload
- MVP-14 (LOW): Embeddable verification widget
- MVP-20 (LOW): LinkedIn badge integration
- MVP-30 (MEDIUM): GCP CI/CD pipeline

**INFRA (1 partial):**
- INFRA-07: Sentry integration -- code done (30 tests), missing source map upload plugin + DSN env vars in production

**GEO & SEO (5 not started, 2 partial):**
- See `docs/stories/15_geo_seo.md` and `docs/BACKLOG.md` for details

### Remaining Production Blockers

| Task | Detail |
|------|--------|
| AWS KMS signing | Key provisioning for mainnet. SignetChainClient done, mainnet needs KMS. |
| Mainnet treasury funding | Fund production treasury wallet. |

### Pre-Launch Tasks

| Task | Detail |
|------|--------|
| DNS + custom domain | `app.arkova.io` or equivalent |
| Seed data strip | Remove demo users |
| SOC 2 evidence | Begin collection (CI logs, RLS tests, audit events) |

### Do NOT Start
- MVP-12/13/14 (post-launch polish)
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
| Raw API key in DB | HMAC-SHA256 hash |

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

# Stripe (worker only)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Bitcoin (worker only)
BITCOIN_TREASURY_WIF=               # never logged (Constitution 1.4)
BITCOIN_NETWORK=                    # "testnet4" | "signet" | "testnet" | "mainnet"
BITCOIN_RPC_URL=                    # optional
BITCOIN_RPC_AUTH=                   # optional

# Worker
WORKER_PORT=3001
NODE_ENV=development
LOG_LEVEL=info
FRONTEND_URL=http://localhost:5173
USE_MOCKS=false
ENABLE_PROD_NETWORK_ANCHORING=false

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

# Sentry
VITE_SENTRY_DSN=
SENTRY_DSN=
SENTRY_SAMPLE_RATE=0.1

# AI
ENABLE_AI_FALLBACK=false
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.0-flash
GEMINI_EMBEDDING_MODEL=text-embedding-004
AI_PROVIDER=mock                    # gemini | cloudflare | replicate | mock
REPLICATE_API_TOKEN=                # QA only
ENABLE_SYNTHETIC_DATA=false
```

---

_Directive version: 2026-03-17 | 67 migrations | 1,814 tests | 163 stories (151 complete, 93%) | 24/24 audit findings resolved_
_Reference docs: `docs/reference/` (FILE_MAP, BRAND, TESTING, STORY_ARCHIVE)_
