# 18 — Testing & Quality Standards
_Last updated: 2026-04-08 | Session 32_

## Overview

Arkova enforces strict TDD discipline and test quality through three layers:
1. **Pre-commit hooks** — block commits locally before they reach CI
2. **CI gates** — block merges to main/develop
3. **Custom ESLint rules** — flag test anti-patterns in real-time during development

---

## 1. TDD Enforcement

### Mandate (CLAUDE.md §0)
> Red-Green-Refactor. No production code without a corresponding test written first.

### How It's Enforced

| Gate | When | What Happens |
|------|------|-------------|
| Pre-commit hook (`.githooks/pre-commit`) | Every local commit | Blocks if production code changed without test file changes |
| CI job (`tdd-enforcement`) | Every PR and push | Same check, runs on GitHub Actions, blocks merge |

### What Counts as "Production Code"
Files in: `src/hooks/`, `src/lib/`, `src/pages/`, `src/components/`, `services/worker/src/`

Excluding: `*.test.*`, `*.spec.*`, `__mocks__/`, `*.d.ts`, `*.css`, `*.json`, `copy.ts`, `routes.ts`, `database.types.ts`, barrel `index.ts` files.

### What Counts as "Test Changes"
Files matching: `*.test.*`, `*.spec.*`, `tests/`, `e2e/`

### Escape Hatch (Emergency Only)
```bash
SKIP_TDD_CHECK=1 git commit -m "fix: emergency hotfix"
# or include [skip-tdd] in commit message
```
Abuse is visible in `git log` and flagged during code review.

### Setup (New Developer)
```bash
git config core.hooksPath .githooks
```

---

## 2. Custom ESLint Rules (`eslint-plugin-arkova`)

Three rules enforce test quality standards. Located in `eslint-rules/`.

### Rule 1: `arkova/no-unscoped-service-test` (warn)

**Problem:** Tests that mock `supabase.from()` but never assert that queries filter by `user_id` or `org_id`. Without this assertion, the test passes even if the production code removes the scoping filter — a silent RLS bypass.

**Detection:** Finds `vi.mock('supabase')` + `from:` in the mock factory, then checks for `toHaveBeenCalledWith('user_id', ...)` or `toHaveBeenCalledWith('org_id', ...)`.

**Fix example:**
```typescript
// BAD — test passes even if .eq('org_id', orgId) is removed
it('fetches members', async () => {
  mockLimit.mockResolvedValue({ data: mockProfiles, error: null });
  expect(result.current.members).toHaveLength(1);
});

// GOOD — explicitly verifies the scoping filter
it('fetches members scoped to org', async () => {
  mockLimit.mockResolvedValue({ data: mockProfiles, error: null });
  expect(mockEq).toHaveBeenCalledWith('org_id', 'org-1');
  expect(result.current.members).toHaveLength(1);
});
```

**Violations found:** 23 test files (session 32 baseline).

### Rule 2: `arkova/require-error-code-assertion` (warn)

**Problem:** Tests named `it('...error...')` or `it('...fail...')` that check for an error condition but never assert the specific error code, HTTP status, or message. Checking "it failed" is insufficient — tests must verify the code fails with the RIGHT error.

**Detection:** Matches test names containing error/fail/denied/invalid/etc. keywords, checks for `.error`/`.ok`/`.status` property access, then verifies specific assertions exist (`.toBe(403)`, `.toContain('...')`, `expect(x.error.code)...`).

**Fix example:**
```typescript
// BAD — would pass on ANY error (500, 403, timeout, etc.)
it('handles API error', async () => {
  expect(result).toBeNull();
});

// GOOD — asserts the specific error
it('handles API error', async () => {
  expect(result).toBeNull();
  expect(response.status).toBe(503);
  expect(error.message).toContain('AI extraction disabled');
});
```

**Violations found:** 14 test blocks.

### Rule 3: `arkova/no-mock-echo` (warn)

**Problem:** Tests that set up mock data and then assert the exact same literal values come back out. These "echo tests" prove the mock framework works, not the code under test.

**Detection:** Collects literal values from `mockResolvedValue()` / `mockReturnValue()` calls and `mock*` variable declarations, then checks if >50% of `toBe`/`toEqual` assertions use those same values.

**Fix example:**
```typescript
// BAD — just proves the mock passes data through
const mockData = { balance: 45 };
mockRpc.mockResolvedValue({ data: mockData });
it('fetches credits', () => {
  expect(result.balance).toBe(45); // echo of mock
});

// GOOD — asserts transformation, logic, or side effects
it('formats balance with currency', () => {
  expect(result.displayBalance).toBe('$0.45');
  expect(result.isLow).toBe(true); // derived from balance < threshold
});
```

