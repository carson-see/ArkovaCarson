# Isolated Soak-Rig Automation — Runbook (S0-4.1 / epic S0-E4)

> **Engineering runbook, not Confluence documentation.** Per CLAUDE.md §0 rule 4
> the canonical S0-E4 spec lives in the Sprint 0 doc + the Sprint-0 AUDIT
> Confluence page. This file is the operational how-to for the two scripts that
> provision and tear down *isolated* soak rigs, plus the Carson-gated checklist
> for the live "2 concurrent T3 soaks" rehearsal (subtask 3 of S0-4.1).

## What this is for

The standing shared rig (`arkova-staging`, project ref `ujtlwnoqfhtitcmsnrpq`)
serializes most soaks through Cloud Run tag URLs + a per-PR lease
(`scripts/staging/claim.sh`). That works for PRs that can **truthfully share one
clean DB state**. It does **not** work for PRs that mutate migrations, RLS,
schema, cron behaviour, queue/batch semantics, or seed assumptions — those need
**exclusive clean shared staging OR a fully isolated project** (CLAUDE.md
§1.11A). Two such T3 PRs cannot honestly soak on the same DB at the same time.

These scripts create/destroy those **isolated** rigs: a standalone Supabase
project (not a preview branch — see STAGING_RIG.md "Why a standalone project")
plus its own `arkova-worker-<name>-staging` Cloud Run service.

| Script | Purpose |
|---|---|
| `scripts/staging/provision-isolated-rig.sh` | Create a clean isolated Supabase project + wired Cloud Run worker, then assert `clean_mirror`. |
| `scripts/staging/teardown-isolated-rig.sh` | Delete (or flag-for-Carson) the project + delete the Cloud Run service + its scheduler jobs. |

Related: `docs/reference/STAGING_RIG.md` (shared-rig ops), CLAUDE.md §1.11 /
§1.11A / §1.12 (staging mandate, contamination control, tier matrix), §7
(infra-cost sweep + the "paid projects can't be MCP-paused" fact).

## Safety model (read before running anything)

