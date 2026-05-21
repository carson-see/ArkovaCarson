# PR #841 Ledger Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile main's migration filenames with production's existing
`0313 / anchors_index_consolidation` ledger row so PR #838 can later rebase
cleanly.

**Architecture:** Keep production's existing 0313 meaning as source of truth,
then move the PR #841 schema work to later migration numbers. Add an incident
regression test and operator runbook so staging/prod reconciliation cannot be
mistaken for normal soak evidence.

**Tech Stack:** Supabase migrations, GitHub Actions migration drift gate, Vitest.

---

## Task 1: Pin The Expected Migration Order

**Files:**

- Create: `scripts/ci/pr841-ledger-remediation.test.ts`

- [x] **Step 1: Write the failing test**

Create a Vitest test that asserts the cleaned sequence is exactly:

```text
0313_anchors_index_consolidation.sql
0314_legally_binding_attestations.sql
0315_professional_education_foundations.sql
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- scripts/ci/pr841-ledger-remediation.test.ts
```

Expected before implementation: fail because
`0313_anchors_index_consolidation.sql` is missing.

## Task 2: Reconcile Migration Files

**Files:**

- Create: `supabase/migrations/0313_anchors_index_consolidation.sql`
- Rename: `supabase/migrations/0313_legally_binding_attestations.sql` to
  `supabase/migrations/0314_legally_binding_attestations.sql`
- Rename: `supabase/migrations/0314_professional_education_foundations.sql` to
  `supabase/migrations/0315_professional_education_foundations.sql`

- [x] **Step 1: Add production's 0313 marker**

Create a deferred/manual migration that records production's existing 0313
anchors index consolidation ledger meaning and documents the standalone
`DROP INDEX CONCURRENTLY` statements.

- [x] **Step 2: Move PR #841 schema migrations forward**

Rename the legal attestation migration to 0314 and the professional education
migration to 0315 without changing their SQL bodies.

## Task 3: Update Guardrails And Runbook

**Files:**

- Modify: `.github/workflows/migration-drift.yml`
- Modify: `.github/workflows/agents.md`
- Modify: `scripts/ci/agents.md`
- Modify: `supabase/migrations/agents.md`
- Create: `docs/runbooks/supabase/pr841-ledger-remediation.md`

- [x] **Step 1: Update temporary drift exemptions**

Move the PR #841 temporary migration-drift exemptions from old 0313/0314 names
to new 0314/0315 names.

- [x] **Step 2: Document operator order**

Document that staging evidence from the old #841 order is diagnostic only, and
that staging must be reset or repaired to the cleaned 0313/0314/0315 order
before new soak evidence.

## Task 4: Verify And Open PR

**Files:**

- No additional files.

- [x] **Step 1: Run focused checks**

Run:

```bash
npm test -- scripts/ci/pr841-ledger-remediation.test.ts
npm --prefix services/worker test -- \
  --run src/test-utils/professional-education-migration.test.ts
npx tsx scripts/ci/check-migration-prefix-uniqueness.ts
git diff --check
```

- [ ] **Step 2: Push branch and open PR**

Open a draft/ready-for-review PR to `main` with staging evidence marked
pending, because migration reconciliation still needs real staging and operator
sign-off before prod.
