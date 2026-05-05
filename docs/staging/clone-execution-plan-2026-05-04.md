# Prod → Staging Scrubbed Clone — Master Execution Plan (2026-05-04)

> **Approach: Option B-Hybrid.** Scrubbed real-data clone of small/control-plane tables ONLY (~12 tables with rows + ~60 schema-only). Giant high-volume tables (`anchors`, `public_records`, `public_record_embeddings`, `audit_events`, `anchor_chain_index`, `anchor_proofs`, `audit_events_archive`) are OUT OF SCOPE and handled by Option A's synthetic generator (parallel branch).
>
> **Status:** PLAN ONLY. No prod data has moved. This document is the contract the future execution session works from.
>
> **Companion docs:**
> - [`docs/audits/scrub-classification-2026-05-04.md`](../audits/scrub-classification-2026-05-04.md) — column-by-column scrub strategy
> - [`docs/audits/jsonb-scrub-plan-2026-05-04.md`](../audits/jsonb-scrub-plan-2026-05-04.md) — per-key jsonb plan
> - [`docs/audits/prod-column-inventory-2026-05-04.csv`](../audits/prod-column-inventory-2026-05-04.csv) — raw inventory
> - [`docs/reference/STAGING_RIG.md`](../reference/STAGING_RIG.md) — rig ops
> - CLAUDE.md §1.4, §1.5, §1.6 — security mandates

---

## Why Option B-Hybrid

Prod DB is 29 GB. The four giant tables are 96% of that and contain the highest-PII content (extracted document metadata, recipient emails, audit trail). Three pivots compress the work dramatically:

1. **Giants → synthetic** (Option A). Sidesteps 96% of the volume AND the highest-PII columns in one stroke.
2. **Empty tables → schema-only**. Of the remaining 97 small tables, ~60 are empty in prod. No scrub work for them.
3. **Active scrub set is ~12 tables / ~700 rows total.** Tractable for one session, fully reviewable per-table, low blast radius.

Net: scrub surface compressed by ~95% vs. naive 1:1 clone. Fits Pro 8 GB tier with ~200 MB of headroom. Iteration cycle: minutes, not hours.

## Zero-tolerance principles (unchanged from original prompt)

1. NO real PII reaches staging. Every email/name/address/phone/customer-URL scrubbed.
2. NO real webhooks fire from staging. All `webhook_endpoints.url` scrubbed (table is empty in prod anyway, but rule applies post-load).
3. NO real Stripe coupling. All `stripe_*_id` scrubbed.
4. NO real API-key replay. All `api_keys.key_hash` regenerated against a known staging secret.
5. NO real chain coupling. Worker stays in `USE_MOCKS=true`. `chain_tx_id` already public — passthrough.
6. SCRUB-VERIFY-LOAD ORDER. Scrub happens in an intermediate environment between prod and staging.
7. NO prod mutation. Pipeline is read-only against prod.

## Pre-flight checklist

These must all be green before the execution session begins. Carson confirms each by ticking:

- [ ] `gcloud auth list` shows `carson@arkova.ai` active and not expired.
- [ ] `gcloud secrets versions access latest --secret=supabase_access --project=arkova1` returns a `sbp_*` token.
- [ ] Supabase MCP `list_migrations` against `vzwyaatejekddvltxyye` (prod) returns the 270-row ledger.
- [ ] Supabase MCP `list_migrations` against `ujtlwnoqfhtitcmsnrpq` (staging) shows ledger parity (270 rows, modulo the 11 prefix-collision files documented in STAGING_RIG.md). Any divergence beyond those 11 = STOP and reconcile first.
- [ ] Staging worker `arkova-worker-staging` Cloud Run is healthy (5/5 readiness conditions per `gcloud run revisions describe`).
- [ ] Carson has reviewed and approved [`scrub-classification-2026-05-04.md`](../audits/scrub-classification-2026-05-04.md). (Required by Phase 11.1.)
- [ ] Carson has reviewed and approved [`jsonb-scrub-plan-2026-05-04.md`](../audits/jsonb-scrub-plan-2026-05-04.md).
- [ ] Carson has chosen the intermediate environment (Phase 0 step below) and authorized any cost.

