# Release-Grade Staging Parity Path

> **Story:** SCRUM-2896 (PI-0.5, RTE/RM lane).
> **Scope:** how a release-grade, prod-shaped staging environment is stood up so a soak's evidence is merge-grade — and why the shared `arkova-staging` rig is usually *not* that environment.
> **Companion:** [release-management-runbook.md](./release-management-runbook.md) (SCRUM-2898).
> **Obeys:** `CLAUDE.md` §1.11 (staging mandatory) / §1.11A (integrity + contamination control) / §1.12 (tiers). Live rig facts defer to `HANDOFF.md` and `docs/reference/STAGING_RIG.md`.

---

## 1. What "release-grade parity" means

A soak proves nothing unless the environment it runs against is a faithful,
*clean* mirror of prod **at the ledger head the change requires**. Parity has
three axes, and all three must hold:

1. **Schema parity** — the rig's migration ledger head ≥ the head the PR's
   migration builds on. A rig behind head runs the PR's migration without its
   prerequisites (or not at all).
2. **Runtime parity** — the worker runs the **prod-pinned Docker image**,
   `NODE_ENV=production` (the same codepath as prod, just a different DB), with
   the boot-critical secrets wired so `config.ts`'s Zod `superRefine` does not
   crash-loop it.
3. **Cleanliness** — no PR-only ledger rows, no leftover fixtures, no duplicate
   migration names/versions, no prod divergence. Verified by the preflight
   returning `environment_type=clean_mirror`.

Cloud Run tag URLs give you **runtime isolation only**. They do **not** isolate
Supabase schema, ledger rows, seed data, queues, cron side effects, or audit
rows. So parity of the *database* is a property of the Supabase project, not of
the worker revision.

---

## 2. Why `arkova-staging` (ledger 0326) is NOT merge-grade for prod-bound work

The shared rig `arkova-staging` (`ujtlwnoqfhtitcmsnrpq`, `us-east-2`;
`docs/reference/STAGING_RIG.md`) is a real standalone Supabase project — not a
preview branch — and is fine for **health / synthetic worker soaks**. It is
**not** automatically merge-grade for a specific PR, for two reasons:

1. **It drifts behind the ledger head.** It has sat at ledger `0326` while
   credit-ledger and materializer work needs `0341+` / `0358+`
   (`memory/project_shared_staging_rig_lacks_0341.md`,
   `HANDOFF.md` migration band). A rig below the required `NNNN` cannot exercise
   the PR's changed schema, so the preflight's prod-divergence / duplicate checks
   fail or the change simply can't run. **Behind head = not a clean mirror for
   that PR.**
2. **It is shared, so it contaminates.** Parallel soaks, fixture seeding, prior
   PR ledger rows, and cron side effects accumulate. `soak_artifact`,
   `fixture_seeded`, timestamp-version rows, duplicate names/versions, or PR-only
   rows all make the project invalid for **new** merge evidence until reconciled
   (`CLAUDE.md` §1.11A). Its worker template can also drift onto dead-rig secrets
   (`memory/project_staging_worker_secret_drift.md`), breaking new tagged soaks.

Consequently: any PR that **changes migrations, RLS, schema, cron behavior,
queue/batch semantics, or seed assumptions** needs either **exclusive** use of a
clean shared rig **or an isolated project** (below). Docs/tests/CI/tooling-only
(T0) PRs need no staging at all; low-risk T1 code can smoke on the shared rig if
it's clean at the time.

> **Do not** run `supabase db push --linked` against, reset, or repair the ledger
> of shared staging to make evidence look clean unless Carson/operator explicitly
> approves the exact operation (§1.11A). Fabricated cleanliness is a
> stop-the-line event, not a shortcut.

---

## 3. Standing up an isolated prod-shaped rig

The isolated-rig path is the release-grade default when the shared rig is behind
head or contended. One command provisions a clean, isolated, wired rig:

```bash
# DEFAULT is --dry-run (mutates nothing). A real run needs --apply + confirms.
scripts/staging/provision-isolated-rig.sh \
  --name <candidate> \
  --profile mock            # mock | chain | gemini
  # real run adds: --apply  CONFIRM_PROVISION=<candidate>
  #                (chain/gemini also need CONFIRM_REAL_CONFIG=<profile>)
```

What it does (`scripts/staging/provision-isolated-rig.sh`):

1. **Create a standalone Supabase project** — region `us-east-2`, PG 17.x. **Not**
   a preview branch: the preview-branch builder regex `^(\d{14}|\d{1,4})_`
   silently skips lettered-suffix files like `0055b_…` → migration 0056 runs
   without prerequisites → `MIGRATIONS_FAILED` (`docs/reference/STAGING_RIG.md`
   "Why a standalone project"). A standalone project applies migrations via
   `npx supabase db push --linked`, which uses the CLI parser and recognizes
   lettered suffixes natively.
2. **Replay the repo schema** onto it up to the frozen integrated head's ledger.
3. **Deploy a wired `arkova-worker-<name>-staging`** Cloud Run service on the
   **prod-pinned image**, with a profile-selected env/secret overlay:
   - `mock` (default, safe): `USE_MOCKS=true`, `ENABLE_PROD_NETWORK_ANCHORING=false`
     — zero real Bitcoin exposure; health/synthetic soaks.
   - `chain`: real GetBlock RPC + WIF signer — for anchoring / batch-anchor
     behavioral soaks.
   - `gemini`: real tuned model — for classifier / census soaks (chain stays mocked).
   **Every** profile also wires boot-critical secrets (Stripe / API-key HMAC /
   cron / `FRONTEND_URL`) so `config.ts` doesn't crash-loop the worker — a rig
   that never boots is a no-op soak (`memory/project_isolated_rig_deploy_env.md`).
