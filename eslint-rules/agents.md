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

### `arkova/no-connector-bytes-to-sink` (error — connector files only)
**What:** Flags a statically-identifiable raw-bytes value — a `Buffer.from(...)`/`Buffer.concat/alloc`, a typed-array (`new Uint8Array(...)`), a `*.bytes` member, an identifier/property matching `/(?:^|_)bytes$|buffer$|documentBytes/i`, or a raw `<bytes>.toString()` / `.toString('utf8'|'latin1'|…)` — reaching a sink that could leak it: `logger.*` (incl. nested object keys + child loggers), `Sentry.capture*`/`addBreadcrumb`/`setContext`/`setExtra`, `new <Foo>Error(...)`/`throw`/template literals, `last_error:` assignments + `failJob(...)`, `fs.write*`/`createWriteStream`, `.insert/.update/.upsert` row-object values, and `JSON.stringify(<bytes>)`. Does light single-hop same-scope alias tracking. Reports each leaf bytes value once (range-dedupe across overlapping sinks).
**Why:** CLAUDE.md §1.6A lets connector-fetched documents (DocuSign / Google Drive) be fingerprinted server-side, but raw document bytes must NEVER reach a logger, Sentry, an Error, `job_queue.last_error`, a temp file, or Postgres. SCRUM-2492 made this a build-time gate (was 0-of-6 controls enforced). The connector happy path is already clean, so the rule is regression-prevention.
**Does NOT flag:** `.byteLength`/`.length` numeric terminals, the fingerprint hex string, `createHash(...).update(bytes).digest('hex')`, `.toString('hex'|'base64')`, the canonical `enqueueSignedDocument` sink (persists only `byte_length`), or crypto `.update(<bytes>)` (object-only DB-write detection). The PKI/timestamp `arrayBuffer()` readers (`src/signatures/**`) are out of scope via the eslint config `files` list.
**Static-only blind spots (documented in the rule's `meta.docs`):** object spreads (`{ ...obj }`), cross-file/module flow, multi-hop reassignment, and helper-return values are not tracked. Backstopped by the byte-safe error types (L0), pino redaction (L2), type-based Sentry scrub (L3), `last_error` sanitizer (L4), and the multi-MB runtime leak test (L6).
**Scope:** ERROR on `src/integrations/**` plus the `docusign-*` connector job files in `services/worker/eslint.config.js`. Current violations: 0.

### `arkova/missing-org-filter` (warn — production files only)
**What:** Flags Supabase `.from('<table>')` calls against multi-tenant tables that lack a tenant-scoping filter (`.eq('org_id', ...)` or `.is('org_id', null)`) in the method chain. Also checks `.insert()`/`.upsert()` payloads for scope keys.
**Why:** SCRUM-1208 found three cross-tenant bugs in production (docusign webhook, ATS webhook, search endpoint). The rule makes tenant isolation visible at the query site.
**Monitored tables:** `org_integrations`, `integration_events`, `org_kyb`, `org_members`, `org_memberships`, `subscriptions`, `org_monthly_allocation`, `kyb_webhook_nonces`, `docusign_webhook_nonces`, `audit_events`, `organization_rule_events`, `organization_rule_executions`, `attestations`, `org_tier_entitlements`, `organization_rules`, `api_keys`, `org_api_keys`.
**Note:** `public_records` is intentionally excluded — it has no `org_id` column and is cross-tenant by design (public data pipeline).
**Worker override:** Cross-tenant system crons (`*Fetcher.ts`, `attestationAnchor.ts`, `chain-maintenance.ts`, etc.) are exempted in `services/worker/eslint.config.js`. Org-scoped jobs (`report.ts`, `rules-engine.ts`, `rule-action-dispatcher.ts`, `queue-reminders.ts`) keep the rule active.

## Architecture
- ESLint v9/v10 flat config
- Plugin registered as `file:./eslint-rules` in `package.json` devDependencies
- Test-quality rules apply to test files; `missing-org-filter` applies to production files; `no-connector-bytes-to-sink` applies to worker connector files only
- All rules are AST-based (no regex on source text). `no-connector-bytes-to-sink` does light single-hop alias resolution via the scope manager (`sourceCode.getScope(node)`); the scope travels through an explicit `ctx` bag because ESLint's `context` is not safe to stash per-node state on.
- RuleTester coverage for every rule lives in `tests/eslint-rules/arkova-rules.test.ts` (run via root `npm test`, not `npm run lint`).

## Escalation Plan
1. **Now:** All 3 rules at `warn` — CI passes, violations visible
2. **Next sprint:** Fix the 23 `no-unscoped-service-test` violations
3. **Then:** Escalate `no-unscoped-service-test` to `error` — new tests MUST assert scoping
