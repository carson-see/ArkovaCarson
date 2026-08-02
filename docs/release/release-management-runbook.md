# Release Management Runbook + Stop-the-Line Rules

> **Story:** SCRUM-2898 (PI-0.5, RTE/RM lane).
> **Scope:** the operational contract the Release Manager (RM) / Release Train Engineer (RTE) follows to take a batch of soaked PRs to production. This is a *process* doc — it describes and references the real tooling and gates; it does **not** assert new prod state.
> **Companion:** [staging-parity-path.md](./staging-parity-path.md) (SCRUM-2896) — how the isolated prod-shaped rig that this runbook soaks against is stood up.
> **Sources of truth this doc obeys:** `CLAUDE.md` §1.11 / §1.11A (staging integrity), §1.12 (soak tiers), §5 (migrate-before-merge), `HANDOFF.md` (live rig/soak state), Jira (status), Confluence (docs).

---

## 0. Roles

| Role | Held by | Authority |
|---|---|---|
| RM / RTE | This lane | Owns the release calendar, soak scheduling, evidence assembly, migrate-before-merge sequencing, and **prod migration apply** (`memory/feedback_rte_owns_prod_migration_apply.md`). Never merges to `main`. |
| Merge authority | Mergify + Carson | Mergify auto-merges every tier once CI is green **and** the Staging Soak Evidence Gate passes (`CLAUDE.md` §1.13, `memory/feedback_merges_go_through_mergify.md`). Carson overrides any PR with `do-not-merge` / `work-in-progress` and holds final admin-merge authority. |
| Lane engineers | Per lane-manifest | Produce PRs; own their soak evidence body. Cross-lane changes are handoffs, not reach-ins. |

**Claude never runs `gh pr merge` / `gh pr ready` on a soak-tier PR.** The merge hook (`block-pr-merge.sh`) hard-blocks it; T1/T2/T3 readiness is Carson's flip (`memory/feedback_soak_tier_prs_are_carsons_to_merge.md`). The RM's job is to make the PR *mergeable and provably safe*, then hand off.

---

## 1. Tiered soak gates (T0–T3)

Every prod-affecting PR declares its tier in the body. The path-based detector
`scripts/ci/check-staging-evidence.ts` computes the **required** tier from the
changed files and **fails closed to the higher tier** — it can force a PR *up*,
never down. There is **no override label**; the only CI-only path is T0.

> **⚠️ TEMPORARY (founder directive 2026-08-01):** while the repository Actions
> variable `SOAK_GATE_DISABLED` is `"true"`, the CI gate short-circuits to a pass
> and none of the tier table below is enforced in CI. Run `gh variable list` to
> see the live state before relying on this section. The bypass stops being
> honored after `2026-08-16T00:00:00Z`; re-enable early with
> `gh variable set SOAK_GATE_DISABLED --body false`. Every PR merged while it is
> set owes its evidence to the post-pen-test consolidated soak.

| Tier | Trigger (path detector) | Min soak | Required evidence body fields |
|---|---|---|---|
| **T0** | Docs / tests / CI / tooling only | 0 h | `Tier:` — CI green only |
| **T1** | Low-risk config/code, no migration/API/auth/billing/anchoring/queue/chain surface | 2 h smoke | `Tier:`, `PR head SHA:`, `Staging tag URL or N/A explanation:`, `Health/smoke result:`, `CI/E2E green:`, `Rollback plan:`, `Risk rationale:`, `Human approver:` |
| **T2** | Public API, worker behavior, queues, AI behavior, anchoring, billing, webhooks, SDK/contract | 12 h + rollback rehearsal | T1 fields **plus** `Staging branch:`, `Worker revision:`, `Base SHA:`, `Staging project ref:`, `Cloud Run service/tag URL:`, `Image digest:`, `Evidence scope:`, `Preflight timestamp:`, `Preflight result:`, `Soak start:`, `Soak end:`, `E2E result:`, `Migration applied:`, `Rollback rehearsed:`, `Staging deploy log id:` |
| **T3** | Migrations, data integrity, concurrency/fan-out, security, chain/treasury, anchor lifecycle, cron-on-anchors | 48 h + multiple trigger cycles + clean-mirror or isolated staging | T2 fields **plus** `Trigger A fires:`, `Trigger B fires:`, `Daily flush observation:`, `Per-org isolation check:` |

Hard path rules the detector enforces (keep them in mind when scoping a PR):

- touch `services/worker/src/chain/` → **T3**
- touch `supabase/migrations/` → **T3**
- touch public API contracts → **T2 minimum**

**Evidence must exercise the changed behavior.** Generic synthetic load is
supporting worker-health evidence only. If the soak does not cover the PR's
changed path, the PR needs targeted staging/E2E evidence or an explicit
Carson-approved residual-risk note (`CLAUDE.md` §1.12; `memory/feedback_soak_evidence_standard.md`).

