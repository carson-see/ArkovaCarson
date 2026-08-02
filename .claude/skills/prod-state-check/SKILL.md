---
name: prod-state-check
description: How to establish what is actually live in Arkova production before making any claim about it — worker revision and deploy freeze, feature flags, migration ledger head, anchor and proof counts, org and credit state. Use before asserting prod state, before closing a Jira issue as Done, when writing a HANDOFF entry that claims prod, or whenever a doc, PR body, or code comment says something is live.
---

# Establish prod state directly

Never infer prod from code, a PR body, a doc, an agents.md, or a Jira comment. Those record intent; only prod records prod. Every claim in HANDOFF asserting prod state must link the artifact that proves it — the `handoff-claims` CI job enforces this.

The failure mode this prevents is specific and recurring: something merges, everyone treats it as live, and prod is running an older revision. Merged is not deployed. Deployed is not enabled.

## Prod identifiers

- Supabase project ref: `vzwyaatejekddvltxyye`
- Worker: Cloud Run `arkova-worker`
- App: `app.arkova.ai`

## 1. What revision is actually running

```bash
curl -s https://<worker-host>/health | jq '{git_sha, uptime, env}'
```

Compare `git_sha` to `origin/main`:

```bash
git log --oneline origin/main | head -1
git rev-list --count <prod_sha>..origin/main   # how far behind prod is
```

**Check the deploy freeze.** If `DEPLOY_WORKER_PAUSED=true` in `.github/workflows/deploy-worker.yml`, merges are not reaching prod at all and the gap will keep growing. As of 2026-08-01 this was deliberately set pending the signet soak, leaving prod ~52 commits behind main. Under that condition, "merged to main" tells you nothing about prod.

Also confirm via `gcloud run services describe arkova-worker --region <region> --format='value(status.latestReadyRevisionName)'` when gcloud is working. A service sitting on a non-tip SHA may be a deliberate in-flight soak, not drift — check HANDOFF before "fixing" it.

## 2. Feature flags

Flags are DB state, not code. A flag default in `config.ts` is an assertion, not reality, and `check-config-drift.ts` compares committed snapshots rather than live prod — it cannot answer this for you.

```sql
SELECT flag_key, enabled, updated_at FROM switchboard_flags ORDER BY flag_key;
```

An empty `switchboard_flags` table fails closed: `get_flag` returns false and `/api/v1` goes dark. A fresh environment is dark until seeded.

## 3. Migration ledger

```sql
SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 10;
```

Two things to check: the numeric head, and whether any prod row has no matching `supabase/migrations/NNNN_*.sql` on main (an orphan — a migration reached prod before its source landed). Orphans are tracked in `scripts/ci/snapshots/ledger-numeric-exemptions.json`; each exemption should be removed once its owning PR merges.

Do not trust a migration file's presence on main as evidence it ran. Read the file header — some carry an explicit `STATUS: FILE-ONLY / PRE-SOAK / NEVER-APPLIED` marker, and at least one Jira comment has claimed prod-applied for a migration whose own header said otherwise.

## 4. Data claims

```sql
SELECT count(*) FROM anchors WHERE status = 'SECURED';
SELECT count(*) FROM anchor_proofs;          -- proofs STORED, not the same number
SELECT count(*) FROM anchors WHERE status = 'PENDING_ANCHORING';
```

Anchored and proof-materialized are different populations; quoting one for the other overstates completeness. Similarly, an org's `anchor_quota` is a **grant**, not usage — never cite a quota as evidence of issued anchors.

## 5. Org / partner state

```sql
SELECT o.public_id, o.tier, c.anchor_quota, c.is_test,
       (SELECT count(*) FROM anchors a WHERE a.org_id = o.id) AS anchors
FROM organizations o LEFT JOIN org_credits c ON c.org_id = o.id
WHERE o.public_id = '<id>';
```

`org_credits.is_test` distinguishes a real grant from a fixture. Check `auth.users.last_sign_in_at` before describing an account as active — a provisioned account that has never signed in is not a user.

## Reporting rules

- Quote the artifact: the `/health` output, the SQL result, the gcloud line, the CI run URL.
- Date it. Prod state is a snapshot, and yours goes stale.
- If you could not verify, say "unverified" — never round up to "should be live."
- Read-only by default. Writing to prod is an operator action; a soaking rig is never a validation target.

## Related

`memory/feedback_assert_prod_state_directly.md`, `memory/feedback_soak_clock_is_worker_uptime.md`, `memory/feedback_frozen_soak_head_not_orphan.md`, `.claude/skills/task-gates/SKILL.md`.
