# Sprint 3 Continuation Prompt — DocuSign Integration (Epic SCRUM-1866)

_Generated: 2026-05-27. To be used at the start of Sprint 3._

---

## Context for the New Session

You are a product manager working with your tech lead, a lead researcher, and a dev team (2 sr full-stack devs, sr frontend dev/designer, sr QA). We develop to SOC 2 Type II standards.

**Read first:** `CLAUDE.md`, `HANDOFF.md`, then `agents.md` in each folder you'll touch.

## What Sprint 2 Shipped

### SCRUM-2042 — Retry Exhaustion Reconciliation (SOC 2 CC7.2)

**Status:** Code complete, tests pass, awaiting PR + staging soak.

Files created/modified:
- `supabase/migrations/0318_docusign_reconciliation_gaps.sql` — purpose-built table for gap rows (distinct from 3 existing DLQ tables). RLS deny-all for anon+authenticated. Unique constraint on `(integration_id, envelope_id)`. Resolution workflow: pending → requeued/stale/manual.
- `services/worker/src/jobs/docusign-reconciliation.ts` — pure `reconcileDocusignGaps(deps, lookbackHours?)` function. DI via `ReconciliationDeps` interface. Polls Envelopes API (24h lookback default, `?status=completed&count=100`), diffs against `docusign_webhook_nonces`, inserts gaps, fires Sentry per new gap. Continues to next integration on per-integration failures.
- `services/worker/src/jobs/docusign-reconciliation-deps.ts` — `makeReconciliationDeps()` factory wiring Supabase + DocuSign API + GCP Secret Manager token store.
- `services/worker/src/jobs/docusign-reconciliation.test.ts` — 13 tests covering: gap detection, duplicate handling, Sentry alerting, token keep-alive, per-integration error isolation, multi-envelope mixed status, lookback window, empty integration list.
- `services/worker/src/routes/cron.ts` — added `/cron/docusign-reconciliation` route.
- `scripts/gcp-setup/cloud-scheduler.sh` — `docusign-reconciliation` entry: daily 06:00 UTC, retry policy `30s,120s,2`.

**Key design decisions:**
- Token keep-alive: refreshes OAuth tokens for every active integration even when no gaps found, preventing 30-day expiry on idle connections.
- Separate from existing DLQs: this captures events DocuSign never delivered at all (retry exhaustion after 45 attempts over 7 days), not processing failures.
- DocuSign Envelopes API: 3,000 calls/hr rate limit, max 1000 results per page (hard cap), pagination via `nextUri`.

### SCRUM-2043 — Dual HMAC Key Rotation (SOC 2 CC6.1)

**Status:** Code complete, tests pass, awaiting PR + staging soak.

Files created/modified:
- `supabase/migrations/0319_org_integrations_hmac_keys.sql` — adds `hmac_keys jsonb` column to `org_integrations`. Null = fall back to env var. Schema: `[{key, created_at, label?}]`.
- `services/worker/src/integrations/oauth/docusign-hmac.ts` — `verifyDocusignConnectHmacMultiKey()` accepts N signatures × N keys, returns true if any pair matches. `extractDocusignSignatures()` reads `X-DocuSign-Signature-1` through `-N`.
- `services/worker/src/api/v1/webhooks/docusign-hmac-helpers.ts` — `resolveHmacKeys()`: org keys take priority, env var fallback when null/empty.
- `services/worker/src/api/v1/integrations/docusign-hmac-rotation.ts` — pure `rotateHmacKey()` and `retireHmacKey()` functions with DI. Max 2 keys. Cannot retire the last key.
- `services/worker/src/api/v1/webhooks/docusign.ts` — **BREAKING CHANGE**: handler order flipped from `HMAC→parse→lookup` to `parse→lookup→HMAC` (lookup-first). Now reads `hmac_keys` from integration row. Falls back to `DOCUSIGN_CONNECT_HMAC_SECRET` env var when `hmac_keys` is null.
- Tests: 33 tests across 3 test files covering multi-key verification, signature extraction, key resolution, rotation lifecycle, retirement edge cases.

**Key design decisions:**
- DocuSign signs with ALL account-level keys simultaneously (headers 1 through N). Rotation: add new key → DocuSign sends both sigs → update listener → retire old key. Zero downtime.
- Max 2 keys enforced to prevent key sprawl.
- Lookup-first order means we parse the body to get `accountId` before checking HMAC. This is necessary to resolve which HMAC keys to check. The body is already validated by Zod schema.
- ~~`provisionConnectListener()` still sends `hmacSecret` from env var — Sprint 3 TODO to also send per-org keys.~~ **VOID (2026-08-01, SCRUM-2075/2147).** `hmacSecret` is not a field on DocuSign's `ConnectCustomConfiguration`; it was never honoured and has been removed from the payload. HMAC keys are ACCOUNT-side. See Story C below.

### SCRUM-2044 — Member-Level DocuSign (Spec Only)

**Status:** Design spec complete at `docs/specs/SCRUM-2044-member-level-docusign.md`.

Key design:
- New `member_integrations` table (parallel to `org_integrations`, scoped to `(user_id, org_id)`).
- Webhook handler extended to check both tables; org-level wins on ambiguous `account_id`.
- Dual-routing: member events go to both org rules engine and member notification channel.
- Member OAuth endpoints at `/api/v1/integrations/docusign/member/oauth/*`.
- Token isolation via separate Secret Manager naming.

