# Release Candidate Manifests

Release-candidate manifests centralize long T2/T3 soak evidence for an approved release train. They do not replace PR review, CI, risk tiering, or rollback planning. They let the existing `Staging Soak Evidence Gate` accept one audited RC record instead of forcing every included PR to duplicate long soak fields in its body.

## PR Body

Use this block after the release owner approves the RC:

```markdown
## Staging Soak Evidence

- Tier: T3
- RC manifest path: docs/staging/rc-manifests/rc-YYYY-MM-DD-short-name.json
```

The path must match `docs/staging/rc-manifests/rc-*.json`. External URLs and arbitrary paths are rejected.

## Required Fields

- `schema_version`: currently `1`.
- `rc_id`, `created_at`, `created_by`, `release_owner`.
- `approval_status`: must be `approved`.
- `approval_actor`, `approval_time`.
- `train_launch_sha`: frozen base SHA when the train starts.
- `target_main_sha`: expected current base SHA, or use `allowed_base_shas` / `covered_main_shas` when the train advances through known included PRs.
- `included_prs`: PR number, exact head SHA, base SHA, risk tier, owner, CI summary, rollback note, and migration files when applicable.
- `environment`: staging URL/API base, Cloud Run service/revision/tag, image digest, Supabase project ref, deploy log id, evidence scope, and clean preflight result.
- `soak`: start, end, duration, harness version, result, evidence links, and `expires_at`.
- `migration_plan`: required for T3 or migration-bearing PRs; includes order, rollback proof, reapply proof, and stop conditions.

## Gate Behavior

If `RC manifest path:` is absent, the gate uses the existing per-PR evidence rules. If present, the gate validates the manifest and fails closed on stale heads, stale bases, dirty preflight, expired evidence, missing approval, missing deploy provenance, or missing migration rollback/reapply proof.
