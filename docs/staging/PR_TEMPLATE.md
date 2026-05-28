# PR body template

Copy the appropriate block into your PR description. The CI gate `staging-evidence` parses these fields line-anchored — do not reformat.

---

## T0 — CI-only (docs / tests / CI / tooling only; no soak)

No `## Staging Soak Evidence` block is required when every touched file is T0. The checker computes this from changed files; labels do not bypass the gate.

---

## T1 — Expedited smoke (low-risk config or code-only; no soak)

```markdown
## Staging Soak Evidence

- Tier: T1
- PR head SHA: 40-character current PR head SHA
- Staging tag URL or N/A explanation: https://pr-NNN---arkova-worker-staging-... or not applicable - explain why
- Health/smoke result: health ok, targeted smoke green
- CI/E2E green: TypeCheck, Tests, E2E Tests green on current head
- Rollback plan: revert PR and redeploy previous worker image / config
- Risk rationale: explain why this is low risk and does not touch API/auth/billing/anchoring/queue/security/migrations
- Human approver: Carson
```

T1 is not a casual bypass. It is blocked for migrations, public API contracts, auth, billing, anchoring, worker behavior, queue/concurrency, chain/treasury, and security-sensitive changes.

---

## T2 — Standard merge-grade soak (public API / worker behavior / webhook / SDK / AI; 12h minimum)

```markdown
## Staging Soak Evidence

- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-NNNNN-xxx
- PR head SHA: 40-character commit SHA deployed/tested
- Base SHA: 40-character `main`/base SHA used when evidence was captured
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

## T3 — Critical isolated/clean soak (migrations / data integrity / concurrency / security / chain / treasury; 48h minimum)

```markdown
## Staging Soak Evidence

- Tier: T3
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-NNNNN-xxx
- PR head SHA: 40-character commit SHA deployed/tested
- Base SHA: 40-character `main`/base SHA used when evidence was captured
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
