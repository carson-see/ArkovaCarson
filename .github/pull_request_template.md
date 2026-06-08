## Summary
<!-- Brief description of what this PR does -->

## Jira Issue
<!-- Link to the Jira issue(s) this PR addresses -->
<!-- Use format: AR-XXX — GitHub will auto-link to Jira -->

## Type of Change
- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Performance improvement
- [ ] Security fix
- [ ] Database migration
- [ ] Documentation update
- [ ] Refactoring (no functional changes)

## Changes
<!-- Bullet list of changes made -->

## Database Changes
<!-- If this PR includes migrations, list them here -->
- [ ] New migration(s): `supabase/migrations/NNNN_*.sql`
- [ ] RLS policies added/modified
- [ ] Types regenerated (`npm run gen:types`)
- [ ] Seed data updated

## Testing
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run lint` passes
- [ ] `npm run test` passes
- [ ] `npm run lint:copy` passes (no banned terms)
- [ ] New tests added for changes
- [ ] E2E tests updated (if user-facing flow changed)

## Staging Evidence Tier
<!-- Pick the lowest truthful tier. The CI gate computes the minimum from changed files; labels do not bypass it. Copy the matching block from docs/staging/PR_TEMPLATE.md. -->
- [ ] T0: docs/tests/CI/tooling-only; no staging evidence block required
- [ ] T1: low-risk expedited path; 2h soak + exact PR head SHA + staging tag/N/A + health/smoke + CI/E2E green + rollback plan + risk rationale + human approver
- [ ] T2: public API, worker behavior, queues, AI behavior, anchoring, billing; merge-grade staging soak with exact SHA evidence
- [ ] T3: migrations, data integrity, concurrency/fan-out, security, chain/treasury; longer soak plus clean-mirror or isolated staging

## Staging Soak Evidence
<!-- T0 may leave this section empty. T1/T2/T3 must use docs/staging/PR_TEMPLATE.md exactly. -->
<!-- Approved release candidates may use `RC manifest path: docs/staging/rc-manifests/rc-*.json` instead of duplicating long soak evidence in each PR body. -->

## Screenshots
<!-- For UI changes, include desktop (1280px) and mobile (375px) screenshots -->

## Deployment Notes
<!-- Any special deployment steps, env vars, or infrastructure changes needed -->