If any checkbox is unticked, the execution session does not proceed.

---

## PHASE 0 — Environment + intermediate scrub host (≤30 min total)

### 0.1 Confirm fresh gcloud auth (≤5 min)
```bash
gcloud auth list
gcloud config get-value project    # must be arkova1
```

### 0.2 Confirm Supabase tokens (≤5 min)
```bash
export SUPABASE_ACCESS_TOKEN="$(gcloud secrets versions access latest --secret=supabase_access --project=arkova1)"
echo "${SUPABASE_ACCESS_TOKEN:0:4}"  # should print "sbp_"
```

### 0.3 Confirm prod read access (≤2 min)
Via Supabase MCP `list_migrations(project_id=vzwyaatejekddvltxyye)`. Expect ≥270 rows.

### 0.4 Confirm staging schema parity (≤5 min)
Via Supabase MCP `list_migrations(project_id=ujtlwnoqfhtitcmsnrpq)`. Diff against prod. Acceptable divergences are exactly the 11 prefix-collision files in `STAGING_RIG.md`. Any other divergence = HARD STOP.

### 0.5 Confirm staging fits B-Hybrid budget (≤2 min)
B-Hybrid scrubbed clone = ~200 MB. Staging Pro tier = 8 GB. Margin: ~40x. No tier upgrade required.

### 0.6 Stand up the intermediate scrub environment (≤10 min)
**Recommended choice: local Postgres 17 docker container on Carson's MacBook.** Justification: B-Hybrid dataset is <200 MB; fits in container memory; zero recurring cost; container is destroyable in <30 sec; no third-party service in the loop.

```bash
docker run -d \
  --name arkova-scrub-intermediate \
  -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" \
  -p 127.0.0.1:55432:5432 \
  postgres:17
# Capture the random password into ~/arkova/scrub-intermediate.env (gitignored)
# Bind to localhost only — never expose externally
```

Alternative for higher isolation: ephemeral Cloud SQL instance in arkova1 ($0.04/hr, ~$0.50 for full pipeline). Use only if Carson explicitly prefers off-laptop isolation.

**GO/NO-GO Gate 0:** all 6 sub-steps green; intermediate container responds to `psql -h 127.0.0.1 -p 55432 -U postgres -c 'SELECT 1'`.

---

## PHASE 1 — Generate the SALT (≤5 min)

```bash
mkdir -p scripts/staging/clone
openssl rand -hex 32 > scripts/staging/clone/.salt
chmod 400 scripts/staging/clone/.salt
echo "scripts/staging/clone/.salt" >> .gitignore  # confirm gitignored
```

**GO/NO-GO Gate 1:** `git status` shows `.salt` is NOT staged; `cat .salt` returns 64 hex chars.

---

## PHASE 2 — Per-table scrubber implementation (parallel work; ≤45 min per scrubber)

**One PR per scrubber.** Each is independent, reviewable, mergeable separately. Carson approves each via `merge {N}` per CLAUDE.md `feedback_never_merge_without_ok.md`.

### 2.1 Scrubber dependency order

Load (and therefore scrub) order is dictated by FK dependencies:

