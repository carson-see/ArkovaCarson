# Staging rig rebuild — 2026-08-19

**Tier: T0** (docs/reference only — `docs/reference/STAGING_RIG.md` + this file; zero
`.ts`/`.tsx`/`.js`/`.sql`/`.yml`/`.toml`/`.json` changes; no CLAUDE.md rule changes).
Founder-approved new Supabase project ("new rig is fine", 2026-08-19).

## Why

The standing `arkova-staging` rig (Supabase project `ujtlwnoqfhtitcmsnrpq`) no longer
existed. A same-day prior session (`soak/day0-fullsoak-2026-08-docs` branch, commit
`d0305b6d5`) diagnosed this exhaustively before stopping per its own task boundary
("do NOT provision a new Supabase project without explicit approval") — see
`docs/staging/ratelimit-soak-2026-08/soak-standup-attempt-2026-08-19.md` on that branch
for the full trail: `list_projects` omitted the ref, `get_project` returned a
permission error consistent with non-existence, DNS was NXDOMAIN for
`ujtlwnoqfhtitcmsnrpq.supabase.co`, and the live `arkova-worker-staging` service was
returning HTTP 503 `{"checks":{"database":"error"}}`. This session had explicit
founder approval to rebuild, so it proceeded.

The Cloud Run service `arkova-worker-staging` was **kept** (its name is referenced by
CI — `.github/workflows/deploy-staging.yml`, `.github/workflows/verify-worker-runtime.yml`)
and **re-pointed** at the new Supabase project rather than recreated.

## New Supabase project

| Field | Value |
|---|---|
| Project ref | `fizyjojbebyalirtjjht` |
| Name | `arkova-staging-2026-08` |
| Organization | `byhkazrpmivhcsuqjtva` |
| Region | `us-east-2` (matches prod and the original rig, per `STAGING_RIG.md`) |
| Postgres | 17.6.1.155 |
| Created | 2026-08-19T19:39:28Z |
| Cost | $10/month — confirmed via Supabase MCP `get_cost` (`{"type":"project","recurrence":"monthly","amount":10}`) then `confirm_cost` (confirmation id `BGoZHqqJd2JYMt+cWSDFH7qDeNkZZAwbTytJrHy7r+E=`) before `create_project` was called. No other cost was incurred by this rebuild (secrets, Cloud Build, and Cloud Run redeploy are all inside existing billing). |

## Schema replay

Followed `docs/reference/STAGING_RIG.md`'s replay procedure, adapted where reality had
moved on since the doc was last written (see the "2026-08-19 rebuild gotchas"
subsection added to that doc in this same PR for the full list — stale prefix-collision
file set, `pg_trgm` schema placement, multi-statement `CREATE INDEX CONCURRENTLY`
pipelining, IPv6-only direct DB host, DB password not surfaced by `create_project`,
and a newly-required `IP_HASH_PEPPER` production secret).

- Bootstrapped `uuid-ossp` / `pgcrypto` in `extensions`, `pg_trgm` in `public`
  (matches prod's actual extension schema placement, verified via MCP `list_extensions`
  against `vzwyaatejekddvltxyye`).
- `npx supabase db push --linked --include-all --yes` from a checkout of `origin/main`
  (worktree HEAD `b6cfad73c73fbaf45bea08e3b155d61501a49daa`, 0 commits ahead/behind
  `origin/main` at the time) applied 109 of 111 migrations cleanly.
- Two files with multiple `CREATE INDEX CONCURRENTLY` statements
  (`0381_docusign_envelope_metadata_lookup_indexes.sql`,
  `0389_anchors_ce_registry_ctid_partial_index.sql`) were set aside, applied
  individually via `psql` against the session pooler
  (`aws-0-us-east-2.pooler.supabase.com:5432`, user `postgres.fizyjojbebyalirtjjht`),
  then restored to the working tree byte-identical (`git status --short` confirmed
  clean — no migration file content was modified, per CLAUDE.md §1.2). Their ledger
  rows were inserted manually to match the CLI's own naming convention for
  neighboring rows.
