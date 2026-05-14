# PR body template

Copy the appropriate block into your PR description. The CI gate `staging-evidence` parses these fields line-anchored — do not reformat.

---

## T1 — Smoke (frontend / additive read-only / no DB; 2h minimum)

```markdown
## Staging Soak Evidence

- Tier: T1
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-NNNNN-xxx
- Soak start: YYYY-MM-DD HH:MM UTC
- Soak end: YYYY-MM-DD HH:MM UTC
- E2E result: N/N green
```

---

## T2 — Standard (migration / API surface / webhook / SDK; 12h minimum)

```markdown
## Staging Soak Evidence

- Tier: T2
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-NNNNN-xxx
- Soak start: YYYY-MM-DD HH:MM UTC
- Soak end: YYYY-MM-DD HH:MM UTC
- E2E result: N/N green
- Migration applied: NNNN_short_name.sql
- Rollback rehearsed: yes — applied + rolled back via `-- ROLLBACK:` block + re-applied; app survived both transitions
- Staging deploy log id: N (from `public.staging_deploy_log` via `scripts/staging/deploy.sh`)
```

---

## T3 — Critical (anchors / batch / treasury / cron-on-anchors / billing; 48h minimum)

```markdown
## Staging Soak Evidence

- Tier: T3
- Staging branch: arkova-staging
- Worker revision: arkova-worker-staging-NNNNN-xxx
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
