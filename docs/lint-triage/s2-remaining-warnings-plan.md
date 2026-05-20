# Sprint 2 ESLint Warning Remediation Plan

> services/worker/ -- 189 warnings, 0 errors
> Baseline: `npx eslint src/` on main @ 29d7c907 (2026-05-15)
> Goal: drive to 0 warnings so `--max-warnings 0` can be re-enabled (SCRUM-1250 R4)

---

## Warning Breakdown by Rule

| Rule | Count | Fix type | Auto-fixable |
|---|---|---|---|
| `@typescript-eslint/no-explicit-any` | 113 | TYPE_FIX / SUPPRESS | No |
| Unused `eslint-disable` directive | 40 | AUTO_FIX | Yes (all 40) |
| `no-useless-assignment` | 14 | REFACTOR | No |
| `arkova/missing-org-filter` | 12 | SUPPRESS (11) / REFACTOR (1) | No |
| `@typescript-eslint/ban-ts-comment` | 6 | AUTO_FIX-ish | No (manual s/r) |
| `preserve-caught-error` | 4 | REFACTOR | No |
| **Total** | **189** | | **40** |

---

## Warning Distribution by Domain

### `no-explicit-any` (113 total)

**Production files (58 warnings, 21 files):**

| Domain | Count | Files |
|---|---|---|
| jobs/ (fetchers, crons, rules) | 39 | ceFetcher, complianceFrameworkFetcher, ecfrFetcher, insuranceLicenseFetcher, ipedsFetcher, rule-action-dispatcher, sosFetcher, cleFetcher, enforcementFetcher, licensingBoardFetcher, ncesFetcher, queue-reminders, rules-engine, regulatory-change-cron, certificationFetcher |
| api/v1/ | 9 | signatures (8), verify (1) |
| signatures/ | 4 | pki/hsmBridge (4) |
| chain/ | 3 | base.ts (3) |
| utils/ | 2 | pipeline.ts (2) |
| middleware/ | 1 | ruleEventBackpressure.ts (1) |

**Test files (55 warnings, 10 files):**

| Domain | Count | Files |
|---|---|---|
| jobs/__tests__/ | 37 | cmsPhysicianFetcher (11), fccUlsFetcher (10), intlComplianceFetcher (6), newFetchers (6), australiaLawFetcher (2), ecfrFetcher (2), kenyaLawFetcher (2) |
| middleware/ | 7 | paymentTierRouter.test (7) |
| billing/ | 5 | meteredBilling.test (5) |
| api/v1/ | 4 | credits.test (4) |
| api/v2/ | 2 | agentWorkflows.test.ts `no-explicit-any`; these 2 warnings are included in this 55-warning test breakdown, while the file-level `@ts-nocheck` is counted separately only under `ban-ts-comment` |

### `unused-disable` (40 total -- ALL auto-fixable)

These are stale `// eslint-disable-next-line @typescript-eslint/no-explicit-any` comments that sit above ANOTHER disable comment rather than above the actual `any` usage. Removing them is purely cosmetic; the `any` still triggers its own warning.

