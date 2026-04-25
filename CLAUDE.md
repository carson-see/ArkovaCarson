# ARKOVA — Claude Code Engineering Directive

> **Source of truth:** Jira (status/scope) + Confluence (documentation). Everything else — including this file — is operational code or historical context.
>
> Rolling state lives in [HANDOFF.md](./HANDOFF.md). Env vars live in [docs/reference/ENV.md](./docs/reference/ENV.md). Story detail lives in Jira ([board](https://arkova.atlassian.net/jira/software/projects/SCRUM)). Topic docs live in Confluence ([space A](https://arkova.atlassian.net/wiki/spaces/A)).
>
> This file is the directive — rules Claude follows, shaped like a contract. Keep it ≤300 lines.

---

## 📣 Note for Sarah (and Sarah's agent)

1. **Never merge a PR to `main`.** Ever. Commit on a branch, open a PR, stop. Carson + human reviewers own the merge. Your task is done when the PR is green and awaiting review. Hard rule, no exceptions — see `memory/feedback_never_merge_without_ok.md`.
2. **Get caught up before coding in a new session.** At session start, in order: (a) this file, (b) [HANDOFF.md](./HANDOFF.md), (c) the relevant `agents.md` in each folder you'll touch, (d) `docs/SARAH_BACKLOG.md` (your curated task list — excludes Nessie and Gemini Golden tracks). Only start coding once you can say in a sentence what last session shipped and what you are picking up. If the task is an existing PR or story, also read the Jira ticket and recent comments first.

---

## 0. MANDATORY METHODOLOGY (8 rules)

### 1. TDD
Red-Green-Refactor. Write a failing test before production code. No `test.skip`, no "will add later."

### 2. Security review before every file lands
Manually scan each changed file for: PII leakage, command injection, SQL injection, XSS, path traversal, hardcoded secrets, missing RLS. Stop the PR if any hit.

### 3. Jira is the source of truth for status
Every task updates its ticket (DoR checked, DoD checked, status transitioned, Confluence link pasted). CLAUDE.md does NOT carry per-story status — only Jira does. "Done" means shippable, not "code merged." If a DoD gate is unmet, it's not Done.

### 4. Confluence is the source of truth for documentation
Every Jira story + epic (To Do / In Progress / Blocked / Done / Closed) MUST have a Confluence page. Markdown files in `docs/` are NOT documentation — they are either historical context or internal engineering notes. Auditors read Confluence. User has repeated this 500+ times; see `memory/feedback_confluence_is_the_doc.md`.

### 5. Bug log is canonical
Every bug found or fixed must land in the master tracker: https://docs.google.com/spreadsheets/d/1mOReOXL7cmBNDD77TKVKF3LsdQ3mEcmDbgs5q_pTEk4/edit?gid=0#gid=0

### 6. UAT every UI change
Dev server up at 1280px and 375px. Screenshots in the PR. Regressions logged in bug tracker.

### 7. Vertex endpoint hygiene
Audit `gcloud ai endpoints list` before + after every tuning/eval/deploy run. Target 1–2 deployed in steady state. Never keep cold-spare endpoints deployed — model artifacts preserve redeploy path at no cost. See `memory/feedback_vertex_endpoint_hygiene.md`.

### 8. Never work on `main`
Feature branches only. Push as many commits as you want — GitHub Actions ignores all feature-branch pushes (every workflow in `.github/workflows/` triggers only on PR or on push to `main`/`develop`). CI runs **once** when the PR opens and on each update. Merges are human-gated per `memory/feedback_never_merge_without_ok.md`. This keeps Actions minutes near zero during iteration.

### 9. Deploy gate ≡ CI lint job (R0-4 / SCRUM-1250)
`deploy-worker.yml` worker-lint step and `ci.yml` `Lint worker (deploy-gate parity)` step BOTH invoke `npm run lint` from `services/worker/` — the script in `services/worker/package.json`. Drift between them caused the 2026-04-25 12-hour deploy blackout (deploy gate ran a stricter eslint than CI). `scripts/ci/check-deploy-lint-parity.ts` enforces this at PR time. Override via PR label `ci-config-change` only. Followup R4 story drives worker eslint warnings to zero so we can re-add `--max-warnings 0` everywhere.

---

## 0.1. READ FIRST — EVERY SESSION

```
1. CLAUDE.md     <- Rules (this file).
2. HANDOFF.md    <- Current state, open blockers, decisions.
3. agents.md     <- In any folder you're about to edit.
4. Jira ticket   <- If the task references one.
```

Do NOT read `docs/archive/MEMORY_deprecated.md`, `ARCHIVE_memory.md`, or pre-2026-04-21 CLAUDE.md iterations — historical only.

---

## 1. THE CONSTITUTION

### 1.1 Tech Stack (locked)

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript + Tailwind + shadcn/ui + Lucide. Vite bundler. |
| Database | Supabase (Postgres + Auth). RLS mandatory on all tables. |
| Validation | Zod. Every write path. |
| Routing | react-router-dom v6. Named routes in `src/lib/routes.ts`. |
| Worker | Node + Express in `services/worker/`. Webhooks, cron, anchoring. |
| Payments | Stripe (SDK + webhooks). Worker-only, never browser. |
| Chain | bitcoinjs-lib. **Signing**: WIF in Secret Manager is the active signer (`client.ts:279` "WIF takes precedence (current)"); GCP KMS code path exists and is selected only when WIF is unset. **Broadcast**: GetBlock RPC (sovereign as of 2026-04-25). **UTXO listing + fee estimation + frontend balance reads**: still via public `mempool.space` — see HANDOFF.md "Bitcoin paths" for the honest path-by-path table. AWS KMS provider non-deployed (`memory/feedback_no_aws.md`). MockChainClient for tests. |
| Testing | Vitest + Playwright + RLS helpers. |
| Formal verification | TLA PreCheck. `machines/bitcoinAnchor.machine.ts`. |
| Ingress | Cloudflare Tunnel, Zero Trust. No public ports. |
| Edge compute | Cloudflare Workers + `wrangler`. Peripheral only — NOT core worker logic. |
| Observability | Sentry. PII scrubbing mandatory. |
| AI | Gemini (primary), `@cloudflare/ai` (fallback, `ENABLE_AI_FALLBACK` default false), `replicate` (QA only, hard-blocked in prod). |

**Hard constraints:** No Next.js API routes for long-running jobs. No server-side document processing (see 1.6). No Sentry events containing user emails, document fingerprints, or API keys. New AI libraries require architecture review.

### 1.2 Schema-first
- Define DB schema + RLS before UI. Once a table exists, never use mock data or `useState` arrays — query Supabase.
- Schema changes require migration + rollback comment + regenerated `database.types.ts` + seed update + Confluence page update.
- Never modify an existing migration — write a compensating one.

### 1.3 Terminology (UI copy only)
Banned in user-visible strings: Wallet, Gas, Hash, Block, Transaction, Crypto, Blockchain, Bitcoin, Testnet, Mainnet, UTXO, Broadcast.

| Banned | Use instead |
|---|---|
| Wallet | Fee Account / Billing Account |
| Transaction | Network Receipt / Anchor Receipt |
| Hash | Fingerprint |
| Testnet / Mainnet | Test Environment / Production Network |
| Issue Credential | Secure Document |

All UI copy in `src/lib/copy.ts`. CI enforced: `npm run lint:copy`. Internal code may use technical names.

### 1.4 Security (mandatory)
- RLS + `FORCE ROW LEVEL SECURITY` on every table.
- SECURITY DEFINER functions must `SET search_path = public`.
- Never expose `supabase.auth.admin` or service role key to browser.
- Never hardcode secrets. Treasury keys are server-side only, never logged.
- Stripe webhooks must call `stripe.webhooks.constructEvent()`.
- API keys: HMAC-SHA256 with `API_KEY_HMAC_SECRET`. Raw keys never persisted after creation.
- `anchor.status = 'SECURED'` is worker-only via service_role.

### 1.5 Timestamps & evidence
Server timestamps: Postgres `timestamptz`, UTC. Bitcoin times displayed as "Network Observed Time." Proof packages state what is measured, asserted, and NOT asserted. Jurisdiction tags are informational metadata only.

### 1.6 Client-side processing boundary
Documents never leave the user's device. Foundational privacy guarantee.
- `generateFingerprint` runs in browser only. Never import in `services/worker/`.
- Client-side OCR (PDF.js + Tesseract.js) extracts text on device.
- Client-side PII stripping removes all PII before anything leaves browser.
- Only PII-stripped structured metadata + fingerprint may flow to server.
- Gated by `ENABLE_AI_EXTRACTION` (default false). No "raw mode" bypass.

### 1.7 Testing
- RLS tests: `src/tests/rls/helpers.ts` `withUser()` / `withAuth()`.
- Tests must not call real Stripe or Bitcoin APIs — mock interfaces.
- Every task keeps the repo green: `typecheck`, `lint`, `test`, `lint:copy`.
- Coverage: 80% thresholds on critical paths.
- E2E in `e2e/` with Playwright. Every user-facing flow requires an E2E spec before COMPLETE.
- UI UAT defaults to local preview plus Chrome DevTools MCP for DOM, console, network, and screenshot proof. Use Vercel previews only for stakeholder demos or deploy-specific behavior.
- Use Sequential Thinking MCP for high-risk multi-step implementation planning and Google Developer Knowledge MCP for current Google API / SDK behavior.

### 1.8 API versioning
Verification API schema is frozen once published. No breaking changes without a `v2+` prefix and 12-month deprecation. Additive nullable fields are allowed without versioning.

### 1.9 Feature flags
`ENABLE_VERIFICATION_API` controls `/api/v1/*`. `ENABLE_PROD_NETWORK_ANCHORING` gates Bitcoin calls. `/api/health` always available.

### 1.10 Rate limits
Anonymous: 100 req/min/IP. API key: 1,000 req/min. Batch: 10 req/min. `Retry-After` on 429. Headers on every response.

---

## 2. RECEIVING A TASK

- **Story ID** → Read the Jira ticket + Confluence page. Confirm dependencies. State your plan before coding.
- **Direct instruction** → Map to the closest Jira story. Proceed as above.
- **Brand/UI task** → Read `docs/reference/BRAND.md` first.

---

## 3. TASK EXECUTION GATES

Every task — before declaring done — must pass all six gates:

1. **Tests** — Written first, seen failing, then made passing. `typecheck` + `lint` + `test` + `lint:copy` green. Coverage thresholds met.
2. **Jira** — Ticket status transitioned, DoR + DoD checked, Confluence URL pasted in ticket, acceptance criteria ticked off.
3. **Confluence** — Per-story page current (not just the epic page). Topic docs in Confluence updated per Doc Update Matrix.
4. **Bug log** — Any bugs found or fixed logged in the master tracker.
5. **agents.md** — Updated in every modified folder.
6. **HANDOFF.md + CLAUDE.md** — HANDOFF.md updated with the new state. CLAUDE.md only touched if a RULE changes — do not add rolling narrative here.

A task is NOT complete until all 6 gates pass. Announce gate status at the end of every task.

---

## 4. DOC UPDATE MATRIX

| Changed | Update Confluence page |
|---|---|
| Schema | Data Model |
| RLS | Security & RLS |
| Audit events | Audit Events |
| Bitcoin / chain | On-Chain Policy |
| Billing | Payments & Entitlements |
| Webhooks | Webhooks |
| Verification API | Identity & Access |
| Feature flags | Switchboard |
| Anchor lifecycle | + `machines/bitcoinAnchor.machine.ts` (re-verify with `check`) |

Migration procedure: create `supabase/migrations/NNNN_name.sql` with `-- ROLLBACK:` comment → `npx supabase db push` → regenerate types → update seed → test with `npx supabase db reset` → update the Data Model Confluence page. Never modify an existing migration.

Migration state (reality, not aspiration): see HANDOFF.md.

---

## 5. STORY STATUS

Source of truth: [Jira SCRUM board](https://arkova.atlassian.net/jira/software/projects/SCRUM). Do NOT maintain a per-story status table in this file — it will drift (and did, for months, until the 2026-04-21 audit).

For confluence audit pages, see [Confluence space A](https://arkova.atlassian.net/wiki/spaces/A) — every epic has an audit page titled `SCRUM-N — <summary> — AUDIT`.

Current epic health snapshot lives in HANDOFF.md and is updated at the end of every sprint.

---

## 6. COMMON MISTAKES

| Mistake | Do this instead |
|---|---|
| `useState` for Supabase table data | `useXxx()` hook querying Supabase |
| `supabase.insert()` without Zod | Call validator first |
| SECURITY DEFINER without `SET search_path = public` | Always add it |
| Text directly in JSX | `src/lib/copy.ts` |
| Schema change without `gen:types` | Regenerate types |
| Real Stripe / Bitcoin in tests | Mock interfaces |
| `anchor.status = 'SECURED'` from client | Worker-only via service_role |
| Exposing `user_id` / `org_id` / `anchors.id` publicly | Only `public_id` + derived fields |
| `generateFingerprint` in worker | Client-side only |
| `jurisdiction: null` in API response | Omit when null (frozen schema) |
| Changing anchor lifecycle without TLA+ | Edit machine first, run `check` |
| Raw API key in DB | HMAC-SHA256 hash |
| `current_setting('request.jwt.claim.role', true)` | Use `get_caller_role()` helper (PostgREST v11/v12 compat) |
| Function overloads differing only by DEFAULT | Single function with DEFAULT |
| Deploying DB function changes without `NOTIFY pgrst, 'reload schema'` | Always reload schema cache |
| Adding rolling narrative to CLAUDE.md | Put it in HANDOFF.md |
| `.md` file as "documentation" | Confluence page, with the `.md` either deleted or demoted to internal notes |

---

## 7. ENVIRONMENT VARIABLES

Moved out of this file. Canonical reference: [docs/reference/ENV.md](./docs/reference/ENV.md). Never commit actual values. Worker fails loudly in production when required vars are missing.

---

## 8. OPERATIONAL HISTORY

Moved to [HANDOFF.md](./HANDOFF.md). This file no longer carries a rolling narrative. If you are reading an old version of CLAUDE.md with pages of sprint notes, stats headers, and incident scar tissue — that was the pre-2026-04-21 format. The current format is directive-only.

---

_Directive version: 2026-04-21 (post-audit refactor). ≤300 lines by design. State → HANDOFF.md. Env → docs/reference/ENV.md. Status → Jira. Docs → Confluence. Mandates here._
