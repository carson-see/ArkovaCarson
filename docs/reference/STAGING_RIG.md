# Staging Rig — Operations Reference

> **Authoritative reference** for Arkova staging rigs. CLAUDE.md §1.11 points here. Read this before touching `scripts/staging/*` or running a soak.

## The model: isolated per-soak rigs, provisioned on demand

**There is no standing shared staging rig.** Every soak provisions its own standalone Supabase project plus its own `arkova-worker-<name>-staging` Cloud Run service, runs, produces evidence, and is torn down.

This is a correction of record, not a change of policy. The former standing rig — `arkova-staging`, project ref `ujtlwnoqfhtitcmsnrpq` — **was deleted**. Earlier revisions of this document described it as operational and told you to run `npx supabase db push --linked` against it. Those instructions targeted nothing. If you are reading a runbook, PR body, skill, or agents.md that still names `ujtlwnoqfhtitcmsnrpq` as a live target, that text is stale.

### Verified reality (2026-08-15)

Supabase projects in org `byhkazrpmivhcsuqjtva` (`list_projects`) — **three**, and only three:

| Project ref | Name | Role |
|---|---|---|
| `vzwyaatejekddvltxyye` | carson-see's Project | **PRODUCTION** — never a soak target |
| `gnkuaywlpmsaezwvlvhk` | `arkova-fullsoak-2026-08` | **FROZEN 7-day soak rig** — do not disturb |
| `ehqqearcitrgloibtjqx` | `arkova-connector-sidecar-2026-08` | connector side-rig |

`ujtlwnoqfhtitcmsnrpq` is **absent**: `curl https://ujtlwnoqfhtitcmsnrpq.supabase.co/rest/v1/` exits 6 (could not resolve host).

Cloud Run services matching `*staging*` in `us-central1`:

| Service | State |
|---|---|
| `arkova-worker-fullsoak-2026-08-staging` | frozen soak worker |
| `arkova-worker-connector-sidecar-2026-08-staging` | side-rig worker |
| `arkova-worker-staging` | **ZOMBIE** — revision `arkova-worker-staging-00294-tev`, `Ready=True`, but its `SUPABASE_URL` secret points at the deleted `ujtlwnoqfhtitcmsnrpq`. It boots against a database that is gone. Do not target it; do not read its health as staging health. |

## Provisioning a rig

`scripts/staging/provision-isolated-rig.sh` is the one command. It creates the project, replays the schema, deploys a wired worker on the prod-pinned image, seeds the baseline fixture, and requires `clean_mirror` from the preflight before it returns.

```bash
# Dry-run (the DEFAULT — mutates nothing, prints every command it would run)
./scripts/staging/provision-isolated-rig.sh --name my-soak

# Live
CONFIRM_PROVISION=my-soak \
  ./scripts/staging/provision-isolated-rig.sh --name my-soak --apply
```

Safety model (CLAUDE.md §1.11A):

* `--dry-run` is the default. A real run needs **both** `--apply` and `CONFIRM_PROVISION=<name>` matching `--name` exactly.
* Non-mock profiles (`chain`, `gemini`) additionally require `CONFIRM_REAL_CONFIG=<profile>` — a rig with real Bitcoin exposure or real model spend is never provisioned by a bare `CONFIRM_PROVISION`.
* The prod ref and the dead shared-staging ref are **hard-denied** constants in the script; it exits 1 rather than touch them.

Profiles: `mock` (default, safe — `USE_MOCKS=true`, anchoring off), `chain` (real GetBlock + WIF signer), `gemini` (real tuned model, chain still mocked). Non-mock profiles also create Cloud Scheduler jobs POSTing to `/jobs/*`, because **node-cron does not fire on a throttled (min-instances=0) Cloud Run service** — without Scheduler the "behavioral" cron paths never run and the soak degenerates to health-only.

Every profile wires the boot-critical Stripe / API-key-HMAC / cron / `FRONTEND_URL` secrets, because `config.ts`'s production Zod `superRefine` crash-loops a worker missing them — and a rig that never boots is a no-op soak, not a passing one.

## Why a standalone project (not a Supabase preview branch)

Two failure modes killed the preview-branch approach and still apply:

1. **Lettered-suffix migration builder bug.** The preview-branch builder regex is `^(\d{14}|\d{1,4})_` and silently skips files like `0055b_seed_alignment_idempotent.sql`. The next migration then runs without its prerequisites and the branch hits `MIGRATIONS_FAILED`.
2. **Cost clock on idle preview branches.** ~$0.01344/hr per branch and they do not pause when idle.