**Violations found:** 8 test blocks.

---

## 3. Test Infrastructure

### Test Frameworks

| Framework | Scope | Config |
|-----------|-------|--------|
| Vitest | Unit + integration | `vitest.config.ts` |
| Vitest (RLS) | Row-level security | `vitest.config.rls.ts` (live Supabase) |
| Vitest (Worker) | Worker service | `services/worker/vitest.config.ts` |
| Playwright | End-to-end | `playwright.config.ts` |

### Coverage Thresholds (80% minimum)

Applied to critical security/validation paths:
- `src/lib/fileHasher.ts` — document fingerprinting
- `src/lib/validators.ts` — Zod schema validation
- `src/lib/proofPackage.ts` — proof download generation
- `services/worker/src/chain/` — Bitcoin chain operations
- `services/worker/src/webhooks/` — webhook delivery
- `services/worker/src/stripe/` — payment processing

### RLS Test Helpers

```typescript
import { withUser, createServiceClient, createAnonClient } from '../../src/tests/rls/helpers';

// Test cross-tenant isolation
const client = await withUser('user@org-a.com', 'ORG_ADMIN');
const { data } = await client.from('anchors').select();
expect(data).toEqual([]); // Cannot see Org B anchors
```

### Test Counts (Session 32)

| Category | Count |
|----------|-------|
| Unit tests | ~1,182 |
| RLS integration tests | ~30 |
| E2E tests | ~20+ specs |
| ESLint rule tests | 10 |
| Load tests | 5 scenarios |
| **Total** | **~2,835** |

---

## 4. CI Pipeline (Quality Gates)

All gates must pass before merge to `main` or `develop`.

| # | Job | Blocks Merge? | What It Checks |
|---|-----|---------------|---------------|
| 1 | Secret Scanning | Yes | TruffleHog + Gitleaks |
| 2 | Dependency Scanning | Yes (critical) | npm audit |
| 3 | **TDD Enforcement** | **Yes** | Production code must have test changes |
| 4 | TypeCheck & Lint | Yes | `tsc --noEmit` + ESLint + copy terms |
| 5 | Generated Types | Warning | Supabase types freshness |
| 6 | Unit Tests | Yes | Vitest + coverage thresholds |
| 7 | RLS Tests | Yes | Live Supabase RLS verification |
| 8 | Worker Tests | Yes | Worker service + coverage |
| 9 | AI Eval Gate | Yes (conditional) | Prompt quality regression (if AI changed) |
| 10 | TLA+ Verify | Yes (conditional) | State machine correctness (if TLA changed) |
| 11 | Migration Safety | Yes | Additive-only enforcement |
| 12 | E2E Tests | Yes | Playwright on Chromium |
| 13 | Lockfile Integrity | Yes | Supply chain protection |

---

## 5. Escalation Plan

| Phase | Timeline | Action |
|-------|----------|--------|
| **Now** | Session 32 | All 3 ESLint rules at `warn`. TDD gate enforced. 45 existing warnings visible. |
| **Sprint 1** | Next 2 weeks | Fix 23 `no-unscoped-service-test` violations (add scoping assertions) |
| **Sprint 2** | Following 2 weeks | Fix 14 `require-error-code-assertion` + 8 `no-mock-echo` violations |
| **Post-fix** | After cleanup | Escalate `no-unscoped-service-test` to `error` (blocks CI) |

---

## 6. Jira Integration — DoR/DoD Checklists

All testing and quality standards in this document are codified as **mandatory Jira checklists** in `docs/process_enforcement.md`. Every ticket must include:

- **Definition of Ready (DoR)** — verified before work begins (§2 of process_enforcement.md)
- **Definition of Done (DoD)** — all 6 gates verified before ticket moves to DONE (§3 of process_enforcement.md)

The DoD includes explicit checkboxes for:
- TDD (tests written first, saw them fail)
- All 4 CI commands green (`typecheck`, `lint`, `test`, `lint:copy`)
- Coverage thresholds met
- Security review (RLS, PII, injection)
- Documentation updated (Confluence, story docs, agents.md, CLAUDE.md)
- Bug tracker updated
- UAT verified (if UI changed)

**These are non-negotiable.** No ticket moves to DONE without 100% of the DoD checklist completed.

See: [`docs/process_enforcement.md`](../process_enforcement.md) for the full copy-paste checklists.

---

## Change Log

| Date | Story | Change |
|------|-------|--------|
| 2026-04-08 | Session 32 | Created: TDD enforcement hook + CI gate, 3 custom ESLint rules, escalation plan |
| 2026-04-09 | DEP-05 | Added §6: Jira DoR/DoD integration. Cross-referenced process_enforcement.md |