Batched T2/T3 release candidates may centralize long-soak evidence in an RC
manifest (`docs/staging/rc-manifests/rc-*.json`) while preserving per-PR
authorization, exact head SHA coverage, tier, rollback notes, and prod proof.
An RC manifest is audited evidence, not a bypass — stale heads/bases, dirty
preflight, or missing rollback/reapply proof fail the same gate.

---

## 2. The clean-mirror contract (why the shared rig is usually NOT merge-grade)

T2/T3 soak evidence is valid **only** when the database used for the soak is
clean for that PR. Before any T2/T3 soak, run the preflight against the exact
Supabase project ref the worker will use:

```bash
npx tsx scripts/ci/staging-honesty-preflight.ts \
  --project-ref <SOAK_PROJECT_REF> \
  --prod-project-ref vzwyaatejekddvltxyye \
  --format json
```

The soak is merge-grade only when it reports `environment_type=clean_mirror`
(exit 0). The preflight checks: PR-only / staging-only ledger rows, duplicate
migration names/versions, known artifact rows, missing SUBMITTED anchors, prod
ledger divergence, org topology, and prod cron facts.

The **shared** rig `arkova-staging` (`ujtlwnoqfhtitcmsnrpq`) is frequently
**below prod ledger head** (has been at `0326` while prod-bound work needs
`0341+`; see `memory/project_shared_staging_rig_lacks_0341.md`). A rig below the
required ledger head is **not a clean mirror for that PR** and its evidence is
not merge-grade. When the shared rig is dirty or behind, use an **isolated
prod-shaped rig** ([staging-parity-path.md](./staging-parity-path.md)).

> Cloud Run tag URLs isolate *worker revisions only*. They do **not** isolate
> Supabase schema, ledger rows, seed data, queues, cron side effects, or audit
> rows. Two PRs may share one rig **only** when they can truthfully share one
> clean DB state. Any PR that changes migrations, RLS, schema, cron, queue/batch
> semantics, or seed assumptions needs exclusive clean shared staging or its own
> isolated project + separately wired `*-staging` Cloud Run service.

---

## 3. Migrate-before-merge sequence (§5 + §0 rule 10)

A prod-owned numeric migration is **applied to prod before its PR merges**, not
after. This keeps the prod ledger ahead of / in step with `main` and avoids a
post-merge scramble.

1. **Soak the migration** on an isolated rig at the frozen integrated head until
   the tier clock matures (T3 = 48 h + trigger cycles). Rollback rehearsed
   (`-- ROLLBACK:` comment applied and re-applied on the rig).
2. **RM applies to prod** via Supabase MCP `apply_migration` (RM owns this —
   `memory/feedback_rte_owns_prod_migration_apply.md`; never escalate to Carson).
3. **Reconcile the ledger** immediately, in-session, per `CLAUDE.md` §0 rule 10 —
   MCP records a timestamp-style version, but the drift gate wants the numeric
   `NNNN` prefix:
   ```sql
   UPDATE supabase_migrations.schema_migrations
      SET version='NNNN'
    WHERE name='<file>' AND version !~ '^[0-9]{4}$';
   ```
   Confirm `list_migrations` shows the numeric head **before** declaring done.
   This is the *one* expected ledger write — not a `migration repair`.
4. **Then** let the PR merge (Mergify, once green + evidence gate passes). The
   pre-merge prod-apply is exempt from the SCRUM-2500 orphan-ledger audit via
   `ledger-numeric-exemptions.json` (`memory/project_orphan_ledger_audit_vs_prod_apply.md`).

Numbering: next migration = `max(main head, agents.md reservations, open-PR
migrations) + 1` — the uniqueness lint only checks `main`
(`memory/feedback_migration_number_vs_reservations.md`). Never modify an existing
migration; write a compensating one. Never `supabase db push --linked` against
prod or shared staging to make evidence look clean (§1.11A).

---

## 4. The 72 h massive-soak procedure being run this release

A release runs a **frozen-integrated-head T3 soak** on an **isolated rig +
isolated Supabase project**, then a separate **72 h E2E prod validation**. The
two are distinct: the isolated soak proves the *integrated candidate* is safe to
merge; the prod validation proves the *merged* system end-to-end against the real
network. The **method** below is durable; the **dates** for any specific release
live in `HANDOFF.md`, never baked into this runbook.