- Seeded the baseline fixture (`scripts/staging/seed-baseline-fixture.sql`) via the
  same session-pooler connection — 5 rows (auth user, identity, org, profile, one
  `SUBMITTED` anchor).

### Ledger convergence with prod

`list_migrations` against the new project returns **111 rows**, versions
`00000000000000` (baseline) + `0290`–`0409` (with the same gaps prod itself carries:
`0291`, `0298`, `0332`, `0344`, `0361`, `0369`, `0371`–`0374`). Diffed programmatically
against a fresh `list_migrations` read of prod (`vzwyaatejekddvltxyye`) taken the same
session: **`prod - new = {}`, `new - prod = {}`** — exact set match. Prod's live ledger
head is `0409` (`lock_wait_observability_rpc`); this matches `origin/main`'s highest
migration file prefix at the time of replay, so the rig reflects both prod's real state
and the current repo simultaneously.

## Preflight (`scripts/ci/staging-honesty-preflight.ts`)

Run against `fizyjojbebyalirtjjht` after schema replay + fixture seed:

```json
{
  "environment_type": "clean_mirror",
  "staging_project_ref": "fizyjojbebyalirtjjht",
  "timestamp": "2026-08-19T19:52:36.257Z",
  "checks": [
    { "name": "staging_only_rows", "passed": true },
    { "name": "duplicate_names", "passed": true },
    { "name": "duplicate_versions", "passed": true },
    { "name": "known_artifacts", "passed": true },
    { "name": "submitted_anchors", "passed": true, "details": "1 SUBMITTED anchor(s) found." },
    { "name": "prod_divergence", "passed": true, "details": "Rig ledger reconciles with repo migration files + canonical baseline." }
  ]
}
```

All 6 checks passed; `environment_type=clean_mirror` — the target state required by
CLAUDE.md §1.11A before any T2/T3 soak can use this rig as merge-grade evidence.

## Cloud Run re-point

**Secrets updated** (new versions added, old versions retained for rollback):
`supabase-url-staging` (v1→v2, now `https://fizyjojbebyalirtjjht.supabase.co`) and
`supabase-service-role-key-staging` (v1→v2, the new project's legacy JWT
`service_role` key — pulled via the Management API `/v1/projects/{ref}/api-keys?reveal=true`
`legacy` entry, not the new `sb_secret_...` key format, to match what
`services/worker/src/config.ts` expects). `SUPABASE_JWT_SECRET` stays pointed at the
shared prod secret, unchanged, per the existing documented deviation. The new
project's DB password was set via `PATCH /v1/projects/{ref}/database/password` (not
surfaced by `create_project`) and stored as `supabase-db-password-fizyjojbebyalirtjjht`
in Secret Manager for future sessions.

**Image**: built fresh from `services/worker` at `origin/main`
(`b6cfad73c73fbaf45bea08e3b155d61501a49daa`) via Cloud Build (`gcr.io/cloud-builders/docker`,
linux/amd64 — Cloud Build workers are amd64 by default, no local Docker platform issue).

| Field | Value |
|---|---|
| Cloud Build ID | `72b63c69-1246-4c18-be72-4685a1e75fe5` |
| Build duration | 2026-08-19T19:46:49Z → 2026-08-19T19:50:46Z (SUCCESS) |
| Image | `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:staging-rebuild-b6cfad73` |
| Image digest | `sha256:07742aceedbfbbad398d4e26f75dd9a29186991c0f4d0adc561b09b7e73f192d` |

