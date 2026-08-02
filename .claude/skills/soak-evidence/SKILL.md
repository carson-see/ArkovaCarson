---
name: soak-evidence
description: Assemble or repair the "## Staging Soak Evidence" block a PR needs to pass the Staging Soak Evidence Gate. Use when opening a prod-affecting PR, when the staging-evidence CI job or the pre-merge hook fails, when deciding a PR's soak tier (T0-T3), or when a PR is blocked from Draft -> Ready. Covers tier selection, the required fields per tier, RC-manifest coverage, and the common format-only failures.
---

# Staging soak evidence

Enforces CLAUDE.md §1.11 / §1.11A / §1.12. There is **no override label** — `staging-soak-skip` was destroyed 2026-05-07. Two independent things check this block: the CI job (`scripts/ci/check-staging-evidence.ts`) and the local pre-merge hook (`.claude/hooks/check-staging-evidence-pre-merge.sh`).

> **⚠️ TEMPORARY (founder directive 2026-08-01): the CI half can currently be bypassed.** When the repository Actions variable `SOAK_GATE_DISABLED` is the literal string `"true"`, the CI job short-circuits to a pass without reading the PR body at all, and prints a `::warning::` saying so. It exists to drain the CI-green queue ahead of the 2026-08-02 pen test; the week-long consolidated soak that follows is what produces the deferred evidence. It stops being honored after `2026-08-16T00:00:00Z` regardless of the variable. Check the live state with `gh variable list` before telling anyone the gate cannot be skipped — while it is set, a green `Staging Soak Evidence Gate` means only that the bypass is engaged, **not** that evidence exists. The local pre-merge hook is NOT bypassed and still requires the block, so everything below still applies to `gh pr ready` / `gh pr merge`.

## First: is this actually a soak gap, or a format bug?

Most gate FAILUREs are **body format**, not missing soak work. Check format before re-running any soak. The gate needs:

1. A heading that matches exactly: `## Staging Soak Evidence` (H2, no trailing punctuation).
2. A tier line the parser recognizes: `Tier: T2`. Decoration is tolerated — `**Tier:** T2`, `- **Tier:** T2`, `* _Tier_: T3` all parse. The value set is only `T0`–`T3`.

If both are present and CI still fails, read the job output for *which field* is missing rather than guessing.

## Pick the tier

The path detector computes the required tier from changed files and **fails closed to the highest tier**. Under-declaring fails the gate; over-declaring only costs soak time. Hard rules:

| If the PR touches | Tier |
|---|---|
| `supabase/migrations/**` | **T3** |
| `services/worker/src/chain/**` | **T3** |
| Data integrity, concurrency/fan-out, security, anchor lifecycle, cron-on-anchors | **T3** |
| Public API contracts, worker behavior, queues, AI behavior, billing, webhooks, SDK surface | **T2** |
| Low-risk config/code with none of the above surfaces | **T1** |
| Docs, tests, CI, or tooling only | **T0** |

T0 is computed from changed files, not asserted. A PR that declares T0 but touches a higher-tier surface fails CI regardless of what the body says.

## Required fields

**T0** — no evidence block required; CI must be green.

**T1** (2 h soak): tier, exact PR head SHA, staging tag URL (or an explicit N/A explanation), health/smoke result, soak start + end, CI/E2E green, rollback plan, risk rationale, human approver.

**T2** (12 h soak + rollback rehearsal): everything in T1 plus exact base SHA, clean preflight result, deploy log id, E2E result, and the rollback rehearsal record.

**T3** (48 h soak, multiple trigger cycles, clean-mirror or isolated rig): everything in T2 plus Trigger A fired, Trigger B fired, daily flush observation, and a per-org isolation check.

## Non-negotiables

- **The soak must exercise the changed behavior.** Generic synthetic load is worker-health evidence only. If it does not cover the changed path, add targeted staging/E2E evidence or an explicit Carson-approved residual-risk note.
- **Exact head SHA.** A new commit after the soak invalidates the body's head SHA. Re-run or add a residual-risk note — do not silently reuse.
- **Preflight must be clean.** Run `scripts/ci/staging-honesty-preflight.ts` against the exact project ref the worker will use. Shared staging (`ujtlwnoqfhtitcmsnrpq`) is merge-grade only when it reports `environment_type=clean_mirror`.
- **Never soak on a dirty project**, and never write to a rig that is mid-soak for another PR.
- **Soak clock = Cloud Run worker uptime**, not a probe loop (probe loops die on restart).

## Isolated rigs

Any PR changing migrations, RLS, schema, cron behavior, queue/batch semantics, or seed assumptions needs either exclusive clean shared staging or an approved isolated Supabase project **plus** a separately wired `*-staging` Cloud Run service. Cloud Run tag URLs isolate revisions only — never schema, ledger rows, queues, or cron side effects.

Isolated evidence must name: isolated project ref, Cloud Run service/tag URL, worker revision, image digest, PR head SHA, deploy log id, soak start/end, tier, and preflight result. Evidence may not be copied across heads, services, or projects.

## Batched releases

Long soak evidence may be centralized in `docs/staging/rc-manifests/rc-*.json` while preserving per-PR authorization, CI, tier, exact head SHA coverage, rollback notes, and production proof. RC manifests are audited evidence, not a bypass — stale heads/bases, dirty preflight, expired evidence, or missing migration rollback/reapply proof fail the same gate.

## Template

```markdown
## Staging Soak Evidence

**Tier:** T2
- **PR head SHA:** <40-char>
- **Base SHA:** <40-char>
- **Staging project ref:** <ref>  (preflight: clean_mirror)
- **Cloud Run service / tag URL:** <service> / <url>
- **Worker revision / image digest:** <rev> / <sha256:...>
- **Deploy log id:** <id>
- **Soak start -> end:** <ISO> -> <ISO>  (clock = worker uptime)
- **Behavior exercised:** <what the soak actually drove that this PR changes>
- **Health/smoke:** <result>
- **E2E / CI:** <green + run URL>
- **Rollback plan:** <steps>   **Rehearsal:** <result, T2+>
- **Risk rationale:** <why this tier>
- **Approver:** <name>
```

## Related

`memory/feedback_soak_evidence_standard.md`, `memory/feedback_soak_merge_grade_procedure.md`, `memory/feedback_dont_touch_soaking_prs.md`, `docs/reference/STAGING_RIG.md`.