A standalone project applies migrations via the Supabase **CLI** parser, which recognises lettered suffixes natively.

## Schema replay — the corrected bootstrap

> **This section was wrong until 2026-08-15 and actively broke fresh rigs** (BUG-2026-08-12-013, findings F-3 / F-4 in `docs/staging/fullsoak-2026-08/connector-sidecar-evidence.md`). The two failures below are the ones to know about.

### Do NOT pre-create extensions (F-3)

Earlier revisions instructed a bootstrap of `CREATE EXTENSION ... pg_trgm WITH SCHEMA extensions` before `db push`. **This breaks the push.**

The squashed baseline `supabase/migrations/00000000000000_baseline_at_main_HEAD.sql` declares its own extension layout, and pins `pg_trgm` to **`public`**, not `extensions`:

```sql
--   extensions schema  → pgcrypto, uuid-ossp, http, moddatetime, pg_stat_statements
--   public schema      → pg_trgm, vector, hypopg, index_advisor, pg_repack
CREATE EXTENSION IF NOT EXISTS pg_trgm;          -- lands in public
```

and then builds indexes against `public.gin_trgm_ops`:

```sql
CREATE INDEX "idx_anchors_description_trgm" ON "public"."anchors" USING "gin" ("description" "public"."gin_trgm_ops");
```

Pre-creating `pg_trgm` in `extensions` makes the baseline's own `CREATE EXTENSION IF NOT EXISTS` a silent no-op, so the operator class never exists in `public` and the push dies at statement ~1047 with `operator class "public.gin_trgm_ops" does not exist`.

**Correct procedure: create no extensions by hand.** The baseline installs all of them, in the right schemas, matching prod. If you inherited a rig already in the broken state, the repair is `ALTER EXTENSION pg_trgm SET SCHEMA public;`.

The old enum pre-adds (`anchor_status` `SUBMITTED`/`EXPIRED`) and the "move 11 prefix-colliding migration files aside" dance are **also stale** — those migrations are inside the squashed baseline now. Do not perform them.

### Migration 0381 cannot be applied by `db push` (F-4)

`0381_docusign_envelope_metadata_lookup_indexes.sql` fails under `supabase db push` with:

```
CREATE INDEX CONCURRENTLY cannot be executed within a pipeline (SQLSTATE 25001)
```

**Root cause — it is the statement count, not `BEGIN`/`COMMIT`.** The CLI's Postgres driver sends a multi-statement migration file as a single extended-protocol **pipeline**, and Postgres treats a pipeline as an implicit transaction block. `CREATE INDEX CONCURRENTLY` is rejected inside one. A file containing exactly **one** statement is sent on its own, outside any pipeline, and applies fine. The evidence is in the repo:

| File | Executable `CREATE INDEX CONCURRENTLY` statements | `db push` |
|---|---|---|
| `0366_scrum2940_anchors_folder_id_index.sql` | 1 | applies |
| `0389_anchors_ce_registry_ctid_partial_index.sql` | 1 | applies |
| `0381_docusign_envelope_metadata_lookup_indexes.sql` | **3** | **fails, SQLSTATE 25001** |

0381's own header asserts the opposite rule — that "a bare file with only CONCURRENTLY statements and no explicit transaction applies OUTSIDE a transaction." That is true for one statement and false for three. The header is wrong; this table is right. **0381 is already applied in prod (numeric ledger head `0409`), so it must not be edited or renumbered** — per CLAUDE.md §1.2, an applied migration is never modified.

**The convention going forward: one `CREATE INDEX CONCURRENTLY` per migration file.** If you need three indexes, write three files.

**Rig workaround** — after `db push` fails on 0381, apply its three statements individually, then record the ledger row:

```bash
# Each statement standalone, outside any transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_metadata_source_envelope_id
  ON public.anchors ((metadata ->> 'source_envelope_id'))
  WHERE (metadata ->> 'source_envelope_id') IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_metadata_envelope_id
  ON public.anchors ((metadata ->> 'envelope_id'))
  WHERE (metadata ->> 'envelope_id') IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anchors_metadata_external_ref
  ON public.anchors ((metadata ->> 'external_ref'))
  WHERE (metadata ->> 'external_ref') IS NOT NULL;

-- Verify all three built (CONCURRENTLY can leave an INVALID index):
SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE indexrelid IN (
  'public.idx_anchors_metadata_source_envelope_id'::regclass,
  'public.idx_anchors_metadata_envelope_id'::regclass,
  'public.idx_anchors_metadata_external_ref'::regclass);   -- expect t, t, t
ANALYZE public.anchors;
```