Both scripts are built around the S0-E4 pre-mortem risk **P3** ("someone runs
provision and it creates a paid project by accident"):

1. **`--dry-run` is the DEFAULT.** With no flags the script prints the exact
   plan (every `gcloud` / `supabase` command it would run) and **mutates
   nothing**. This is the safe, repeatable way to review a plan.
2. **A live run requires BOTH an explicit flag AND a matching confirm env var:**
   - Provision: `--apply` **and** `CONFIRM_PROVISION=<rig-name>` (must equal `--name`).
   - Teardown: `--apply` **and** `CONFIRM_TEARDOWN=<project-ref>` (must equal `--project-ref`).
   A wrong/missing confirm exits non-zero before any mutation.
3. **Prod + shared staging are HARD-DENIED (exit 1):**
   - Prod Supabase ref `vzwyaatejekddvltxyye` — never created/deleted.
   - Shared staging ref `ujtlwnoqfhtitcmsnrpq` — teardown refuses it (use
     `scripts/staging/teardown-and-reset.sh` to reset shared staging instead).
   - Shared Cloud Run services `arkova-worker` and `arkova-worker-staging` — refused.
   - Reserved rig names (`staging`, `worker`, `prod`, …) are refused by provision.
4. **Cost-gated.** Each isolated project is a $10/mo Supabase Pro project.
   Provision emits the `get_cost → confirm_cost → create_project` step; only spin
   one up when a soak genuinely needs isolation, and tear it down promptly.

These scripts are T0 artifacts (tooling under `scripts/staging/`). Running a
**live** provision/teardown or the live rehearsal is a T3 infra action and is
**Carson-gated** — the train never executes `--apply`.

## Provision a rig

Dry-run first (always):

```bash
./scripts/staging/provision-isolated-rig.sh --name s0e4-lane-a
```

Review the printed plan. When Carson has approved the live run:

```bash
CONFIRM_PROVISION=s0e4-lane-a \
  ./scripts/staging/provision-isolated-rig.sh --name s0e4-lane-a --apply
```

What the live path does, in order:

1. **Create** a standalone Supabase project `arkova-soak-<name>` in `us-east-2`,
   Postgres 17.x (cost-gated). Capture the returned project ref as
   `NEW_PROJECT_REF` and confirm it is neither the prod nor shared-staging ref.
2. **Create the worker secrets** for the new project
   (`supabase-url-<name>-staging`, `supabase-service-role-key-<name>-staging`)
   from its own keys (MCP `get_publishable_keys`) — never reuse prod or shared
   staging secrets.
3. **Replay the repo schema** via `npx supabase db push --linked` (the CLI
   parser handles lettered-suffix files; the preview-branch builder does not —
   STAGING_RIG.md). Apply the extension bootstrap + enum pre-adds from
   STAGING_RIG.md "How to populate" first.
4. **Deploy** `arkova-worker-<name>-staging` on the prod-pinned image with the
   staging env deltas: `NODE_ENV=production` (Zod rejects `staging`),
   `USE_MOCKS=true`, `ENABLE_PROD_NETWORK_ANCHORING=false`, AI fraud/reports off,
   IAM-protected, `min=0/max=2`. Zero real Bitcoin exposure.
5. **Preflight:** run `scripts/ci/staging-honesty-preflight.ts --project-ref
   $NEW_PROJECT_REF`. The rig is soak-ready **only** when it reports
   `environment_type=clean_mirror`. Anything else (`soak_artifact`,
   `fixture_seeded`) means the rig is not clean — do not soak on it.

Record into the rig inventory (PR body / RC manifest): `NEW_PROJECT_REF`, Cloud
Run service + URL, image digest, and the preflight result.

## Tear down a rig

Dry-run first:

```bash
./scripts/staging/teardown-isolated-rig.sh \
  --project-ref <NEW_PROJECT_REF> \
  --service arkova-worker-s0e4-lane-a-staging
```

Live (default = delete the Supabase project):

```bash
CONFIRM_TEARDOWN=<NEW_PROJECT_REF> \
  ./scripts/staging/teardown-isolated-rig.sh \
    --project-ref <NEW_PROJECT_REF> \
    --service arkova-worker-s0e4-lane-a-staging --apply
```

The live path: deletes the Cloud Run service → deletes its Cloud Scheduler cron
jobs → reclaims the Supabase project.

### Why teardown can't just "pause" a paid project

Paid Supabase Pro projects **cannot be paused via MCP `pause_project`** — that
call needs a free-tier downgrade first (CLAUDE.md §7). So teardown gives two
honest options:

- **Default (`--apply` without `--flag-only`): delete the project.** Clean
  reclaim; use once you've confirmed no soak evidence still depends on it.
- **`--flag-only`: keep the project, print a Carson dashboard action.** Use when
  Carson wants to downgrade-then-pause or delete by hand. The script prints a
  `>>> CARSON ACTION REQUIRED <<<` block naming the ref. It does **not** delete.

```bash
CONFIRM_TEARDOWN=<NEW_PROJECT_REF> \
  ./scripts/staging/teardown-isolated-rig.sh \
    --project-ref <NEW_PROJECT_REF> \
    --service arkova-worker-s0e4-lane-a-staging --flag-only --apply
```

After teardown, run the end-of-sprint infra sweep (CLAUDE.md §7): `gcloud ai
endpoints list` + a Supabase project inventory, and confirm no orphan isolated
rigs remain.

## Carson-gated checklist — live "2 concurrent T3 soaks" rehearsal (subtask 3)

This is the S0-4.1 acceptance criterion: **prove two T3 trains can soak
concurrently on two isolated rigs without contaminating each other.** It
provisions **two real paid projects** + two Cloud Run services — a T3 infra
action. **Only Carson runs the `--apply` steps.** The train's job ends at this
checklist + the dry-run plans.

Pre-flight:

- [ ] Carson has approved the spend (2 × $10/mo Pro projects, short-lived).
- [ ] Two distinct lane names chosen (e.g. `s0e4-lane-a`, `s0e4-lane-b`); neither
      is a reserved name; neither resolves to prod/shared refs.
- [ ] `CLAUDE.md` bootstrap acknowledged this session
      (`scripts/agent/ack-claude-bootstrap.sh`).

Provision both rigs:

- [ ] Dry-run provision lane A; review plan.
- [ ] Dry-run provision lane B; review plan.
- [ ] `CONFIRM_PROVISION=s0e4-lane-a ... --apply` → capture `REF_A`, service A URL, image digest.
- [ ] `CONFIRM_PROVISION=s0e4-lane-b ... --apply` → capture `REF_B`, service B URL, image digest.
- [ ] Preflight A reports `environment_type=clean_mirror`.
- [ ] Preflight B reports `environment_type=clean_mirror`.
- [ ] Confirm `REF_A != REF_B`, both ≠ prod ref, both ≠ shared-staging ref.

Run the two soaks concurrently (each against its own rig only):

- [ ] Seed lane A (synthetic, `STG%`-namespaced) against `REF_A`.
- [ ] Seed lane B against `REF_B`.
- [ ] Start the T3 load/trigger harness on service A's URL (lane A's changed path).
- [ ] Start the T3 harness on service B's URL (lane B's changed path).
- [ ] **Isolation check:** confirm lane A traffic never reaches `REF_B`/service B
      and vice-versa — queues, audit rows, anchors, cron side-effects all stay
      within each rig. Capture per-rig counts as evidence.
- [ ] Observe T3 triggers on each rig: Trigger A fires, Trigger B fires, a daily
      flush observation, per-org isolation check (CLAUDE.md §1.12 T3 row).
- [ ] Re-run preflight on each rig mid-soak; both still `clean_mirror` (no
      cross-contamination, no stray timestamp/duplicate ledger rows).

Capture + close out:

- [ ] Record both rigs' evidence (ref, service/tag URL, worker revision, image
      digest, soak start/end, tier=T3, preflight results, trigger observations)
      per CLAUDE.md §1.11A isolated-evidence requirements.
- [ ] Rehearsal verdict logged: did 2 concurrent T3 soaks run cleanly in
      isolation? (This retires roadmap risk R-3 / pre-mortem context.)

Teardown (do not leave paid rigs running):

- [ ] Dry-run teardown A and B; review plans.
- [ ] `CONFIRM_TEARDOWN=$REF_A ... --apply` (delete) or `--flag-only` if Carson
      wants to keep it.
- [ ] `CONFIRM_TEARDOWN=$REF_B ... --apply` (delete) or `--flag-only`.
- [ ] End-of-sprint infra sweep (CLAUDE.md §7): no orphan endpoints, no orphan
      isolated Supabase rigs.

## Pitfalls

- **Don't reuse one project for two T3 soaks.** That is exactly the
  contamination §1.11A forbids — the whole point of isolation is two clean DBs.
- **Don't copy evidence across rigs/heads.** Isolated evidence must name the
  specific ref, service, revision, image digest, head SHA, and preflight result;
  any code/migration commit after the soak invalidates exact-head evidence.
- **Don't `pause_project` a paid rig and assume it stopped billing** — it can't
  be MCP-paused. Delete it, or `--flag-only` and have Carson downgrade-then-pause.
- **Don't point an isolated worker at prod or shared-staging secrets.** Each rig
  uses its own `supabase-url-<name>-staging` / `supabase-service-role-key-<name>-staging`.
