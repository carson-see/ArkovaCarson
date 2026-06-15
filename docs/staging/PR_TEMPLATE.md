# PR body template

Copy the appropriate block into your PR description. The CI gate `staging-evidence` parses these fields line-anchored — do not reformat.

---

## T0 — CI-only (docs / tests / CI / tooling only; no soak)

No `## Staging Soak Evidence` block is required when every touched file is T0. The checker computes this from changed files; labels do not bypass the gate.

---

## T1 — Expedited smoke (low-risk config or code-only; 2h minimum)

```markdown
## Staging Soak Evidence

- Tier: T1
- PR head SHA: 40-character current PR head SHA
- Staging tag URL or N/A explanation: https://pr-NNN---arkova-worker-staging-... or not applicable - explain why
- Health/smoke result: health ok, targeted smoke green
- Soak start: YYYY-MM-DD HH:MM UTC
- Soak end: YYYY-MM-DD HH:MM UTC (at least 2h after Soak start)
- CI/E2E green: TypeCheck, Tests, E2E Tests green on current head
- Rollback plan: revert PR and redeploy previous worker image / config
- Risk rationale: explain why this is low risk and does not touch API/auth/billing/anchoring/queue/security/migrations
- Human approver: Carson
```

T1 is not a casual bypass or zero-soak lane. It is blocked for migrations, public API contracts, auth, billing, anchoring, worker behavior, queue/concurrency, chain/treasury, and security-sensitive changes.

---

## T2 — Standard merge-grade soak (public API / worker behavior / webhook / SDK / AI; 12h minimum)

```markdown
## Staging Soak Evidence

- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-NNNNN-xxx
- PR head SHA: 40-character commit SHA deployed/tested
- Base SHA: 40-character `main`/base SHA used when evidence was captured
- Base drift impact: optional; required only if `main` moved after evidence capture. Must list changed files, attest T0/CI-only no runtime/schema/migration/staging/soak/deploy impact, and name the approver.
- Staging project ref: ujtlwnoqfhtitcmsnrpq or approved isolated project ref
- Cloud Run service/tag URL: https://pr-NNN---arkova-worker-staging-...
- Image digest: sha256:...
- Evidence scope: merge-grade shared staging or merge-grade isolated staging
- Preflight timestamp: YYYY-MM-DD HH:MM UTC
- Preflight result: environment_type=clean_mirror
- Soak start: YYYY-MM-DD HH:MM UTC
- Soak end: YYYY-MM-DD HH:MM UTC
- E2E result: N/N green
- Migration applied: NNNN_short_name.sql
- Rollback rehearsed: yes — applied + rolled back via `-- ROLLBACK:` block + re-applied; app survived both transitions
- Staging deploy log id: N (from `public.staging_deploy_log` via `scripts/staging/deploy.sh`)
```

---

## T2 (frontend-only) — Vercel + view-E2E evidence (sensitive frontend surface; no worker artifacts)

Use this variant **only** when the PR is required-tier T2 *and* every changed file is purely frontend (`src/**`, no `services/worker/`, no `supabase/migrations/`, no `packages/`/`sdks/`/API-contract files). The classifier still puts such a PR at T2 because it touches a sensitive user-facing contract surface (`src/components/{anchor,api,auth,billing,public,verification,verify}/`), but a frontend-only change ships no worker image, no migration, and no deploy-log row — so it cannot produce the standard T2 worker artifacts. It satisfies T2 with a Vercel deployment/preview URL, an E2E result on the affected view, and a residual-risk note attesting that no worker artifacts exist.

If the PR touches *any* worker/migration/SDK/contract file, this variant does **not** apply — use the standard T2 (or T3) block above. Tier classification is unchanged; only the evidence form differs.

```markdown
## Staging Soak Evidence

- Tier: T2
- PR head SHA: 40-character current PR head SHA
- Vercel deployment URL: https://<your-preview>.vercel.app
- E2E result: <affected view(s)> E2E N/N green on head
- CI/E2E green: Tests, E2E Tests, TypeCheck & Lint green on current head
- Rollback plan: revert PR — additive display-only change, no data/schema/worker state to unwind

### Residual-risk note
- No worker artifacts: frontend-only PR — no Cloud Run deploy, no worker revision, no image digest, no staging deploy-log id (no server code, no migration changed)
- Surfaces touched: <the frontend views/components this PR changes>
- Approved by: <named human approver — not blank, not a placeholder>
```

---

## T3 — Critical isolated/clean soak (migrations / data integrity / concurrency / security / chain / treasury; 48h minimum)

```markdown
## Staging Soak Evidence

- Tier: T3
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-NNNNN-xxx
- PR head SHA: 40-character commit SHA deployed/tested
- Base SHA: 40-character `main`/base SHA used when evidence was captured
- Base drift impact: optional; required only if `main` moved after evidence capture. Must list changed files, attest T0/CI-only no runtime/schema/migration/staging/soak/deploy impact, and name the approver.
- Staging project ref: ujtlwnoqfhtitcmsnrpq or approved isolated project ref
- Cloud Run service/tag URL: https://pr-NNN---arkova-worker-staging-...
- Image digest: sha256:...
- Evidence scope: merge-grade shared staging or merge-grade isolated staging
- Preflight timestamp: YYYY-MM-DD HH:MM UTC
- Preflight result: environment_type=clean_mirror
- Soak start: YYYY-MM-DD HH:MM UTC
- Soak end: YYYY-MM-DD HH:MM UTC
- E2E result: N/N green
- Migration applied: NNNN_short_name.sql
- Rollback rehearsed: yes — applied + rolled back + re-applied
- Staging deploy log id: N (from `public.staging_deploy_log` via `scripts/staging/deploy.sh`)
- Trigger A fires: K (10k threshold reached at T+HH:MM, T+HH:MM, ...)
- Trigger B fires: K (clock fired at T+HH:MM, T+HH:MM, ...)
- Daily flush observation: fired YYYY-MM-DD 08:00 UTC, drained N anchors across M orgs
- Per-org isolation check: zero cross-org claims observed in the soak window
```

---

## Release-candidate manifest coverage — batched T2/T3 evidence

Use this variant only when the release owner has approved a release candidate and the long soak evidence is captured in a local, machine-readable manifest. This keeps the same `Staging Soak Evidence Gate` required check name while moving long soak evidence from many mutable PR bodies into one audited RC artifact.

The manifest must live under `docs/staging/rc-manifests/rc-*.json` in the checked-out PR tree. Do not point the PR body at external URLs or ad-hoc paths. Queue PRs using a central release manifest must be restacked onto the release-process commit first. The gate validates that the manifest covers the current PR head SHA, base/train SHA, risk tier, environment, clean preflight, soak window, approval, evidence TTL, and migration rollback/reapply proof when applicable. If `main` moves after evidence capture, do not automatically restart the soak; first classify the drift. T0 docs/tests/CI/tooling-only drift can preserve evidence with an approved `Base drift impact:` note. Runtime, schema, migration, staging, deploy, or worker-image drift requires re-scope/retest.

```markdown
## Staging Soak Evidence

- Tier: T2
- RC manifest path: docs/staging/rc-manifests/rc-YYYY-MM-DD-short-name.json
```

For T3 or migration-bearing PRs, keep `Tier: T3`. The manifest must include the migration train order plus rollback and reapply proof.