Then insert the `0381` ledger row so the rig's numeric head stays contiguous and the drift gate does not see a hole. This is a **rig** ledger write on a rig you own, not a shared-staging or prod ledger repair — §1.11A's prohibition is about making dirty evidence look clean, not about standing up your own rig.

### The replay itself

```bash
export SUPABASE_ACCESS_TOKEN="$(gcloud secrets versions access latest --secret=supabase_access --project=arkova1)"
supabase link --project-ref <YOUR-RIG-REF>     # never a prod or shared ref
supabase db push --linked                       # creates every extension itself
# ... 0381 fails here; apply its three statements per the block above, then re-run.
```

`provision-isolated-rig.sh` performs the link + push as its Step 2.

## Baseline data fixture (required for `clean_mirror`)

Schema replay alone is **not enough** to pass `scripts/ci/staging-honesty-preflight.ts`. A freshly provisioned rig has an empty `anchors` table, and the preflight's **Check 5 (`submitted_anchors`)** requires `>= 1` anchor with `status='SUBMITTED'`. With zero, the rig is classified `environment_type=fixture_seeded` and the Staging Soak Evidence Gate rejects its soak as **HOLLOW** — worker healthy, exercising nothing.

```bash
supabase db query --linked --file scripts/staging/seed-baseline-fixture.sql
```

The FK/NOT-NULL/CHECK chain it satisfies:

```
auth.users(id)            <- profiles.id FKs here (ON DELETE CASCADE)
  -> auth.identities       (required by GoTrue; FK user_id -> auth.users)
  -> public.organizations  (anchors.org_id / profiles.org_id FK target)
  -> public.profiles(id)   (anchors.user_id FKs here, NOT NULL)
    -> public.anchors       status='SUBMITTED'  ← the row Check 5 counts
```

Key properties:

* **Data-only (§1.11A).** Writes NOTHING to `supabase_migrations.schema_migrations`; runs no `migration repair`.
* **Idempotent.** Every insert is `ON CONFLICT (id) DO NOTHING` on stable `seed-fixture` UUIDs.
* **Clearly synthetic.** `seed-fixture-user@seed-fixture.invalid`, `Seed Fixture Org`, UUIDs in the `5eed0000-…` range. The org name is deliberately NOT `stg`/`staging_seed_`/`test_org_`-prefixed, so the preflight's `org_topology` check counts it as an org-scoped fixture (PASS) rather than a bare seed org.
* **Status trigger.** `protect_anchor_status_transition()` rejects a non-PENDING anchor INSERT unless `get_caller_role()='service_role'`. A raw postgres connection has no JWT, so the seed sets a **transaction-local** service_role claim via `set_config('request.jwt.claims', …, true)`.
* **Use the CLI direct-DB path**, not the Management API `/database/query` endpoint — a Cloudflare integrity rule (HTTP 403, `error code: 1010`) blocks that endpoint for automated clients.

`provision-isolated-rig.sh` runs this automatically as Step 4.

> **Known preflight bug (unrelated to the fixture):** the `duplicate_names` check false-positives on `validate_api_key_rpc_hardening`, because the repo legitimately ships both `0302_` and `0303_validate_api_key_rpc_hardening.sql`. A faithful rig replays both, so the bare-`name` dedup flags it. It needs its own fix to dedup by `version` (the `NNNN` prefix) rather than `name`.

## Running a soak on your rig

1. **Provision** (above). Capture the rig's project ref, Cloud Run service name, worker revision, and image digest — the evidence block needs all of them.
2. **Preflight** — `scripts/ci/staging-honesty-preflight.ts` against your rig's ref. Require `clean_mirror`. Capture the output.
3. **Load harness** against your rig's worker URL:

   ```bash
   STAGING_API_BASE="https://<your-rig-worker-url>" \
     STAGING_CRON_SECRET="$(gcloud secrets versions access latest --secret=cron-secret --project=arkova1)" \
     npx tsx scripts/staging/load-harness.ts --mode mixed --duration 720 \
       --evidence-out docs/staging/soak-<name>.json
   ```

   **Note on `STAGING_CRON_SECRET`:** staging workers bind `CRON_SECRET` to the secret named **`cron-secret`** (the same one prod uses; *not* `cron-secret-staging`). Sourcing from `cron-secret-staging` returns 401 on every `cron`-mode request and silently degrades soak coverage.

