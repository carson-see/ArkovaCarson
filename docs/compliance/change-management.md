# Arkova Change Management Process

> **Version:** 2026-03-23 | **Classification:** CONFIDENTIAL
> **SOC 2 Control:** CC8.1 — Changes to Infrastructure, Data, Software, and Procedures
> **Story:** CISO Action-16

---

## 1. Overview

Arkova uses a PR-based change management process enforced by CI gates. All changes to production systems flow through version-controlled pull requests with automated quality checks.

---

## 2. Change Categories

| Category | Description | Approval | Examples |
|----------|-------------|----------|----------|
| **Standard** | Low-risk, auto-approved by CI | CI gates pass | Bug fixes, UI tweaks, doc updates |
| **Normal** | Moderate-risk, requires PR review | 1 reviewer + CI | New features, API changes, dependency updates |
| **Security** | Touches auth, RLS, secrets, PII | CODEOWNERS review (@carson-see) | Migration with RLS, auth changes, key rotation |
| **Emergency** | Production incident response | Post-hoc review within 48h | Hotfix for P1/P2 incidents |
| **Infrastructure** | Env vars, provider changes, deploys | CHANGE_REQUEST template required | DB migration, new vendor, env var change |

---

## 3. Standard Change Process (PR-Based)

### 3.1 Developer Workflow

1. Create feature branch from `main`
2. Implement changes following Constitution rules
3. Write tests (TDD mandate: red-green-refactor)
4. Open Pull Request with description of changes
5. CI pipeline runs automatically:
   - Secret scanning (TruffleHog + Gitleaks)
   - Dependency audit (npm audit)
   - TypeScript typecheck
   - Lint + UI copy lint
   - Unit tests with coverage
   - RLS tests
   - Worker tests
   - AI eval regression gate (if AI code changed)
   - TLA+ verification (if state machine changed)
   - Migration safety check (additive-only policy)
   - E2E tests
   - Lockfile integrity check
6. All CI checks must pass before merge
7. Merge to `main` triggers auto-deploy

### 3.2 CI Gates (Required)

| Gate | Tool | Blocks Merge |
|------|------|:---:|
| Secret scanning | TruffleHog + Gitleaks | Yes |
| Dependency audit | npm audit | Yes (critical/high) |
| TypeScript check | tsc --noEmit | Yes |
| Lint | ESLint | Yes |
| UI copy terms | lint:copy | Yes |
| Unit tests | Vitest | Yes |
| E2E tests | Playwright | Yes |
| Migration safety | Custom script | Yes |
| CODEOWNERS review | GitHub | Yes (security paths) |

---

## 4. Infrastructure Change Request Template

For infrastructure changes (DB migrations, env vars, provider switches), use this template:

```markdown
## Change Request

**Type:** [Migration | Env Var | Provider | Infrastructure]
**Risk Level:** [Low | Medium | High | Critical]
**Rollback Plan:** [describe rollback steps]

### What is changing?
[Description]

### Why?
[Business justification]

### Impact Assessment
- [ ] No breaking API changes
- [ ] RLS policies updated if needed
- [ ] database.types.ts regenerated if schema changed
- [ ] Confluence docs updated
- [ ] Seed data updated
- [ ] Rollback comment included in migration

### Testing
- [ ] Unit tests added/updated
- [ ] Manual verification completed
- [ ] No regression in existing tests
```

---

## 5. Emergency Change Process

For P1/P2 production incidents:

1. **Incident Commander** authorizes emergency change
2. Developer creates hotfix branch from `main`
3. Minimal fix applied — no feature work
4. CI gates still run (may skip E2E for speed)
5. Merge with expedited review (IC approval sufficient)
6. **Post-hoc review within 48 hours:**
   - Root cause analysis documented
   - Full test coverage added
   - Incident report filed (see `incident-response-plan.md`)

---

## 6. Database Migration Procedure

Per Constitution Section 4:

1. Create `supabase/migrations/NNNN_descriptive_name.sql`
2. Include `-- ROLLBACK:` section at bottom
3. Apply: `npx supabase db push`
4. Regenerate types: `npx supabase gen types typescript --local > src/types/database.types.ts`
5. Update seed: `supabase/seed.sql`
6. Test: `npx supabase db reset`
7. Update docs: `docs/confluence/02_data_model.md`

**Rules:**
- Never modify an existing migration — write a compensating migration
- New tables require RLS + FORCE ROW LEVEL SECURITY
- SECURITY DEFINER functions must include SET search_path = public

---

*Last reviewed: 2026-03-23 | Next review: 2026-06-23*
