# Process Enforcement Rules
_Last updated: 2026-04-09 | Source: Phase 6 Forward-Operating Standard + Engineering Standards Codification_

> These rules are enforced on every task. Violations block merge.

---

## 1. Marketing/Docs Definition of Done (DoD)

Before any public-facing Wiki page, blog post, or feature release is published, it **must** be run through Claude with the following command:

> "Review this document for GEO and SEO. Ensure it targets our core pillars (**Algorithmic Non-Repudiation**, **SOC 2**, **Immutable Evidence**) and format it with clear H2s/H3s so AI search engines can easily parse the entities."

**Applies to:**
- Confluence pages under "External Wiki & Public Docs"
- Marketing site content (arkova.ai)
- Blog posts and announcements
- Feature release notes
- API documentation updates
- Developer portal content

**Enforcement:** Manual review gate. No public content ships without GEO/SEO review confirmation.

---

## 2. Engineering Definition of Ready (DoR)

Every Jira ticket MUST meet ALL of the following before work begins. Copy this checklist into every ticket's DoR field.

### DoR Checklist (copy into Jira)

```
## Definition of Ready
- [ ] Story/task has clear acceptance criteria
- [ ] Dependencies identified and met (or explicitly deferred)
- [ ] Relevant `agents.md` in target folders reviewed
- [ ] Story doc exists in `docs/stories/` (or will be created as first step)
- [ ] If schema change: migration approach agreed, rollback strategy documented
- [ ] If UI change: mockup/wireframe exists or behavior clearly described
- [ ] If security-sensitive: threat model considered (RLS, PII, injection vectors)
- [ ] Confluence doc identified for update (see Doc Update Matrix in CLAUDE.md §4)
```

---

## 3. Engineering Definition of Done (DoD)

Every Jira ticket MUST meet ALL of the following before moving to DONE. Copy this checklist into every ticket's DoD field. **No exceptions. No "will do later."**

### DoD Checklist (copy into Jira)

```
## Definition of Done

### GATE 1 — TDD & Tests (non-negotiable)
- [ ] Tests written FIRST (Red-Green-Refactor) — saw them fail before making them pass
- [ ] `npx tsc --noEmit` passes (zero type errors)
- [ ] `npm run lint` passes (ESLint — includes custom arkova rules)
- [ ] `npm run test` passes (all unit + integration tests green)
- [ ] `npm run lint:copy` passes (no banned terminology in UI strings)
- [ ] Coverage thresholds met on changed files (80% on critical paths)
- [ ] If user-facing flow changed: `npm run test:e2e` passes
- [ ] If schema changed: `npm run gen:types` regenerated and committed
- [ ] No `test.skip`, `test.todo`, or "will add later" in committed code
- [ ] No real Stripe/Bitcoin API calls in tests — mock interfaces only

### GATE 2 — Security (non-negotiable)
- [ ] No hardcoded secrets, API keys, or PII in committed code
- [ ] New tables: RLS + `FORCE ROW LEVEL SECURITY` applied
- [ ] SECURITY DEFINER functions include `SET search_path = public`
- [ ] Zod validation on all write paths before DB call
- [ ] `anchor.status = 'SECURED'` only set by worker via service_role
- [ ] No `supabase.auth.admin` or service_role key exposed to browser
- [ ] PII scrubbed from Sentry events (no emails, fingerprints, API keys)
- [ ] Scanned for: SQL injection, XSS, command injection, path traversal

### GATE 3 — Documentation (non-negotiable)
- [ ] Jira ticket updated: status transitioned, AC checked off
- [ ] Confluence doc updated per Doc Update Matrix (CLAUDE.md §4):
  - Schema → `02_data_model.md` | RLS → `03_security_rls.md`
  - Audit events → `04_audit_events.md` | Chain → `06_on_chain_policy.md`
  - Billing → `08_payments_entitlements.md` | Webhooks → `09_webhooks.md`
  - API → `12_identity_access.md` | Flags → `13_switchboard.md`
- [ ] Story doc in `docs/stories/` updated (status, files, test coverage)
- [ ] `agents.md` updated in every modified folder

### GATE 4 — Bug Tracking (non-negotiable)
- [ ] Bugs found during task: logged in Bug Tracker Spreadsheet
- [ ] Bugs fixed during task: row updated with resolution + regression test ref
- [ ] Production blockers noted in CLAUDE.md Section 5

### GATE 5 — CLAUDE.md (non-negotiable)
- [ ] If new rules/patterns/env vars/migrations/story status: CLAUDE.md updated
- [ ] Header stats (migrations, tests, stories) reflect reality
- [ ] Stale content removed — every edit leaves the file cleaner

### GATE 6 — UAT (if UI changed)
- [ ] Dev server verified at desktop (1280px) and mobile (375px)
- [ ] Screenshots confirm changes
- [ ] No regressions in adjacent UI
```

---

## 4. ESLint Quality Standards (non-negotiable)

All code MUST pass the following lint checks. These are enforced at pre-commit hook and CI.