> **Current release instance** (schedule only — **source of truth is `HANDOFF.md`;
> verify there before acting**): 72 h massive isolated soak starts **~Thu
> 2026-07-23**, completes **~Sat night 2026-07-25**, **merge Sun 2026-07-26**,
> external security-expert review **Mon 2026-07-27**, ahead of the **Aug 10
> launch**. A separate pre-launch E2E prod-validation window (~Aug 5–8 per
> `HANDOFF.md`) may run against prod with independent Bitcoin-explorer
> verification (KPI #3). These dates move — re-read `HANDOFF.md` each session.

### 4a. Isolated T3 soak (per candidate / integration build)

1. **Freeze the integrated head.** Build the candidate = PR branch(es) + current
   `main` at a pinned SHA. Record it. Example currently live in `HANDOFF.md`:
   rig `arkova-worker-1552-soak`, Supabase `phohrrhdoanmtafuetjh`, ledger `0358`,
   integrated head `bfd49751`. **That rig is an ACTIVE SOAK — do not touch.**
2. **Stand up the isolated rig** (see [staging-parity-path.md](./staging-parity-path.md)
   §3): `scripts/staging/provision-isolated-rig.sh` — isolated Supabase project
   (region `us-east-2`, PG 17.x, **not** a preview branch) + wired
   `arkova-worker-<name>-staging` Cloud Run on the prod-pinned image, boot-critical
   secrets set, Cloud Scheduler jobs for behavioral cron (node-cron does not fire
   on scale-to-zero Cloud Run — `memory/project_cloudrun_inprocess_cron_gotcha.md`),
   baseline fixture seeded (≥1 SUBMITTED anchor for preflight Check 5).
3. **Preflight → require `clean_mirror`** (§2). Capture the JSON artifact.
4. **BUILD AT HEAD.** The rig's worker image must be built from the frozen head.
   A stale rig image = re-soak (`memory/feedback_soak_merge_grade_procedure.md`).
5. **Run positive controls, not just health.** For T3, the soak must observe the
   changed behavior firing: `Trigger A fires`, `Trigger B fires`, a
   `Daily flush observation`, and a `Per-org isolation check`. One seed + one
   trigger is **not** evidence — durability = volume + concurrency (pgbench) +
   edge cases + isolation, empirical (`memory/feedback_soak_evidence_standard.md`).
6. **One rig = one concurrent soak.** Serialize soaks that share a rig. Never
   write to a soaking rig to validate a fix — use a throwaway
   (`memory/feedback_no_live_soak_rig_as_validation_target.md`).
7. **Hold the clock 48 h+** (soak clock = Cloud Run worker uptime, not a probe
   loop — `memory/feedback_soak_clock_is_worker_uptime.md`; verify uptime ≥ tier
   before declaring mature). Mid-soak PRs are **frozen** — no push / redeploy /
   mutate / merge (`memory/feedback_dont_touch_soaking_prs.md`). A new commit
   invalidates the body's exact-head SHA and requires a fresh soak.
8. **Assemble exact-head evidence** (§5) and, for migrations, do the
   migrate-before-merge sequence (§3) at soak maturity.
9. **Tear down** post-merge: `scripts/staging/teardown-isolated-rig.sh` (rigs stay
   scale-to-zero until their rail fully merges, then reclaim).

### 4b. 72 h E2E prod test (Aug 5–8)

After the candidates merge, the release runs a 72 h end-to-end test against prod
per the PI-0.5 Plan of Record v2.1 runbook. This exercises the real connector →
anchor → proof path and verifies output on an independent Bitcoin explorer
(KPI #3). Runbook lives in the Plan of Record (Drive) — the RM executes it, logs
observations, and gates the release "Done" on it.

---

## 5. Exact-head evidence block

Every T2/T3 PR body carries a `## Staging Soak Evidence` section with the tier's
required fields (§1). Non-negotiables:

- **Exact head SHA.** The evidence names the exact PR head SHA and base SHA the
  soak ran. Any runtime/migration/tested-code commit after the soak invalidates
  exact-head evidence and requires a new soak (or an explicit residual-risk note).
  If a new commit lands, bump the body's head SHA via `gh pr edit`
  (`memory/feedback_pr_head_sha_in_evidence_block.md`).
- **Named isolated environment.** Isolated evidence names the Supabase project
  ref, Cloud Run service/tag URL, worker revision, image digest, PR head SHA,
  deploy log id (`public.staging_deploy_log`, written by `scripts/staging/deploy.sh`),
  soak start/end, tier, and preflight result. Evidence may **not** be copied
  across heads, services, or projects.
- **Preflight `clean_mirror`.** Dirty/diagnostic preflight is not merge-grade
  unless paired with a `### Residual-risk note` documenting the exception.

---

## 6. Merge order

1. **Migrations first, in ascending numeric order**, each prod-applied +
   ledger-reconciled (§3) before its PR merges.
2. **Stacked PRs:** merge base → delete branch → child (auto-retargets to `main`,
   preserves CI). Never manual `--base` retarget — it strands the child's CI
   (`memory/feedback_stacked_pr_retarget_drops_ci.md`).
3. **Shared-file PRs** (e.g. `copy.ts`, `ci.yml`, `agents.md`) cascade-conflict
   siblings — resolve-then-merge serially, or batch them as one RC. After any
   `agents.md` union merge, **verify the content** — the union gitattribute can
   silently drop a section (`HANDOFF.md` process findings).
4. **Don't churn the Mergify queue.** A push to a queued PR resets queue progress
   and re-runs speculative checks. Check it isn't queued before touching; dequeue
   deliberately if a change is truly needed
   (`memory/feedback_dont_churn_mergify_queue.md`).
5. Finalize the evidence body **before** queueing — a body edit after queueing
   auto-dequeues as "manually updated" (`HANDOFF.md` process findings).

---

## 7. Rollback rehearsal

For every T2/T3 migration/behavioral change, rehearse rollback **on the rig
before merge**, and record it (`Rollback rehearsed:` field):

1. Apply the migration on the isolated rig.
2. Apply the `-- ROLLBACK:` statement; confirm schema returns to the prior shape
   and the worker stays healthy on the rolled-back schema.
3. Re-apply the migration; confirm forward path is idempotent.
4. Record the observed result in the evidence block.

Prod rollback path for a bad release: revert the merge PR (forward-fix preferred
for schema — write a compensating migration, never edit history), redeploy the
worker to the prior pinned image digest, and — for a migration — apply the
compensating migration to prod + reconcile the ledger (§3).

---

## 8. Stop-the-line triggers

Stop the soak clock and mark evidence **invalid** the moment any of these appear.
Do not "push through."

| Trigger | Signal | Action |
|---|---|---|
| **Dirty preflight** | `staging-honesty-preflight.ts` ≠ `clean_mirror` (PR-only rows, dup names/versions, fixture-seeded artifact, prod divergence) | Stop. Rebuild cleanly with explicit approval, or move to a fresh isolated project. Do **not** repair/delete ledger rows or `db push --linked` to make it look clean. |
| **Base drift** | PR base SHA moved under the soak; T3 base-drift hard-fails the gate on reopen | Stop. Re-soak at the new integrated head. Reopen/close re-runs the Staging gate — do not use it to dodge base-drift (`memory/feedback_reopen_refreshes_ci_and_t3_basedrift.md`). |
| **Head drift** | A commit landed on the PR after the soak started | Evidence is stale. New soak, and bump the body head SHA. |
| **Contamination mid-soak** | Unexpected ledger rows, cross-PR writes, someone wrote to the soaking rig | Stop the clock, mark that evidence invalid, rebuild or move to isolated project. |
| **Shared rig behind ledger head** | Rig ledger < required `NNNN` for the PR | Not a clean mirror. Use an isolated rig. |
| **Worker restart during soak** | Cloud Run uptime < tier hours | Clock resets to actual worker uptime — re-run to the tier floor. |
| **Rig hollow** | Worker never booted (missing Stripe/HMAC/cron/FRONTEND_URL → config.ts Zod crash-loop) or no SUBMITTED anchor | Soak is a no-op. Fix wiring / seed fixture, restart the clock. |
| **CI red on a required check** | Any required check failing at head | Not mergeable. Fix the underlying gap — never seek a workaround (§0 rule / DoD). |

Destructive shared-staging rebuilds require explicit confirmation naming the
project ref and listing the active PRs/soaks/evidence that will be invalidated
(§1.11A). When in doubt, stop and escalate to the RM/CTO — a false-green soak is
more expensive than a re-soak (this has repeatedly cost real money;
`memory/feedback_soak_merge_grade_procedure.md`).

---

## 9. Release "Done" checklist

- [ ] All candidate PRs soaked at their tier, `clean_mirror`, exact-head evidence in body.
- [ ] Migrations prod-applied + ledger-reconciled (§3) ahead of merge.
- [ ] Rollback rehearsed for every T2/T3 change (§7).
- [ ] Merge order followed; `agents.md`/shared-file content verified post-merge (§6).
- [ ] Worker revision on prod matches the merged head (`gcloud run services describe` + `/health`).
- [ ] 72 h E2E prod test executed, independent-explorer verification captured (§4b).
- [ ] Jira transitioned, Confluence current, bug tracker updated, HANDOFF.md refreshed with verified claims.
- [ ] Isolated rigs torn down (§4a step 9).

---

_Last refreshed: 2026-07-22 by RTE (SCRUM-2898). Process/reference doc — no prod-state claims; all live rig/soak/ledger facts defer to HANDOFF.md and are cited there with verification._