1. `auth.users` (depends on nothing in scope)
2. `auth.identities`, `auth.mfa_factors`, `auth.sessions`, `auth.refresh_tokens`, `auth.one_time_tokens` (FK → auth.users)
3. `public.organizations` (no in-scope FK)
4. `public.profiles` (FK → auth.users.id, organizations.id)
5. `public.org_members`, `public.memberships` (FK → profiles, organizations)
6. `public.api_keys` (FK → organizations, profiles)
7. `public.subscriptions`, `public.entitlements` (FK → profiles, organizations)
8. `public.credit_transactions`, `public.credits` (FK → profiles, organizations)
9. `public.organization_rules` (FK → organizations, profiles)
10. `public.organization_rule_executions` (FK → organization_rules, organizations)
11. `public.org_integrations`, `public.integration_events` (FK → organizations)
12. `public.credential_templates` (FK → organizations, profiles)
13. `public.attestations`, `public.attestation_evidence` (FK → organizations, profiles; anchor_id → NULL)
14. `public.anchor_recipients` (anchor_id → NULL; recipient_user_id → profiles)
15. `public.verification_events` (anchor_id → NULL; org_id → organizations)
16. `public.extraction_manifests` (FK → organizations, profiles, ai_usage_events; anchor_id → NULL)
17. `public.ai_usage_events` (FK → organizations, profiles)
18. `public.ai_reports` (FK → organizations, profiles)
19. `public.compliance_audits`, `public.compliance_scores` (FK → organizations)
20. `public.cloud_logging_queue` (audit_id → NULL since audit_events out-of-scope)
21. `public.user_notifications` (FK → profiles, organizations)
22. `public.switchboard_flags`, `public.switchboard_flag_history` (FK → profiles for changed_by)
23. Reference data: `public.plans`, `public.org_tier_entitlements`, `public.jurisdiction_rules`, `public.freemail_domains` (passthrough; no scrub needed but file exists for symmetry)
24. Caches: `public.stats_cache`, `public.pipeline_dashboard_cache`, `public.treasury_cache` (passthrough)

Schema-only tables (~60) need no scrubber file but are still in the load manifest.

### 2.2 Per-scrubber file structure

Each `scripts/staging/clone/scrub/<table>.ts`:

```typescript
import { Row, scrubbedRow, SALT } from '../primitives';

export const TABLE = 'public.<table_name>';

export function scrub(row: Row, salt: string): Row {
  return {
    ...row,
    // per-column transforms per scrub-classification-2026-05-04.md
  };
}

export const fixtures = {
  golden: [/* ... */],
  expected: [/* ... */],
};
```

Each must include unit tests with golden inputs (anonymized prod-shape) and expected outputs.

### 2.3 PR sequencing

Open scrubber PRs in this order:
- PR-A: `scripts/staging/clone/primitives.ts` (the shared primitives library + types).
- PR-B: `scripts/staging/clone/scrub/auth_users.ts` + tests. Carson reviews → `merge {B}`.
- PR-C through PR-N: one scrubber per table per PR, in dependency order above.

Aim: ≤30 lines of new code per scrubber on average. Anything over 100 lines = decompose further.

**GO/NO-GO Gate 2:** all scrubber PRs merged; `npm run test:scrub-unit` passes 100%.

---

## PHASE 3 — Synthetic prod fixture (≤45 min)

`scripts/staging/clone/synthetic-prod-fixture.ts` produces a small fixture (~5-10 rows per in-scope table) shaped like prod but with **canary-marked PII**:

- emails: `unscrubbed-pii-N@CANARY-CUSTOMER.example`
- names: `OBVIOUS_PII_FIRST_NAME N`
- domains: `CANARY-DOMAIN.invalid`
- folder paths: `/CANARY-FOLDER/N/`
- jsonb free-text: `{"description": "OBVIOUS_PII_FREE_TEXT_N"}`

Purpose: any of these patterns appearing in scrubbed output = scrubber missed something.

**GO/NO-GO Gate 3:** synthetic-fixture loads cleanly into a fresh local Postgres; row counts match expected.

---

## PHASE 4 — Leak detector + dry run (≤45 min)

`scripts/staging/clone/scrub-leak-detector.ts` greps the scrubbed output for:

1. Canary strings from Phase 3.
2. Real customer email domains (pulled at run-time from prod's `auth.users.email` distinct domains — NOT committed; pulled as part of detector setup).
3. Real org domains from `organizations.domain`.
4. Real OAuth `provider_id` values from `auth.identities`.
5. Per-jsonb-key risk strings: `extracted_fields`, `result_json`, `claims`, `description`, `notes`, `details`, `recipient_email`, `legal_name`, `full_name` (when in unexpected places).

### 4.1 Run dry run end-to-end

```bash
# Load synthetic fixture into intermediate
psql ... -f synthetic-prod-fixture.sql

# Run scrubber pipeline
npx tsx scripts/staging/clone/scrub-snapshot.ts --in intermediate --out scrubbed.sql

# Run leak detector
npx tsx scripts/staging/clone/scrub-leak-detector.ts --target scrubbed.sql
```

### 4.2 Iterate

Any leak detector hit = HARD FAIL. Fix scrubber, re-run from Phase 3 fixture. Repeat until detector reports zero matches across all 12 in-scope tables.

**GO/NO-GO Gate 4:** leak detector zero-matches against synthetic fixture pipeline. Carson reviews the dry-run output and ticks "approved dry run 2026-05-04" before proceeding.

---

## PHASE 5 — Prod snapshot extraction (≤30 min total; READ-ONLY against prod)

### 5.0 Re-verify row-count classification (≤5 min) ⚠️ CRITICAL

The classification in [`prod-column-inventory-2026-05-04.csv`](../audits/prod-column-inventory-2026-05-04.csv) is a snapshot from `pg_stat_user_tables.n_live_tup` at plan-write time. `n_live_tup` is an estimate that lags real writes; customer onboarding between plan-write and execute can change the picture.

Re-run against prod via Supabase MCP `execute_sql`:
```sql
SELECT relname AS table_name, n_live_tup
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY n_live_tup DESC;
```

HARD STOP if any of:
- A table classified `SCHEMA-ONLY` (n_live_tup=0 at plan-write) now has rows. Reclassify it before extracting; treat unknown rows as PII-DIRECT until proven otherwise.
- A table in the active-scrub set now has >2x the row count at plan-write (signals significant customer activity since plan; existing scrubbers may not handle the new shape).
- Any new table appears in `public` that wasn't in the inventory CSV. Stop and reconcile.

Record the re-verification output in the execution log.

### 5.1 Pull schema-only dump (≤5 min)
Skip — staging schema is already replayed via prior STAGING_RIG.md procedure. We only need data.

### 5.2 Pull data per in-scope table (≤2 min each, ~24 tables)

For each in-scope table (and `auth.users`/`auth.identities`), pull just the rows we need via Supabase MCP `execute_sql`:

```sql
COPY (SELECT * FROM <table>) TO STDOUT WITH (FORMAT csv, HEADER, ENCODING 'utf8');
```

Saved to `/tmp/prod-data-<table>.csv` on the execution machine. Files are **NEVER committed** — gitignored at `/tmp/`.

### 5.3 Compute SHA-256 of each file (≤2 min)

```bash
shasum -a 256 /tmp/prod-data-*.csv > /tmp/prod-data-checksums.txt
```

Log in execution-log.

### 5.4 Spot-check row counts (≤5 min)

For 3 random tables, compare CSV row count to prod `SELECT count(*)`. Mismatch = STOP.

**GO/NO-GO Gate 5:** all 24 dumps pulled, checksummed, row counts verified.

---

## PHASE 6 — Scrub execution (≤45 min total)

### 6.1 Load unscrubbed CSVs into intermediate Postgres

```bash
for f in /tmp/prod-data-*.csv; do
  table=$(basename "$f" .csv | sed 's/^prod-data-//')
  psql -h 127.0.0.1 -p 55432 -U postgres -c "\\COPY $table FROM '$f' CSV HEADER"
done
```

### 6.2 Run scrubbers in dependency order

```bash
npx tsx scripts/staging/clone/scrub-snapshot.ts \
  --intermediate "postgres://postgres:$PASS@127.0.0.1:55432/postgres" \
  --salt "$(cat scripts/staging/clone/.salt)" \
  --out /tmp/scrubbed.sql
```

After EACH table:
- Spot-check 5 random rows (manual review of console output).
- Run leak detector against just that table.
- Log "table done" in execution-log.

### 6.3 Final whole-DB leak detector

```bash
npx tsx scripts/staging/clone/scrub-leak-detector.ts --target /tmp/scrubbed.sql
```

Zero matches required.

### 6.4 FK integrity check

```sql
-- In intermediate post-scrub
SELECT count(*) FROM profiles p LEFT JOIN auth.users u ON p.id = u.id WHERE u.id IS NULL;
-- Must return 0
```

Repeat for each scrubbed FK relationship.

**GO/NO-GO Gate 6:** zero leak-detector matches; FK integrity intact; Carson signs off post-spot-check.

---

## PHASE 7 — Staging load (≤30 min)

### 7.1 TRUNCATE staging in dependency order

Wrap in transaction:
```sql
BEGIN;
TRUNCATE
  public.user_notifications,
  public.cloud_logging_queue,
  public.compliance_audits,
  public.ai_reports,
  public.ai_usage_events,
  public.extraction_manifests,
  public.verification_events,
  public.anchor_recipients,
  public.attestations,
  public.attestation_evidence,
  public.credential_templates,
  public.integration_events,
  public.org_integrations,
  public.organization_rule_executions,
  public.organization_rules,
  public.credit_transactions,
  public.credits,
  public.entitlements,
  public.subscriptions,
  public.api_keys,
  public.org_members,
  public.memberships,
  public.profiles,
  public.organizations,
  public.switchboard_flag_history,
  public.switchboard_flags,
  public.compliance_scores,
  public.user_notifications,
  public.stats_cache,
  public.pipeline_dashboard_cache,
  public.treasury_cache
CASCADE;
COMMIT;
```

(Reference + system tables `plans`, `jurisdiction_rules`, `freemail_domains`, `org_tier_entitlements` are already populated by schema replay — leave them.)

### 7.2 Load scrubbed data → staging

```bash
psql "$STAGING_URL" -f /tmp/scrubbed.sql
```

### 7.3 Validate row counts match scrubbed intermediate

For each in-scope table:
```sql
-- intermediate
SELECT '<table>', count(*) FROM <table>;
-- staging
SELECT '<table>', count(*) FROM <table>;
-- must match
```

### 7.4 Worker sanity check

- Hit `/health` on `arkova-worker-staging` via gcloud identity token. Expect 200.
- Tail Cloud Run logs for ~60 seconds. Confirm no log line contains `customer URL contacted` or evidence of real Stripe/email API calls.

### 7.5 Final leak detector sweep against staging

Pull each in-scope staging table to a temp CSV, run leak detector. Zero matches required. Belt-and-suspenders against any transit corruption.

**GO/NO-GO Gate 7:** all row counts match; worker /health green; final leak detector zero-matches.

---

## PHASE 8 — Tear down + secure wipe (≤15 min)

### 8.1 Destroy intermediate
```bash
docker stop arkova-scrub-intermediate && docker rm arkova-scrub-intermediate
docker volume prune -f  # remove the implicit volume too
```

### 8.2 Securely wipe unscrubbed dumps
```bash
shred -uvz /tmp/prod-data-*.csv /tmp/prod-data-checksums.txt /tmp/scrubbed.sql
ls /tmp/prod-data-* /tmp/scrubbed.sql 2>/dev/null && echo "FAIL: files still exist" && exit 1
```

### 8.3 Wipe SALT (or rotate per Carson's preference)
```bash
shred -uvz scripts/staging/clone/.salt
```
(Re-generate next clone cycle.)

### 8.4 Commit execution log

`docs/staging/clone-execution-log-YYYY-MM-DD.md` — direct push to main per CLAUDE.md §0 rule 8 doc-only carve-out. Includes:
- Steps that ran clean.
- Steps that retried (and why).
- Final state confirmations.
- Any deviations from this plan (and Carson's authorization for them).

**GO/NO-GO Gate 8:** intermediate destroyed; dumps shredded; log committed.

---

## PHASE 9 — Verification gates (≤30 min)

The clone is NOT trustworthy for soak until ALL of these pass:

### 9.1 Leak detector against staging — zero matches

Already done in Phase 7.5. Re-run as belt-and-suspenders.

### 9.2 Random-sample audit

Pull 50 random rows from each of these 5 highest-risk staging tables. Carson manually inspects output for any pattern that looks like real PII:
- `auth.users` (emails/names)
- `public.profiles` (emails/names/phones)
- `public.extraction_manifests` (extracted_fields should be all null)
- `public.organizations` (legal_name, ein_tax_id)
- `public.attestations` (claims should be null; attester_name should look fake)

Any match = full rollback (TRUNCATE staging in-scope tables; investigate scrubber).

### 9.3 Webhook safety check

```sql
SELECT DISTINCT url FROM webhook_endpoints;
-- Every URL must start with `https://localhost/` or `http://127.0.0.1/`. Any other domain = HARD FAIL.
```

(Table is empty in prod, so post-load it's also empty — but the rule applies if Option A or future seeding adds rows.)

### 9.4 Email safety check

```sql
SELECT email FROM auth.users WHERE email NOT LIKE '%@staging.invalid.test' LIMIT 1;
-- Empty result required.
SELECT email FROM public.profiles WHERE email NOT LIKE '%@staging.invalid.test' LIMIT 1;
-- Empty result required.
```

### 9.5 Stripe safety check

```sql
SELECT DISTINCT stripe_customer_id FROM subscriptions WHERE stripe_customer_id IS NOT NULL AND stripe_customer_id NOT LIKE 'cus_test_%' LIMIT 1;
-- Empty result required.
SELECT DISTINCT stripe_subscription_id FROM subscriptions WHERE stripe_subscription_id IS NOT NULL AND stripe_subscription_id NOT LIKE 'sub_test_%' LIMIT 1;
-- Empty result required.
```

### 9.6 Domain safety check

```sql
SELECT DISTINCT domain FROM organizations WHERE domain IS NOT NULL AND domain NOT LIKE '%.example.invalid' LIMIT 1;
-- Empty result required.
```

### 9.7 OAuth identity safety check

```sql
SELECT email FROM auth.identities WHERE email NOT LIKE '%@staging.invalid.test' LIMIT 1;
-- Empty result required.
```

### 9.8 jsonb-leak grep

```sql
SELECT id, raw_user_meta_data FROM auth.users WHERE raw_user_meta_data::text ~ '@(?!staging\\.invalid\\.test)';
-- Should return 0 rows.
```

**GO/NO-GO Gate 9:** all 8 sub-checks pass. Carson confirms each in the execution log.

---

## PHASE 10 — Soak readiness (≤30 min)

### 10.1 Roll worker revision

```bash
gcloud run services update arkova-worker-staging \
  --region=us-central1 \
  --update-env-vars=NODE_ENV=production
# any noop change forces new revision so worker resets connection pool
```

### 10.2 30-min sanity soak

```bash
./scripts/staging/claim.sh acquire 0 "post-clone sanity"
npx tsx scripts/staging/load-harness.ts --duration 30m
./scripts/staging/claim.sh release 0
```

Confirm:
- Worker error rate < 0.1%.
- p95 latency reasonable (compare to prior soaks).
- No log line indicating real customer URL/email contacted.

### 10.3 Update HANDOFF.md "## Now"

Direct push to main per doc-only carve-out. Record:
- Clone date.
- Scrubbed in-scope row count (~700).
- SALT rotation policy used.
- Caveats/notes from execution-log.

**GO/NO-GO Gate 10:** worker stable for 30 min on scrubbed data; no leak signals; HANDOFF.md reflects new state.

---

## PHASE 11 — Carson sign-off gates

The clone is NOT considered trustworthy for T2/T3 soaks until Carson has explicitly acknowledged each:

| Gate | Requires |
|---|---|
| 11.1 | Comment "approved scrub-classification 2026-05-04" + "approved jsonb-scrub-plan 2026-05-04" on the PR/commit landing the audit docs. **Required before Phase 5 begins.** |
| 11.2 | Each per-table scrubber PR merged via `merge {N}` per CLAUDE.md `feedback_never_merge_without_ok.md`. |
| 11.3 | Leak detector zero-matches at Phase 6.3 + Phase 7.5 + Phase 9.1, recorded in execution-log. |
| 11.4 | Intermediate environment destroyed; dumps shredded (Phase 8). |
| 11.5 | Verification gates 9.2–9.8 all green. |

When all 5 are recorded in the execution log, the rig is "scrubbed-clone-ready" and may be used as a soak target. Until then it is "schema-only + Option-A-synthetic" only.

---

## Convergence with Option A (synthetic generator)

This work and Option A converge in `scripts/staging/load-harness.ts`. Sequence:

1. (This work, Option B-Hybrid) loads scrubbed real-shape control-plane data (orgs, profiles, integrations, rules, api_keys, etc.) → ~700 rows total.
2. (Option A, parallel branch) generates synthetic anchors, public_records, public_record_embeddings, audit_events, anchor_chain_index, anchor_proofs against the scrubbed orgs/profiles → up to N hundred-thousand rows.
3. Soak harness drives traffic that exercises both: real control-plane shape (varied tier/role/integration combos) + realistic anchor volume.

Coordination point: Option A must use the SAME `org_id` and `user_id` UUIDs that survived the scrubbed clone — otherwise its synthetic anchors will FK-orphan. Either:
- (a) Option A generator reads the scrubbed staging's `organizations.id` and `profiles.id` BEFORE generating; or
- (b) Option A is run AFTER this clone (recommended ordering).

Document this in Option A's branch when it merges.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Scrubber bug leaks PII into staging | Three-layer detector: leak detector at Phase 6.3, 7.5, 9.1. Two synthetic-fixture cycles before real data. |
| Intermediate environment compromised | Local docker bound to 127.0.0.1; password random per run; container destroyed after run. No external network. |
| FK orphan after scrub | Phase 6.4 FK integrity check; explicit dependency-ordered scrubber sequence. |
| SALT leaked / committed | gitignored at .gitignore; chmod 400; never logged; shredded in Phase 8.3. |
| Re-clone produces different scrubbed values | Single SALT per run held stable across all scrubbers. Re-clone uses new SALT (intentional — defends against cross-clone correlation). |
| Worker behaves wrongly post-clone (env mismatch) | Phase 10.2 sanity soak catches before T2. |
| jsonb scrubber misses a key | Allowlist (not blocklist) approach in jsonb plan: unknown keys default to NULL. |
| anchors-FK in extraction_manifests/verification_events broken | Set anchor_id NULL at scrub time; soak harness either tolerates NULL or Option A re-links. |
| Auth tokens replay (refresh / one_time / mfa) | All token columns nulled or regenerated; staging's GoTrue starts fresh sessions. |

---

## Estimated total time

| Phase | Duration |
|---|---|
| 0 — env | 30 min |
| 1 — SALT | 5 min |
| 2 — scrubbers (one-time, parallel work) | ~1 day spread across multiple PRs |
| 3 — synthetic fixture | 45 min |
| 4 — dry run | 45 min (multiple iterations possible) |
| 5 — extract | 30 min |
| 6 — scrub | 45 min |
| 7 — load | 30 min |
| 8 — teardown | 15 min |
| 9 — verification | 30 min |
| 10 — soak readiness | 30 min |
| **Total execution session** (after scrubbers exist) | **~4 hours** |

---

## Changelog

- **2026-05-04** — initial draft. B-Hybrid scope confirmed by Carson. Awaiting Phase 11.1 sign-off before any prod data extraction.
