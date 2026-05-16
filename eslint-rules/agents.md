# eslint-rules/ — Arkova Test Quality Rules

Custom ESLint plugin (`eslint-plugin-arkova`) enforcing test quality standards.

## Rules

### `arkova/no-unscoped-service-test` (warn, escalate to error)
**What:** Flags test files that mock `supabase.from()` but never assert that queries include `user_id` or `org_id` scoping.
**Why:** Without scoping assertions, a test passes even if production code drops `.eq('user_id', ...)` — a silent RLS bypass. The real Supabase RLS policies enforce this at the DB level, but mock tests bypass RLS entirely.
**Fix:** Add `expect(mockEq).toHaveBeenCalledWith('user_id', userId)` or similar.
**Current violations:** 23 files (see `npx eslint --rule 'arkova/no-unscoped-service-test: error' src/**/*.test.ts`)

### `arkova/require-error-code-assertion` (warn)
**What:** Flags `it('...error...')` / `it('...fail...')` test blocks that check for error responses but never assert the specific error code, status, or message.
**Why:** Just checking "it failed" is insufficient — tests must verify the code fails with the RIGHT error. A 500 and a 403 are very different failures.
**Fix:** Add `expect(error.code).toBe('PGRST301')` or `expect(response.status).toBe(403)`.
**Current violations:** 14 test blocks

### `arkova/no-mock-echo` (warn)
**What:** Flags test blocks where >50% of `toBe`/`toEqual` assertions use the exact literal values defined in the mock setup.
**Why:** These "echo tests" prove the mock framework works, not the code under test. If the production code is deleted, a mock echo test still passes.
**Fix:** Assert transformations, business logic, side effects, or error handling — not that data passes through unchanged.
**Current violations:** 8 test blocks

### `arkova/missing-org-filter` (warn — production files only)
**What:** Flags Supabase `.from('<table>')` calls against multi-tenant tables that lack a tenant-scoping filter (`.eq('org_id', ...)` or `.is('org_id', null)`) in the method chain. Also checks `.insert()`/`.upsert()` payloads for scope keys.
**Why:** SCRUM-1208 found three cross-tenant bugs in production (docusign webhook, ATS webhook, search endpoint). The rule makes tenant isolation visible at the query site.
**Monitored tables:** `org_integrations`, `integration_events`, `org_kyb`, `org_members`, `org_memberships`, `subscriptions`, `org_monthly_allocation`, `kyb_webhook_nonces`, `docusign_webhook_nonces`, `audit_events`, `organization_rule_events`, `organization_rule_executions`, `attestations`, `org_tier_entitlements`, `organization_rules`, `api_keys`, `org_api_keys`.
**Note:** `public_records` is intentionally excluded — it has no `org_id` column and is cross-tenant by design (public data pipeline).
**Worker override:** Cross-tenant system crons (`*Fetcher.ts`, `attestationAnchor.ts`, `chain-maintenance.ts`, etc.) are exempted in `services/worker/eslint.config.js`. Org-scoped jobs (`report.ts`, `rules-engine.ts`, `rule-action-dispatcher.ts`, `queue-reminders.ts`) keep the rule active.

## Architecture
- ESLint v9 flat config
- Plugin registered as `file:./eslint-rules` in `package.json` devDependencies
- Test-quality rules apply to test files; `missing-org-filter` applies to production files
- All rules are AST-based (no regex on source text)

## Escalation Plan
1. **Now:** All 3 rules at `warn` — CI passes, violations visible
2. **Next sprint:** Fix the 23 `no-unscoped-service-test` violations
3. **Then:** Escalate `no-unscoped-service-test` to `error` — new tests MUST assert scoping