4. **Rollback rehearsal** — for any new migration, apply its `-- ROLLBACK:` block, confirm `/health` stays green, then re-apply.
5. **Capture evidence** — fill the PR's `## Staging Soak Evidence` block per the `soak-evidence` skill: tier, exact PR head SHA, rig project ref, Cloud Run service/URL, worker revision, image digest, soak start/end, preflight result, E2E result, rollback rehearsal.
6. **Tear down** — `scripts/staging/teardown-isolated-rig.sh`.

### `claim.sh` / `deploy.sh` — lease + tag-routing

These predate the isolated-rig model. They were built for many PRs sharing **one** service via Cloud Run tag URLs, and **their defaults still point at the dead shared rig** (`deploy.sh` defaults `SERVICE=arkova-worker-staging`; `claim.sh` defaults its tag host to `arkova-worker-staging-270018525501.us-central1.run.app`). With one service per rig the lease is largely redundant, but both are overridable and still usable:

```bash
export STAGING_CLOUD_RUN_SERVICE=arkova-worker-<name>-staging
export STAGING_CLOUD_RUN_HOST=<your-rig-worker-host>
export STAGING_SUPABASE_URL=https://<your-rig-ref>.supabase.co
```

Set those before invoking either script, or you will act on the zombie.

Why tag-routing existed at all: pre-SCRUM-1803 the rig was single-tenant and the lease was advisory, so `gcloud run services update` with no tag rewrote main-URL traffic for everybody. PR #742↔#743 collided on 2026-05-08; #742↔#755 contaminated a 4h SOC 2 T2 soak ~12 min in on 2026-05-09 — both despite a held lease, because nothing checked it before deploy. Per-rig isolation removes the shared surface those collisions needed.

### Deploy-only IAM rotation

`./scripts/staging/rotate-deploy-iam.sh` — dry-run by default, prints the exact `gcloud` commands. Live mutation requires `--apply --confirm SCRUM-1821`; rollback uses `--rollback --apply --confirm SCRUM-1821`. It creates/uses `arkova-staging-deployer@arkova1.iam.gserviceaccount.com`, grants `roles/artifactregistry.reader` on `arkova-worker-images`, grants a conditioned `roles/run.developer`, grants `roles/iam.serviceAccountUser` on the runtime SA, and removes `roles/run.developer` from the default compute SA.

## Cost discipline and orphaned resources

Isolated rigs are Supabase Pro projects (~$10/month each) and they do not clean themselves up. **Tear down every rig when its soak closes.** Per CLAUDE.md §7, sweep the rig inventory at release close / end of sprint — and note that a paid project **cannot** be paused via MCP `pause_project` (that needs a free-tier downgrade first), so the options are delete, or flag it for Carson to pause from the dashboard.

### Orphaned Secret Manager pointers (founder action)

Deleting a Supabase project does **not** delete its Secret Manager entries. As of 2026-08-15, **84 of the 86** `supabase-url-*` secrets in `arkova1` resolve to project refs that no longer exist — including `supabase-url-staging` → `ujtlwnoqfhtitcmsnrpq`. Only `supabase-url-fullsoak-2026-08-staging` and `supabase-url-connector-sidecar-2026-08-staging` point at live projects.

Secret deletion is a **founder action** — this document does not authorize an agent to perform it. The current orphan set is enumerated in the PR that landed this correction; regenerate it with:

```bash
gcloud secrets list --format="value(name)" --filter="name~supabase-url-" \
  | xargs -I{} sh -c 'echo "{}|$(gcloud secrets versions access latest --secret={} 2>/dev/null)"'
# then diff the refs against Supabase `list_projects`
```

Each orphaned rig typically owns a family sharing one `<name>` suffix: `supabase-url-<name>`, `supabase-service-role-key-<name>`, and sometimes `supabase-anon-key-<name>`, `supabase-jwt-secret-<name>`, `supabase-db-password-<name>`, `ip-hash-pepper-<name>`, `health-detail-token-<name>`. Delete the family, not just the URL.

## Before you pick up rig work

If you are about to:

* **`create_branch` against the prod project ref** → STOP. Rigs are standalone projects, never preview branches off prod.
* **Hardcode `vzwyaatejekddvltxyye` (prod) in `scripts/staging/*`** → STOP.
* **Target `ujtlwnoqfhtitcmsnrpq` or `arkova-worker-staging`** → STOP. The first does not exist; the second is a zombie.
* **Touch `gnkuaywlpmsaezwvlvhk` or `arkova-worker-fullsoak-2026-08-staging`** → STOP. That is the frozen 7-day soak. Check HANDOFF.md `## Now` → `### Soaks` before assuming any rig is idle.
* **Pre-create extensions before `db push`** → STOP. The baseline does it correctly; pre-creating `pg_trgm` in `extensions` is exactly what breaks the push.