Located in: 18 prod files (jobs/*, utils/pipeline, middleware/ruleEventBackpressure, types/express.d.ts, ai/eval/runner).

### `missing-org-filter` (12 total)

All 12 hit `audit_events` inserts/selects except one (`api_keys` update in keys.ts:274).

| File | Count | Assessment |
|---|---|---|
| api/v1/orgVerification.ts | 3 | SUPPRESS -- audit inserts scoped by actor_id, RLS covers tenant |
| api/v1/agents.ts | 2 | SUPPRESS -- audit inserts |
| api/v1/keys.ts | 2 | 1x SUPPRESS (audit insert), 1x REFACTOR (api_keys update needs org_id filter or RLS verification) |
| api/account-export.ts | 1 | SUPPRESS -- export scoped by actor_id via created_by |
| api/v1/identity.ts | 1 | SUPPRESS -- audit insert |
| api/v1/oracle.ts | 1 | SUPPRESS -- audit insert |
| api/v1/signatures.ts | 1 | SUPPRESS -- audit insert |
| api/v1/verify.ts | 1 | SUPPRESS -- audit insert |

### `no-useless-assignment` (14 total)

Variables assigned then never read. Pattern: either dead assignments before a return, or loop accumulators that got refactored out.

| File | Count | Variables |
|---|---|---|
| ai/eval/runner.ts | 2 | extractedFields, confidence |
| jobs/edgarFetcher.ts | 2 | hasMore (x2) |
| webhooks/delivery.ts | 2 | logEntry, logError |
| ai/eval/fraud-audit.ts | 1 | recommendation |
| ai/feedback.ts | 1 | suggestion |
| integrations/connectors/drive-changes-processor.ts | 1 | ruleEventId |
| jobs/anchorExpirySweep.ts | 1 | transitioned |
| jobs/courtlistenerFetcher.ts | 1 | nextUrl |
| jobs/federalRegisterFetcher.ts | 1 | hasMore |
| jobs/queue-reminders.ts | 1 | rules |
| utils/orgSuspensionGuard.ts | 1 | error |

### `ban-ts-comment` (6 total)

| File | Count | Issue |
|---|---|---|
| signatures/cades/cadesBuilder.ts | 3 | @ts-ignore on pkijs imports (untyped) |
| ai/zk-proof.ts | 2 | @ts-ignore on snarkjs imports (untyped) |
| api/v2/agentWorkflows.test.ts | 1 | @ts-nocheck on entire file |

### `preserve-caught-error` (4 total)

Error re-throws without preserving `cause`.

| File | Count |
|---|---|
| ai/visualFraudDetector.ts | 1 |
| signatures/adesEngine.ts | 1 |
| signatures/pki/crlManager.ts | 1 |
| signatures/timestamp/qtspProvider.ts | 1 |

---

## Execution Batches

### Batch 1: Auto-fix stale disable comments

**Method:** `npx eslint src/ --fix`
**Warnings eliminated:** 40
**Files touched:** 18
**Risk:** SAFE -- removes dead comments, no behavior change
**Soak tier:** T1
**Effort:** 5 minutes

Files:
- jobs/ceFetcher.ts (4)
- jobs/complianceFrameworkFetcher.ts (3)
- jobs/ecfrFetcher.ts (3)
- jobs/insuranceLicenseFetcher.ts (3)
- jobs/ipedsFetcher.ts (3)
- jobs/rule-action-dispatcher.ts (3)
- jobs/sosFetcher.ts (3)
- jobs/cleFetcher.ts (2)
- jobs/enforcementFetcher.ts (2)
- jobs/licensingBoardFetcher.ts (2)
- jobs/ncesFetcher.ts (2)
- jobs/queue-reminders.ts (2)
- jobs/rules-engine.ts (2)
- utils/pipeline.ts (2)
- ai/eval/runner.ts (1)
- jobs/certificationFetcher.ts (1)
- middleware/ruleEventBackpressure.ts (1)
- types/express.d.ts (1)

### Batch 2: Suppress `missing-org-filter` on audit_events (justified)

**Method:** Add `// eslint-disable-next-line arkova/missing-org-filter -- audit event: scoped by actor_id, RLS enforces tenant boundary` to 11 audit_events queries.
**Warnings eliminated:** 11
**Files touched:** 8
**Risk:** SAFE -- documentation-only change, no logic
**Soak tier:** T1
**Effort:** 30 minutes

Files: orgVerification.ts (3), agents.ts (2), keys.ts (1 of 2), account-export.ts, identity.ts, oracle.ts, signatures.ts, verify.ts

### Batch 3: Fix `api_keys` tenant isolation gap

**Method:** Verify RLS policy on `api_keys`, add `.eq('org_id', orgId)` filter if missing from the update query in keys.ts:274, or suppress with RLS-verified justification.
**Warnings eliminated:** 1
**Files touched:** 1
**Risk:** MEDIUM -- touches API key update path, needs RLS audit
**Soak tier:** T2
**Effort:** 1 hour (including RLS verification)

### Batch 4: Fix `ban-ts-comment` (ts-ignore -> ts-expect-error)

**Method:** Replace `@ts-ignore` with `@ts-expect-error` in zk-proof.ts and cadesBuilder.ts. Remove `@ts-nocheck` from agentWorkflows.test.ts (add per-line suppressions if needed).
**Warnings eliminated:** 6
**Files touched:** 3
**Risk:** SAFE -- ts-expect-error is strictly safer (fails if error disappears)
**Soak tier:** T1
**Effort:** 20 minutes

### Batch 5: Fix `preserve-caught-error` (add cause to re-throws)

**Method:** Change `throw new Error('...')` to `throw new Error('...', { cause: err })` in 4 catch blocks.
**Warnings eliminated:** 4
**Files touched:** 4
**Risk:** SAFE -- improves error tracing, no behavior change
**Soak tier:** T1
**Effort:** 15 minutes

### Batch 6: Fix `no-useless-assignment` (dead variable cleanup)

**Method:** Remove dead assignments or restructure to use the value. Each case needs individual inspection to confirm the variable is truly unused.
**Warnings eliminated:** 14
**Files touched:** 11
**Risk:** MEDIUM -- some may be intentional (e.g., hasMore for pagination continuation). Needs per-case review.
**Soak tier:** T1 (pure additive code cleanup, no migration/chain)
**Effort:** 2 hours

Sub-batches by confidence:
- **High confidence (remove assignment):** recommendation, suggestion, logEntry, logError, error, ruleEventId (6 warnings, 5 files)
- **Medium confidence (review loop logic):** hasMore (x3), nextUrl, transitioned, rules (6 warnings, 5 files)
- **Low confidence (review eval harness):** extractedFields, confidence (2 warnings, 1 file)

### Batch 7: Type `any` in test files (mock factories)

**Method:** Add proper type annotations to mock objects in test files. Pattern is `as any` casts on mock Supabase/Express objects.
**Warnings eliminated:** 55
**Files touched:** 10
**Risk:** SAFE -- test-only, zero prod impact
**Soak tier:** T1
**Effort:** 4 hours

Priority order (by warning density):
1. cmsPhysicianFetcher.test.ts (11)
2. fccUlsFetcher.test.ts (10)
3. paymentTierRouter.test.ts (7)
4. intlComplianceFetcher.test.ts (6)
5. newFetchers.test.ts (6)
6. meteredBilling.test.ts (5)
7. credits.test.ts (4)
8. australiaLawFetcher.test.ts (2)
9. ecfrFetcher.test.ts (2)
10. kenyaLawFetcher.test.ts (2)

### Batch 8: Type `any` in prod jobs files (Supabase client casts)

**Method:** Jobs files (fetchers, crons, rules) cast `supabase as any` to work around missing table types in the Supabase client for `public_records`. Fix: extend `database.types.ts` to include `public_records` table type, or create a typed wrapper. Alternatively, suppress with `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- public_records not in generated types`.
**Warnings eliminated:** 39
**Files touched:** 15 jobs files (fetchers, crons, rules)
**Risk:** MEDIUM -- if typing route: requires `gen:types` to include public_records; if suppress route: safe
**Soak tier:** T1 (type-only change, no runtime impact)
**Effort:** 3 hours (type route) or 1 hour (suppress route)

Batch 8 is the authoritative home for all 39 jobs/ warnings listed above, including `regulatory-change-cron.ts`; Batch 9 intentionally excludes jobs/ files.

### Batch 9: Type `any` in remaining prod files

**Method:** Individual type improvements per file.
**Warnings eliminated:** 19
**Files touched:** 6

| File | Count | Strategy |
|---|---|---|
| api/v1/signatures.ts | 8 | Type the signature verification payloads and error objects |
| api/v1/verify.ts | 1 | Type the verification payload and error object |
| signatures/pki/hsmBridge.ts | 4 | Type the HSM SDK responses |
| chain/base.ts | 3 | Type the UTXO/transaction objects |
| utils/pipeline.ts | 2 | Add generics to pipeline stages |
| middleware/ruleEventBackpressure.ts | 1 | Type the backpressure state |

**Risk:** MEDIUM -- typing chain/base.ts and signatures/ needs careful review
**Soak tier:** T1 (type-only, but signatures + chain proximity warrants extra review)
**Effort:** 6 hours

---

## Sprint 2 Schedule

| Batch | Warnings | Cumulative | Effort | Risk | Soak |
|---|---|---|---|---|---|
| B1: Auto-fix stale disables | 40 | 40 (21%) | 5 min | Safe | T1 |
| B2: Suppress audit_events org-filter | 11 | 51 (27%) | 30 min | Safe | T1 |
| B3: Fix api_keys tenant gap | 1 | 52 (28%) | 1 hr | Medium | T2 |
| B4: ban-ts-comment fixes | 6 | 58 (31%) | 20 min | Safe | T1 |
| B5: preserve-caught-error fixes | 4 | 62 (33%) | 15 min | Safe | T1 |
| B6: Dead assignment cleanup | 14 | 76 (40%) | 2 hr | Medium | T1 |
| B7: Test file `any` typing | 55 | 131 (69%) | 4 hr | Safe | T1 |
| B8: Jobs `any` typing/suppress | 39 | 170 (90%) | 1-3 hr | Medium | T1 |
| B9: Remaining prod `any` typing | 19 | 189 (100%) | 6 hr | Medium | T1 |

**Total estimated effort:** 15-17 hours
**Recommended sprint capacity:** B1-B7 in Sprint 2 (131 warnings = 69%, ~8 hours).
B8-B9 carry to Sprint 3 (remaining 58 warnings, 7-9 hours).

---

## PR Strategy

- **PR 1 (B1+B2+B4+B5):** "chore: auto-fix stale lint disables + suppress audit org-filter + ban-ts-comment + preserve-caught-error" -- 61 warnings, safe, T1. Ship day 1.
- **PR 2 (B3):** "fix(SCRUM-1208): add org_id filter to api_keys update" -- 1 warning, T2 soak required. Separate PR for security review.
- **PR 3 (B6):** "refactor: remove dead variable assignments in worker" -- 14 warnings, T1. Ship after review of each case.
- **PR 4 (B7):** "chore: type test mock factories" -- 55 warnings, T1. Large but zero-risk.
- **PR 5 (B8):** "chore: type/suppress jobs Supabase casts" -- 39 warnings, T1.
- **PR 6 (B9):** "refactor: type signatures, chain, and API handler anys" -- 19 warnings, T1 but careful review.

---

## Exit Criteria

When all 189 warnings reach 0:
1. Re-enable `--max-warnings 0` in `services/worker/package.json` lint script
2. Update `eslint.config.js`: promote remaining `warn` rules to `error`
3. Close SCRUM-1250 R4
4. Update Confluence: ESLint Policy page

---

_Plan authored: 2026-05-15. Baseline: 189 warnings @ 29d7c907._