**Open questions flagged in spec:**
1. Notification delivery mechanism (Realtime vs job queue)
2. Member self-service key rotation permissions
3. DocuSign Connect configuration quota limits

---

## Sprint 3 Suggested Scope

### Story A: SCRUM-2042/2043 Staging Soak + PR Merge

**Tier:** T2 (migration + new cron + webhook handler change)

- Create PRs for SCRUM-2042 and SCRUM-2043 (separate branches were requested).
- Run `scripts/ci/staging-honesty-preflight.ts` against staging.
- Apply migrations 0318 + 0319 to staging via `npx supabase db push --linked`.
- Deploy worker revision to staging with Cloud Run tag URL.
- 12h soak with synthetic load exercising:
  - `/cron/docusign-reconciliation` (verify gap detection against seeded test data)
  - DocuSign Connect webhook with dual HMAC keys
- Rollback rehearsal: drop `docusign_reconciliation_gaps`, remove `hmac_keys` column.
- Fill staging soak evidence blocks in PR bodies.

### Story B: Wire Rotation API Endpoint to Express Router

The pure `rotateHmacKey()` / `retireHmacKey()` functions exist but are not yet mounted as HTTP endpoints. Sprint 3 should add:

```
POST /api/v1/integrations/docusign/hmac/rotate
  Body: { org_id, integration_id }
  Auth: org admin required
  Returns: { ok, new_key, total_keys }

POST /api/v1/integrations/docusign/hmac/retire
  Body: { org_id, integration_id, retire_created_at }
  Auth: org admin required
  Returns: { ok, remaining_keys }
```

Wire `makeRotationDeps()` factory that uses real Supabase. Add E2E or integration tests that hit the endpoint with mocked auth.

### Story C: ~~Update `provisionConnectListener()` to Use Per-Org HMAC Keys~~ — CANCELLED, NOT IMPLEMENTABLE

**Do not implement this story as written.** It assumed the provisioner could push an HMAC key to DocuSign. It cannot: `hmacSecret` is not a declared field on DocuSign's `ConnectCustomConfiguration` resource, so the key never travelled and the loop this story describes does not exist. Verified 2026-08-01 (SCRUM-2075/2147) against DocuSign's generated model; the field has been removed from the provisioning payload and `services/worker/src/integrations/oauth/agents.md` now forbids re-adding it.

`includeHMAC: "true"` only asks DocuSign *to* sign. **Which** key it signs with is account-side state, established either by a DocuSign admin on the customer account or — the actual multi-tenant answer — by DocuSign's API-only `integratorManaged` "HMAC for Partners" flag, which makes DocuSign sign customer-account deliveries with the key registered on the account that owns Arkova's integration key.

If per-org / rotating keys are still wanted, the replacement story is: register the key on the integration-key account, set `integratorManaged` at provision time, extend the listener-drift checker to detect it, and reprovision existing listeners. Note it is a **one-way door** through code as currently shaped — a PUT that omits the field cannot turn it back off. See `docs/runbooks/integrations/docusign.md` → "The HMAC key is ACCOUNT-SIDE".

### Story D: Member-Level DocuSign — Schema + OAuth (from SCRUM-2044 spec)

Implement the first phase from the spec:
1. Migration for `member_integrations` table + RLS policies.
2. Member OAuth endpoints (start/callback/disconnect).
3. Extend `findIntegration()` in webhook handler to check both tables.
4. Audit trail events for member-level connect/disconnect.

### Story E: Reconciliation Cron — Pagination for Large Accounts

The current `listCompletedEnvelopes` dep fetches `count=100`. DocuSign caps at 1000 per page. For orgs with high envelope volume, implement pagination:
- Follow `nextUri` in the response until absent.
- Cap at 10 pages (10,000 envelopes) as a safety valve.
- Add a test for the pagination loop.

---

## Known Risks / Blockers

1. **PR #867 conflict**: PR #867 touches the webhook handler and integration lookup code. SCRUM-2043's lookup-first change will conflict. Resolve after #867 merges.
2. **Staging contamination**: Check `scripts/ci/staging-honesty-preflight.ts` before starting any soak. Shared staging at `ujtlwnoqfhtitcmsnrpq` may have prior soak artifacts.
3. **DOCUSIGN_DEMO=true**: All DocuSign API calls currently go to demo/sandbox. Per-org HMAC key rotation via DocuSign Connect API must be tested against demo environment.
4. **Envelopes API rate limits**: 3,000 calls/hr per account. Daily reconciliation with 24h lookback should stay well under, but monitor if multiple integrations share the same DocuSign account.

---

## Files to Read at Sprint 3 Start

```
1. CLAUDE.md
2. HANDOFF.md
3. services/worker/src/jobs/agents.md
4. services/worker/src/api/v1/webhooks/agents.md
5. services/worker/src/api/v1/integrations/agents.md
6. services/worker/src/integrations/oauth/agents.md
7. docs/specs/SCRUM-2044-member-level-docusign.md
8. This file (docs/specs/sprint-3-continuation-prompt.md)
```