4. **Wire Cloud Scheduler jobs** (non-mock profiles) POSTing to the worker's
   `/jobs/*` endpoints — node-cron does **not** fire on a throttled
   (min-instances=0) Cloud Run service, so without Scheduler the behavioral cron
   paths never run and the soak degenerates to health-only
   (`memory/project_cloudrun_inprocess_cron_gotcha.md`).
5. **Seed the baseline fixture** (`scripts/staging/seed-baseline-fixture.sql`) so
   the rig has ≥1 SUBMITTED anchor — required for preflight Check 5. Data-only
   insert; touches no migration ledger (§1.11A). Without it the rig is
   `fixture_seeded` and the soak is hollow.
6. **Run the preflight and require `clean_mirror`** before the soak clock starts.

Safety model (the whole point of the script): `--dry-run` is the default; a real
run needs `--apply` **and** `CONFIRM_PROVISION=<name>` (and
`CONFIRM_REAL_CONFIG=<profile>` for chain/gemini). The prod ref
(`vzwyaatejekddvltxyye`) and the shared staging services are **hard-denied** —
the script exits 1 rather than touch prod or shared staging.

Teardown when the rail fully merges: `scripts/staging/teardown-isolated-rig.sh`
(also `--dry-run` by default; real run needs `--apply` +
`CONFIRM_TEARDOWN=<project-ref>`). Paid Supabase projects can't be MCP-paused, so
it either deletes the project or `--flag-only` prints a Carson dashboard action.

> A live example is running now (see `HANDOFF.md`): rig `arkova-worker-1552-soak`,
> isolated Supabase `phohrrhdoanmtafuetjh`, ledger `0358`, integrated head
> `bfd49751`. **That rig is an ACTIVE SOAK — do not touch it, its Supabase
> project, or its scheduler jobs.**

---

## 4. The `clean_mirror` preflight contract

`scripts/ci/staging-honesty-preflight.ts` is the gate between "a rig exists" and
"this rig's soak is merge-grade." Run it against the **exact project ref the
worker uses**:

```bash
npx tsx scripts/ci/staging-honesty-preflight.ts \
  --project-ref <SOAK_PROJECT_REF> \
  --prod-project-ref vzwyaatejekddvltxyye \
  --format json
```

It runs eight checks and exits 0 only when **all** pass — reported as
`environment_type=clean_mirror`:

| # | Check | Fails when |
|---|---|---|
| 1 | PR-only / staging-only rows | timestamp-version rows or `pr###_` / `staging_purge_` / `staging_only_` prefixed ledger rows present |
| 2 | Duplicate migration names | same migration name applied twice |
| 3 | Duplicate migration versions | same version twice |
| 4 | Known artifact rows | hardcoded leftover-artifact list matches |
| 5 | Missing SUBMITTED anchors | no seeded SUBMITTED anchor (rig would be `fixture_seeded`/hollow) |
| 6 | Prod ledger divergence | rig ledger diverges from prod (behind head, or unexplained rows) |
| 7 | Org topology | staging seeds don't match single-tenant-prod vs multi-org expectation |
| 8 | Prod cron facts | expected pg_cron jobs (`vacuum-anchors`, `refresh_pipeline_dashboard_cache`) absent |

**Contract:** shared-staging evidence from `ujtlwnoqfhtitcmsnrpq` is merge-grade
**only** when the preflight reports `clean_mirror`. Isolated-project evidence is
merge-grade when the preflight reports `clean_mirror` **and** the evidence names
the isolated ref, service/tag URL, worker revision, image digest, PR head SHA,
base SHA, deploy log id, soak start/end, tier, and preflight result/timestamp
(the T2/T3 fields the `check-staging-evidence.ts` gate enforces). A dirty or
diagnostic preflight is not merge-grade unless paired with an explicit,
Carson-approved `### Residual-risk note`.

The preflight is **read-only** — it never mutates the rig. Capture its JSON
output as the durable artifact and cite the `Preflight result:` /
`Preflight timestamp:` in the PR body.

---

## 5. Decision: which environment for this PR?

```
Is the PR docs/tests/CI/tooling-only?            → T0, no staging.
Is it low-risk T1 code, shared rig clean now?    → shared rig smoke (2 h), preflight clean_mirror.
Does it change migrations / RLS / schema / cron
  / queue-batch / seed, OR need ledger > shared
  rig head, OR run concurrently with another soak? → ISOLATED prod-shaped rig (§3).
Is the shared rig behind head or dirty?          → ISOLATED rig, always.
```

When in doubt, isolate. A false-green soak on a contaminated or behind-head rig
is the exact failure §1.11A exists to prevent, and it has repeatedly cost real
money and re-work.

---

_Last refreshed: 2026-07-22 by RTE (SCRUM-2896). Reference doc — no prod-state claims; live rig/ledger facts defer to HANDOFF.md and docs/reference/STAGING_RIG.md._