### Standard Rules
| Rule | Severity | What It Enforces |
|------|----------|-----------------|
| `@typescript-eslint/no-unused-vars` | error | No dead code (`_` prefix allowed for intentional ignores) |
| `import/no-cycle` | error | No circular dependencies (max depth 4) |
| `react-hooks/recommended` | error | Hooks rules of React |

### Custom Arkova Rules (`eslint-plugin-arkova`)
| Rule | Current | Target | What It Enforces |
|------|---------|--------|-----------------|
| `arkova/no-unscoped-service-test` | warn | **error** | Tests mocking Supabase MUST assert `user_id`/`org_id` scoping |
| `arkova/require-error-code-assertion` | warn | **error** | Error tests MUST assert specific error code/status, not just "it failed" |
| `arkova/no-mock-echo` | warn | **error** | Tests MUST assert transformation/logic, not echo mock values back |

**Escalation timeline:** See `docs/confluence/18_testing_quality_standards.md` §5.

---

## 5. TDD Enforcement (non-negotiable)

| Gate | When | What |
|------|------|------|
| Pre-commit hook | Every local commit | Blocks if production code changed without corresponding test file changes |
| CI job (`tdd-enforcement`) | Every PR/push | Same check, blocks merge to main/develop |

**Escape hatch (emergency only):** `SKIP_TDD_CHECK=1 git commit` or `[skip-tdd]` in commit message. Abuse is visible in git log and flagged during review.

**What counts as production code:** Files in `src/hooks/`, `src/lib/`, `src/pages/`, `src/components/`, `services/worker/src/` (excluding tests, types, configs).

---

## 6. CI Quality Gates (13 gates, all must pass)

| # | Gate | Blocks Merge | What It Checks |
|---|------|:------------:|---------------|
| 1 | Secret Scanning | Yes | TruffleHog + Gitleaks |
| 2 | Dependency Scanning | Yes (critical) | npm audit |
| 3 | **TDD Enforcement** | **Yes** | Production code must have test changes |
| 4 | TypeCheck & Lint | Yes | `tsc --noEmit` + ESLint + copy terms |
| 5 | Generated Types | Warning | Supabase types freshness |
| 6 | Unit Tests | Yes | Vitest + coverage thresholds |
| 7 | RLS Tests | Yes | Live Supabase RLS verification |
| 8 | Worker Tests | Yes | Worker service + coverage |
| 9 | AI Eval Gate | Conditional | Prompt quality regression (if AI code changed) |
| 10 | TLA+ Verify | Conditional | State machine correctness (if TLA changed) |
| 11 | Migration Safety | Yes | Additive-only enforcement |
| 12 | E2E Tests | Yes | Playwright on Chromium |
| 13 | Lockfile Integrity | Yes | Supply chain protection |

---

## 7. Jira Workflow Rules

### Ticket Lifecycle

```
BACKLOG → READY (DoR met) → IN PROGRESS → IN REVIEW → DONE (DoD met)
```

### Required Fields (every ticket)

| Field | Required | When |
|-------|:--------:|------|
| Summary | Yes | Creation |
| Description / AC | Yes | Creation |
| Priority | Yes | Creation |
| Story Points | Yes | Before sprint |
| DoR Checklist | Yes | Before IN PROGRESS |
| DoD Checklist | Yes | Before DONE |
| Confluence Links | Yes | Before DONE |
| Epic Link | Yes | Creation |

### Transition Rules

| Transition | Requirement |
|-----------|-------------|
| BACKLOG → READY | DoR checklist complete |
| READY → IN PROGRESS | Sprint assigned, dev assigned |
| IN PROGRESS → IN REVIEW | All code committed, PR opened, all CI gates green |
| IN REVIEW → DONE | DoD checklist 100% complete, PR merged, Confluence updated |
| Any → BLOCKED | Blocker documented in ticket comments |

### Naming Conventions

| Item | Format | Example |
|------|--------|---------|
| Epic | `{PREFIX}: {Title}` | `DEP: Dependency Hardening` |
| Story | `{PREFIX}-{NN}: {Title}` | `DEP-05: Upgrade ESLint to v9 + Flat Config` |
| Bug | `BUG-{ID}: {Short description}` | `BUG-AUDIT-03: No favicon or OG meta tags` |
| Task | `OPS-{NN}: {Title}` | `OPS-03: Set Sentry DSN env vars` |

---

## 8. Coverage Thresholds (80% minimum)

These files/directories have enforced 80% coverage thresholds. Any PR that drops coverage below 80% on these paths is blocked by CI.

| Path | Why |
|------|-----|
| `src/lib/fileHasher.ts` | Document fingerprinting — security-critical |
| `src/lib/validators.ts` | Zod schema validation — data integrity |
| `src/lib/proofPackage.ts` | Proof download generation — legal evidence |
| `services/worker/src/chain/` | Bitcoin chain operations — financial |
| `services/worker/src/webhooks/` | Webhook delivery — integration reliability |
| `services/worker/src/stripe/` | Payment processing — financial |

---

## Change Log

| Date | Change |
|------|--------|
| 2026-03-29 | Initial creation — Marketing/Docs DoD rule added |
| 2026-04-09 | Engineering DoD, DoR, Jira workflow rules, ESLint standards, CI gates, coverage thresholds codified. Phase 6 expansion complete. |