**Deploy gotcha found and fixed in-session**: the first deploy attempt crash-looped
(`arkova-worker-staging-00251-hqt`, retired) with `Error: Invalid worker configuration`
— `services/worker/src/config.ts`'s boot-time `superRefine` now requires
`IP_HASH_PEPPER` in production (added after this service was last redeployed;
secret `ip-hash-pepper` exists in Secret Manager since 2026-08-11 for prod but was
never wired to staging). Fixed by adding
`--update-secrets=IP_HASH_PEPPER=ip-hash-pepper:latest` to the service and
redeploying. `MEMPOOL_API_URL` was verified **not set** both before and after (per
CLAUDE.md's documented staging gotcha — setting it has frozen prior soaks).

**Traffic routing gotcha**: `arkova-worker-staging` pins its 100%-traffic slice to an
explicit revision name (inherited from ~45 historical PR-tagged deploys), not the
`LATEST` indirection — so `gcloud run services update --image=...` creates a new
revision but does **not** move traffic to it, and the CLI's own printed summary line
("revision ... has been deployed and is serving N percent of traffic") is misleading
in this configuration (it echoed a stale, unrelated revision name on two separate
deploys in this session). Verified the real new revision via
`gcloud run revisions list --sort-by="~metadata.creationTimestamp"` each time, then
moved traffic explicitly with `update-traffic --to-revisions=<name>=100`. None of the
~45 stale PR-tag routes (`pr-810` … `pr-1459`, plus a few `train-*` lanes) were
touched — all remain at 0%.

### Final verified state

| Field | Value |
|---|---|
| Serving revision | `arkova-worker-staging-00252-696` |
| Traffic | 100% (main URL), all historical PR/lane tags unchanged at 0% |
| `/health` (main URL, identity-token auth) | `{"status":"healthy","version":"0.1.0","git_sha":"b6cfad73c73fbaf45bea08e3b155d61501a49daa","uptime":32,"network":"mainnet","checks":{"database":"ok","anchoring":"ok","kms":"ok"}}` — HTTP 200 |
| `git_sha` | `b6cfad73c73fbaf45bea08e3b155d61501a49daa` — exact `origin/main` tip at rebuild time |

## Not touched (per task boundary)

- **Prod** (`vzwyaatejekddvltxyye`, `arkova-worker`) — read-only comparisons only
  (extension schema check, ledger-head diff for convergence verification).
- **The fullsoak rig** — `arkova-worker-fullsoak-2026-08-staging` and Supabase project
  `gnkuaywlpmsaezwvlvhk` (48h SOC 2 soak running per `HANDOFF.md` `## Now` →
  `### Soaks`, started 2026-08-12T01:15:13Z). Not queried, not deployed to, not
  referenced by any command in this session.
- **Open PR branches** — no PR was pushed to, rebased, or dequeued from Mergify.
- **CLAUDE.md** — the stale `ujtlwnoqfhtitcmsnrpq` reference in §1.11 was left as-is;
  updating it is a rule-adjacent edit outside this PR's docs+reference scope and
  CLAUDE.md changes carry their own PR-review requirement regardless of the
  docs carve-out. Flagged here as a known follow-up, not fixed.

## Verification commands (for anyone re-checking this)

```bash
# Ledger convergence
# (Supabase MCP) list_migrations against fizyjojbebyalirtjjht and vzwyaatejekddvltxyye, diff versions

# Preflight
SUPABASE_SERVICE_ROLE_KEY=<new rig's service_role key> \
SUPABASE_ACCESS_TOKEN=<management API token> \
npx tsx scripts/ci/staging-honesty-preflight.ts --project-ref fizyjojbebyalirtjjht --format json

# Health
gcloud auth print-identity-token --audiences=https://arkova-worker-staging-kvojbeutfa-uc.a.run.app
curl -H "Authorization: Bearer <token>" https://arkova-worker-staging-kvojbeutfa-uc.a.run.app/health

# Serving revision / traffic
gcloud run services describe arkova-worker-staging --region=us-central1 --project=arkova1 --format=json
```

---
_Written 2026-08-19T20:10Z. Staging state only — no prod, migration ledger, or schema
change was made to `vzwyaatejekddvltxyye` by this rebuild; all writes were to the new
project `fizyjojbebyalirtjjht` and to `arkova-worker-staging`'s Cloud Run
configuration._
