# 7-Day Full-Functionality Soak — Executable Runbook

> **Status:** Ready to execute. **Owner:** RTE. **Prepared:** 2026-08-11.
> **Standard:** SOC 2 Type 2 — operating effectiveness *over a period*, not a point-in-time pass.
>
> **Founder's scope directive, verbatim:** *"EVERY piece of code we've built since the inception needs to be tested."*
> *"EVERYTHING in the application needs testing, not just new stuff. No hollow soaks, no partial soaks."*
>
> This runbook is **driven by a feature inventory**, not by this document's own prose. A separate exhaustive
> feature-inventory workflow derives every shipped feature from code evidence (routes, migrations, git history,
> prod schema). That inventory drops into §4 as the coverage checklist.
>
> **Any feature absent from that list is untested, and its absence is itself a finding.** This repo has a proven
> pattern of shipped-then-forgotten code: 11 routes with no navigation entry, a complete `PricingPage` bound to no
> route, `paymentTierRouter` never mounted, `proof-keys.ts` never imported (so `/.well-known/arkova-keys.json`
> 404s), and 8 hooks with zero importers — including two HIPAA controls marked Done. A soak scoped by memory
> reproduces exactly that blind spot.

---

## 0. Verified ground truth (2026-08-11, re-verified for this runbook)

Everything in this table was queried live today. Nothing is carried over from a prior document.

| Fact | Verified value | How verified |
|---|---|---|
| Prod Supabase | `vzwyaatejekddvltxyye` | Supabase MCP |
| Prod ledger head | **0405** (107 rows) | `max(version)` on `supabase_migrations.schema_migrations` |
| Prod worker revision | `arkova-worker-01286-dam` | `gcloud run services describe` |
| Prod worker health | `healthy`, `git_sha 2de4e4e344f3749a09c52d7411831b7d2735528c`, `network=mainnet`, db/anchoring/kms all `ok` | `GET /health` |
| Prod anchors | 3,478,543 total / **3,476,167 SECURED** | SQL |
| Prod per-document proofs | **508,393** | `count(*) from anchor_proofs` |
| **Proof gap** | **2,967,774 SECURED anchors with no proof — 85.4%** | derived |
| Prod orgs / API keys / flag rows | 10 / 19 / 24 | SQL |
| Rig Supabase | `arkova-fullsoak-2026-08` = `gnkuaywlpmsaezwvlvhk` | Supabase MCP |
| **Rig ledger head** | **0400** (102 rows), 117 tables | SQL — **5 migrations behind prod** |
| **Rig data state** | **0 anchors, 0 orgs, 1 switchboard row** | SQL |
| `SOAK_GATE_DISABLED` | **`true`** — gate passes vacuously | `gh variable list` |
| `DEPLOY_WORKER_PAUSED` | `false` — merges deploy to prod now | `gh variable list` |
| Cloud Scheduler jobs | 59 total; 58 prod-targeted + 1 `chaindump-desk` | `gcloud scheduler jobs list` |

### 0.1 Correction: the zombie workers are already gone

Prior ground truth said two zombie soak workers (`arkova-worker-launch-72h-2026-08-staging`,
`arkova-worker-legacy-soak-2026-08-staging`) were Ready-but-503 with ~12 Scheduler jobs still firing at them, and
had to be torn down first. **That teardown completed during this session.**

Audit-log evidence — Cloud Scheduler `DeleteJob` calls at `2026-08-11T15:49:26Z` through `15:49:32Z`, principal
`270018525501-compute@developer.gserviceaccount.com`. Both Cloud Run services are absent from
`gcloud run services list`; zero scheduler jobs now target either hostname.

Two consequences:

1. **Step 1 of this runbook is now a verification, not a teardown** (§2.1).
2. The deleting principal was the **default compute service account**, which per the launch-readiness review holds
   **Owner** on the whole GCP project. Infrastructure was mutated by the same over-privileged identity the
   production worker runs as (SCRUM-3023). Log this as a CC6.1 least-privilege observation; it is in scope for the
   pre-mortem (§8) but is **not** a blocker for starting the soak.

> **Method note.** An early probe of these services appeared to return `healthy` JSON. That reading was a stale
> `curl -o` output file, not a live response; re-probing with a correct-audience identity token returned no
> response at all. The false reading was caught before it entered this document. Any health claim in this runbook
> must come from a fresh file per probe — see §5.0.

---

## 1. GATE 0 — Flag reconciliation (the step that makes this non-hollow)

**Rule: any flag left off is a feature the soak silently skips while reporting green.** Gate 0 must close before
the 7-day clock starts. It does not resolve flags from any manifest — it resolves them **through the same code
paths the runtime uses**.

### 1.1 The flag surface is larger than previously believed

Prior ground truth said ~48 flags (28 env + 20 DB + 18 frontend). Code evidence says **~63 distinct flags**:

| Population | Count | Source of truth |
|---|---|---|
| Env flags in worker Zod schema | 38 | `services/worker/src/config.ts` |
| …of which the flag registry knows | 27 | `flagRegistry` |
| …**registry blind spot** | **11 env flags the registry never sees** | derived |
| DB flags (`DB_FLAGS`) | 20 | registry |
| Prod `switchboard_flags` rows | **24** (17 true / 7 false) | live SQL |
| …**rows the registry does not track** | **4** | derived |
| Frontend defaults | 17 + 2 `VITE_*` | `src/` |

The config-drift manifest asserts only **6**. It also does not read running prod (`scripts/ci/check-config-drift.ts`
compares against committed snapshots). **Do not cite it as Gate 0 evidence.**

### 1.2 The resolution rule is NOT simply "DB wins" — it is path-dependent

This is the single most important correction in this runbook. There are **two different resolution paths with
opposite failure modes**:

| Path | Row present | **Row absent** |
|---|---|---|
| `get_flag(text, boolean)` RPC (SQL) | DB value wins | **fail-CLOSED → false** |
| `flagRegistry` (worker TS) | DB value wins | **falls back to env → fail-OPEN** |

So "DB wins" holds **only when the row exists**. When it does not, the two paths disagree with each other.

Applied to the two known contradictions and the two missing rows:

| Flag | Cloud Run env | Prod DB row | Effective | Note |
|---|---|---|---|---|
| `ENABLE_SEMANTIC_SEARCH` | `true` | `false` | **false** | DB wins (row exists) |
| `ENABLE_AI_FRAUD` | `true` | `false` | **false** | DB wins (row exists) |
| `ENABLE_PARTNER_PROVISIONING` | — | **no row** | **false** | genuinely fail-closed |
| `ENABLE_ADES_SIGNATURES` | — | **no row** | **env fallback → fail-OPEN** | **prior ground truth was wrong**; it is not fail-closed |

Both contradictions are confirmed live: prod Cloud Run sets `ENABLE_SEMANTIC_SEARCH=true` and `ENABLE_AI_FRAUD=true`
(13 `ENABLE_*` env vars on `arkova-worker-01286-dam`), while `switchboard_flags` has both `false`.

### 1.3 The rig is currently a worst-case hollow-soak environment

```
Rig gnkuaywlpmsaezwvlvhk switchboard_flags:
  ENABLE_ORG_CREDIT_ENFORCEMENT = false      <-- the ONLY row
```

**19 of 20 `DB_FLAGS` have no row on the rig.** Every feature resolved via `get_flag` is therefore **dark**, and
every feature resolved via `flagRegistry` silently falls back to env — a *third* behaviour matching neither prod
nor the DB. Starting a soak here would produce a green result across a mostly-disabled product. This is precisely
the hollow soak the founder ruled out.

### 1.4 Gate 0 executable procedure

Run from repo root. All four steps must produce artifacts before the clock starts.

**Step 0.1 — bring the rig to prod's ledger head (0400 → 0405).**

```bash
# Per CLAUDE.md §0 rule 10, apply via Supabase MCP apply_migration, then reconcile the numeric ledger.
# Migrations to apply, in order: 0401, 0402, 0403, 0404, 0405
ls supabase/migrations/04{01,02,03,04,05}_*.sql

# After each MCP apply_migration against project_id=gnkuaywlpmsaezwvlvhk:
#   UPDATE supabase_migrations.schema_migrations
#      SET version='04NN' WHERE name='<file>' AND version !~ '^[0-9]{4}$';
# Then confirm the numeric head BEFORE proceeding:
#   select max(version) from supabase_migrations.schema_migrations;   -- must return 0405
```

**Step 0.2 — dump the three flag populations for BOTH environments.**

```bash
mkdir -p docs/staging/evidence/gate0

# (a) env flags, prod and rig, from the RUNNING revision (not from config.ts)
for SVC in arkova-worker arkova-worker-fullsoak-2026-08-staging; do
  gcloud run services describe "$SVC" --region=us-central1 --project=arkova1 \
    --format='value[delimiter="
"](spec.template.spec.containers[0].env.map().format("{0}={1}", name, value))' \
    | grep -E '^(ENABLE_|USE_MOCKS|MAINTENANCE_MODE|MCP_|BITCOIN_NETWORK|NODE_ENV)' | sort \
    > "docs/staging/evidence/gate0/env-${SVC}.txt"
done

# (b) DB flags, prod and rig  (run via Supabase MCP execute_sql per project)
#     select flag_key, enabled from switchboard_flags order by flag_key;
#     -> docs/staging/evidence/gate0/db-prod.txt / db-rig.txt

# (c) frontend defaults
grep -rnoE 'ENABLE_[A-Z_]+|VITE_[A-Z_]+' src/ | sort -u \
  > docs/staging/evidence/gate0/frontend-flags.txt
```

**Step 0.3 — resolve every flag through the runtime path, not the dump.**

A dump of `switchboard_flags` is *not* a resolution: it cannot show env fallback or fail-closed behaviour. For each
of the ~63 flags, record the **effective** value by asking the runtime:

```bash
# DB path, exactly as the SQL runtime resolves it (proves fail-closed on missing row):
#   select f.k as flag, public.get_flag(f.k, false) as effective
#   from (values ('ENABLE_SEMANTIC_SEARCH'),('ENABLE_ADES_SIGNATURES'), ...) as f(k);

# Registry path, exactly as the worker resolves it (proves env fallback):
#   hit the worker's own resolved-flag reporting surface on the rig tag URL,
#   or exercise the gated endpoint and observe behaviour.
```

`scripts/audit_feature_flags.py` may be run for cross-reference **only**. Confirm before relying on it whether it
resolves through the runtime or reads a manifest; if it reads a manifest, it is a Gate 0 cross-check, never the
Gate 0 evidence.

**Step 0.4 — decide and record ON/OFF per flag, then apply to the rig.**

Produce `docs/staging/evidence/gate0/flag-decision-matrix.csv` with one row per flag:

```
flag,population(s),gates_what,prod_effective,rig_effective,must_be_ON_for_soak,danger,decision,rationale
```

Decision rules:

- **Default: ON.** Full-functionality means every feature exercised. Off requires a written reason.
- **Must be ON even though prod is OFF** — otherwise the soak cannot test them, and we advertise them (§3):
  `ENABLE_SEMANTIC_SEARCH`, `ENABLE_AI_FRAUD`, `ENABLE_FRAUD_DETECTION`, `ENABLE_COMPLIANCE_ENGINE`,
  `ENABLE_EXPIRY_ALERTS`, `ENABLE_ORG_CREDIT_ENFORCEMENT`, `ENABLE_PARTNER_PROVISIONING`, `ENABLE_ADES_SIGNATURES`.
  Turning these on for the soak is how we learn whether the advertised capability actually works.
- **Must stay OFF on the rig (dangerous):**
  - `ENABLE_PROD_NETWORK_ANCHORING` — must be **signet**, never mainnet, on the rig. Set `BITCOIN_NETWORK=signet`.
  - `MAINTENANCE_MODE` — off, or the soak tests a maintenance page.
  - Any Replicate/QA-only AI provider — hard-blocked in prod, keep blocked.
  - Real Stripe live-mode capture — use Stripe **test mode** keys (§4 Billing).
- **`USE_MOCKS=false` is mandatory.** The standing staging rig runs `USE_MOCKS=true`, which fakes the chain client
  and returns synthetic tx ids. A full-functionality soak with mocks on is definitionally hollow. Both signet
  treasuries are funded (68,744 and 749,062 sats) precisely so this can be real.
- **`MEMPOOL_API_URL` must NEVER be set on the rig.** Inconsistent `/api` suffix handling silently kills
  confirmation detection — the soak would anchor forever and never confirm, with no error.

**Step 0.5 — seed the rig switchboard to the decided state.**

The rig needs rows for all 20 `DB_FLAGS` (plus the 4 untracked prod rows), not the current 1. Data-only insert; it
writes nothing to `schema_migrations` (§1.11A compliance).

**Gate 0 exit criteria (all four required):**

1. Rig ledger head = **0405**, confirmed by query, matching prod.
2. `flag-decision-matrix.csv` complete for all ~63 flags, every OFF carrying a written rationale.
3. Rig effective values match the decision matrix, **verified through the runtime path**, not by reading the table.
4. `BITCOIN_NETWORK=signet`, `USE_MOCKS=false`, `MEMPOOL_API_URL` unset — all three confirmed on the running revision.

---

## 2. Pre-soak infrastructure preparation

### 2.1 Verify the zombie teardown held (was: perform it)

```bash
gcloud run services list --region=us-central1 --project=arkova1 --format='value(metadata.name)'
# EXPECT: arkova-worker, arkova-worker-staging, chaindump-mcp  (and, after §2.2, the fullsoak rig worker)
# MUST NOT contain: arkova-worker-launch-72h-2026-08-staging, arkova-worker-legacy-soak-2026-08-staging

gcloud scheduler jobs list --project=arkova1 --location=us-central1 \
  --format='csv[no-heading](name,state,httpTarget.uri)' | grep -cE 'launch-72h|legacy-soak'
# EXPECT: 0
```

If either check fails, delete the stragglers before proceeding — a 5xx-ing service with live Scheduler jobs
pollutes exactly the error-rate signal the soak depends on.

### 2.2 Finish rig provisioning (steps 3–6)

The rig exists with the canonical baseline; `scripts/staging/provision-isolated-rig.sh` is complete 6-step
automation and steps 1–2 are done. Remaining: secrets → Cloud Run → Scheduler → fixture seed → preflight.

**Rig worker env deltas vs prod — the load-bearing ones:**

| Var | Prod | **Rig** | Why |
|---|---|---|---|
| `BITCOIN_NETWORK` | `mainnet` | **`signet`** | real anchoring, zero mainnet exposure |
| `USE_MOCKS` | `false` | **`false`** | **not** the standing-rig default of `true` |
| `ENABLE_PROD_NETWORK_ANCHORING` | `true` | `true` (signet-scoped) | anchoring must actually run |
| `MEMPOOL_API_URL` | unset | **unset** | setting it silently kills confirmation |
| `SUPABASE_URL` / service key | prod | rig secrets | isolation |
| `CRON_SECRET` | `cron-secret` | `cron-secret` | same secret; sourcing `cron-secret-staging` yields 401 on every cron call and silently degrades coverage |

### 2.3 Bind Scheduler jobs for ALL cron routes — including the 52 with no prod job

105 cron endpoints exist in code; **52 have no prod Cloud Scheduler job**, including every Bitcoin safety loop
(`detect-reorgs`, `monitor-stuck-txs`, `rebroadcast-txs`, `consolidate-utxos`, `monitor-fees`) and both
proof-backfill jobs. Live prod has 58 prod-targeted jobs against 105 defined routes.

**Trap: a Scheduler job bound to a route the revision does not serve returns 404 silently — forever. No log, no
Sentry.** So binding is not sufficient; each binding must be proven to have *executed the handler*.

```bash
# 1. Derive the code-side cron route list from the mounted routers (evidence, not memory):
grep -rnoE "router\.(get|post)\(['\"]/[a-z0-9-]+" services/worker/src/routes/ | sort -u \
  > docs/staging/evidence/cron-routes-in-code.txt

# 2. Diff against what Scheduler actually binds on the rig:
gcloud scheduler jobs list --project=arkova1 --location=us-central1 \
  --format='value(httpTarget.uri)' | grep fullsoak | sed 's|.*/jobs/||' | sort -u \
  > docs/staging/evidence/cron-routes-bound.txt
diff docs/staging/evidence/cron-routes-in-code.txt docs/staging/evidence/cron-routes-bound.txt

# 3. PROVE each binding hits a real handler — 404 is the silent failure:
#    for each job, force a run and assert the response is NOT 404 and the handler's
#    observable state changed (row written / counter moved / last_run_at advanced).
gcloud scheduler jobs run <job> --project=arkova1 --location=us-central1
```

Every cron route in code gets a rig Scheduler job for the soak, **including all 52 currently unscheduled ones**.
That is the only way the dormant Bitcoin safety loops get any operating-effectiveness evidence at all.

### 2.4 Re-enable the soak evidence gate

```bash
gh variable get SOAK_GATE_DISABLED     # currently: true
gh variable set SOAK_GATE_DISABLED --body false
```

While `true`, `scripts/ci/check-staging-evidence.ts` short-circuits to a pass **without reading the PR body**, and
prints a `::warning::`. **Any green "Staging Soak Evidence Gate" produced while this is `true` is meaningless and
must not be shown to an auditor.** Flip it before the clock starts, or the soak generates no citable evidence.

Also note `DEPLOY_WORKER_PAUSED=false`: any merge to main deploys to prod *during* the soak. See §8 (change
freeze).

### 2.5 Seed the fixture and pass preflight

```bash
supabase db query --linked --file scripts/staging/seed-baseline-fixture.sql
npx tsx scripts/ci/staging-honesty-preflight.ts --project-ref gnkuaywlpmsaezwvlvhk
# REQUIRED: environment_type=clean_mirror
# The rig currently has 0 anchors -> Check 5 (submitted_anchors >= 1) FAILS
# -> classified fixture_seeded -> soak rejected as HOLLOW.
```

**Known preflight false positive:** `duplicate_names` flags `validate_api_key_rpc_hardening` because the repo
legitimately ships `0302_` and `0303_` with the same descriptive name. A faithful rig replays both. This is a
preflight bug (dedup by `name` instead of `version`), not contamination — record it as a known exception rather
than "fixing" the rig to hide it.

---

## 3. Claims integrity (R-7) — a first-class soak surface

**Principle: a soak that proves the software works while we advertise things it does not do has not protected us.**

CLAUDE.md §1.13 (R-7) forbids public claims of status we do not hold, and §1.5 requires proof copy to state what is
measured, asserted, and **not** asserted. A completed audit found four live violations. These bear directly on
SOC 2 Type 2, because one of them is an assertion made *to the auditor*.

**Rule for the soak:** for every capability we advertise publicly, in a published package, or to an auditor, the
soak must either **(a) demonstrate it working**, or **(b) record it as a claim to retract**. There is no third
outcome. Each row below is a soak assertion with a named artifact.

### 3.1 Semantic search — advertised on ten surfaces, flag is `false`

`ENABLE_SEMANTIC_SEARCH` resolves **false** in prod (DB row wins over `env=true`). It is nonetheless advertised at:

| # | Surface | Location |
|---|---|---|
| 1 | `llms.txt` | `public/llms.txt:23` |
| 2 | `llms-full.txt` | `llms-full.txt:79` |
| 3 | MCP server card | `public/.well-known/mcp/server-card.json:64` |
| 4 | **Live edge MCP tool description** | `mcp-server.ts:580` |
| 5 | **Live edge MCP tool description** | `mcp-tools.ts:240` |
| 6 | OpenAPI spec | `docs/api/openapi.yaml:355` |
| 7 | **Served API docs** | `api/v1/docs.ts:1693` |
| 8 | Partner-facing doc marked "Status: Production" | `docs/api/mcp-tools.md` |
| 9 | — | — |
| 10 | **Priced commercial offer on the public `/developers` route** | `src/pages/DevelopersPage.tsx:65` — `/ai/search`, `$0.010` |

Surface 10 is the most serious: a **price** attached to a capability whose flag is off.

**Worse, and independent of the flag:** the edge MCP `search_credentials` tool is **not gated at all**, and its
fallback at `mcp-tools.ts:660-664` is a literal `ILIKE %query%` on filename/description. It returns **lexical
substring matches** while six surfaces claim semantic similarity. **Turning the flag on does not make the claim
true.**

**Soak assertions:**

- **A-3.1a** — With `ENABLE_SEMANTIC_SEARCH=true` on the rig, issue a query whose match is *semantic but not
  lexical* (e.g. query `"cardiac"` against a document titled `"heart surgery consent"`). **PASS** = the document is
  returned. **FAIL** = zero results, proving lexical-only behaviour.
- **A-3.1b** — Call the edge MCP `search_credentials` with the same semantically-but-not-lexically matching query.
  Record the result. If it returns nothing, the tool's own description is false as shipped.
- **Evidence:** `docs/staging/evidence/claims/semantic-search-{rig,edge}.json`, request + response + timestamp.
- **Outcome:** working → keep the claim and price it. Not working → **retract all ten surfaces before launch**,
  including removing the priced `/ai/search` line from `/developers`.

### 3.2 AdES signatures — no switchboard row, shipped in published npm packages

`ENABLE_ADES_SIGNATURES` has no `switchboard_flags` row. Per §1.2 it resolves via **env fallback (fail-open)**, not
fail-closed — so its runtime state must be measured, not assumed. Meanwhile *"Verify an AdES electronic
signature… eIDAS compliance"* ships in **published packages** reaching every MCP and LangChain client:

- `sdks/mcp-server/src/index.ts:213`
- `sdks/langchain-ts/src/index.ts:242`

A false claim in a published package cannot be retracted by editing a web page; it needs a corrective release.

- **A-3.2** — From a clean install of each published SDK, call the AdES verification tool against a known-good and
  a known-bad signature. **PASS** = correct verdict both ways. **FAIL** = error, stub, or always-true.
- **Evidence:** `docs/staging/evidence/claims/ades-sdk-{mcp,langchain}.log`, including installed package version.

### 3.3 Fraud detection — all flags false, asserted "Continuous" to a SOC 2 auditor

`ENABLE_AI_FRAUD=false` and `ENABLE_FRAUD_DETECTION=false` in prod. Yet:

- `docs/wiki/TECHNICAL_SECURITY_WIKI.md`, headed *"For Partners, Investors, and Integration Teams"*, states fraud
  detection as live.
- **`docs/compliance/soc2-type2-evidence-matrix.md:42` asserts to a SOC 2 auditor that fraud detection is a
  "Continuous" operating control.**
- Six regulator-facing privacy filings (Kenya ODPC, South Africa, Thailand, Colombia) declare anti-fraud detection
  as an active processing activity.

An inoperative control described to an auditor as continuously operating is a **material misstatement** — a worse
finding than not having the control. The regulatory filings escalate it beyond SOC 2.

- **A-3.3** — With fraud flags ON on the rig, submit documents designed to trip each documented fraud rule.
  **PASS** = detection fires, writes its row, and surfaces in the UI. **FAIL** = no-op.
- **Evidence:** `docs/staging/evidence/claims/fraud-detection-runs.json` + the DB rows written, sampled daily
  across all 7 days (a "Continuous" control needs continuous evidence, not one run).
- **Outcome:** if it does not operate, correct the evidence matrix **before** the auditor sees it, and open
  remediation for the six filings.

### 3.4 The precedent to copy

`public/.well-known/mcp/server-card.json:246` correctly hedges `anchor_document` as **conditionally available**.
That is the right pattern and it already exists in-repo. Every claim that survives §3 should carry the same
conditional framing where the capability is flag-dependent.

### 3.5 Claims-integrity exit criterion

`docs/staging/evidence/claims/claims-register.csv`:

```
claim,surface_path,flag,effective_value,demonstrated(Y/N),artifact,decision(KEEP|RETRACT|HEDGE),owner,due
```

**No claim may end the soak in state "not demonstrated and not retracted."**

---

## 4. Complete surface inventory (coverage checklist)

**This section is driven by the external feature-inventory workflow.** When that inventory lands, it becomes the
authoritative checklist and every row below is reconciled against it. Any feature in the inventory but absent
here is a coverage gap; **any feature absent from the inventory is untested, and that absence is itself a
finding.**

Structural rule, derived from the repo's own failure pattern: **inventory by code evidence, not by navigation.**
A page reachable only by typing its URL passes a screenshot test and is still unreachable by customers. For every
feature the checklist records **both** "does it work" **and** "can a customer get to it."

| # | Surface group | Includes | Reachability check required |
|---|---|---|---|
| S1 | Bitcoin anchoring end-to-end | WIF signing → GetBlock broadcast → mempool.space UTXO/fees → confirmation → proof materialization | n/a (backend) |
| S2 | Bitcoin safety loops | detect-reorgs, monitor-stuck-txs, rebroadcast-txs, consolidate-utxos, monitor-fees | **all 5 unscheduled in prod** |
| S3 | Batch anchoring | Trigger A (`*/30` batch-anchors), Trigger B (`0 3 * * *` forced flush), daily flush | n/a |
| S4 | Proof materialization + backfill | `anchor_proofs`, `populate-confirmation-proofs`, both backfill jobs | **backfills unscheduled** |
| S5 | Every dashboard | 1280px + 375px | **yes** |
| S6 | Auth | signup, login, activation, invite, password reset | **yes** |
| S7 | DocuSign connector | OAuth, webhook, reconciliation, drift, failure poll | **yes** |
| S8 | Google Drive connector | OAuth, webhook, changes runner, subscription renewal | **yes** |
| S9 | Folders | | **yes** |
| S10 | Job queue | every job type, retry/backoff, `last_error`, lease CAS | n/a |
| S11 | Pipeline + controls | throughput monitor, org-queue-scheduler | **yes** |
| S12 | MCP server | 16 tools | **yes** |
| S13 | Both SDKs | JS (never published) + Python (live, ships internal notes) | **yes** |
| S14 | Public API | v1 + v2 operations | **yes** |
| S15 | Webhooks | delivery, retries, failure handling | n/a |
| S16 | Billing / credits / checkout | incl. `PricingPage` (**on no route**), `paymentTierRouter` (**never mounted**) | **yes — known broken** |
| S17 | Public verification + search | incl. `/.well-known/arkova-keys.json` (**404s — `proof-keys.ts` never imported**) | **yes — known broken** |
| S18 | Revocation | `process-revocations` | **yes** |
| S19 | Attestations | `anchor-attestations` | **yes** |
| S20 | Admin surfaces | every admin page + admin API | **yes** |
| S21 | Cross-tenant isolation | two real orgs (§5) | n/a |
| S22 | Claims integrity | §3 | n/a |
| S23 | **Orphaned/unreachable features** | 11 unlinked routes, 8 zero-importer hooks incl. 2 HIPAA controls (inactivity timeout, MFA gate) | **this IS the test** |

S23 is not a footnote. Two HIPAA controls marked Done are wired to nothing. For SOC 2 that is the same class of
defect as §3.3: a control asserted as operating that does not operate.

---

## 5. Per-surface method — the three required things

For **every** surface in §4, the checklist records three things. The third is the one always skipped.

**(a) A real end-to-end assertion on observable state — never a 200.**
**(b) SOC 2 Type 2 evidence capture — operating effectiveness over the period: named artifact, storage location, timestamping.**
**(c) The named hollow-assertion trap — the specific way this surface could pass while broken.**

### 5.0 Evidence integrity rules (apply to every artifact)

Learned from a real error in this session (§0.1): a stale output file made two dead services read as `healthy`.

1. **Fresh output file per probe.** Never reuse a path across iterations; `curl` does not truncate on failure.
2. **Record the transport status separately from the body.** `http=000` is not a pass; a body with no status is not evidence.
3. **Timestamp at capture** (`date -u +%FT%TZ`), from the capturing host, stored alongside the artifact.
4. **Artifacts are append-only** under `docs/staging/evidence/<surface>/<UTC-date>/`.
5. **Every artifact names the rig project ref, Cloud Run service + revision, image digest, and PR head SHA** — per §1.11A, evidence may not be copied across heads, services, or projects.
6. **Daily hash manifest.** At each day's close, `sha256sum` every artifact into `manifest-DAY-N.txt` and commit it. This is what converts a pile of files into tamper-evident period evidence.

### 5.1 Worked examples

**S17 — Public verification + search** *(the canonical hollow-assertion example)*

- **(a)** Query a term with known matches; assert the **result set contents and p95 latency**, not the status code.
  Separately `GET /.well-known/arkova-keys.json` and assert **200 + valid key material** (currently **404**, because
  `proof-keys.ts` is never imported).
- **(b)** `docs/staging/evidence/S17/<date>/search-latency.json` — per-query latency + result counts, sampled hourly
  for 7 days. Availability evidence for A1.
- **(c) TRAP:** *`search.arkova.ai` returns HTTP 200 on every query while the underlying RPC takes 6.5s and
  intermittently 500s.* A status-code check reports this surface as healthy for 7 days. **Control:** assert on
  result contents + record the RPC's own latency/error rate, not the HTTP envelope.

**S1 — Bitcoin anchoring end-to-end**

- **(a)** Per stage, assert the DB state that stage owns: signed → tx hex present; broadcast → txid returned by
  GetBlock; confirmed → `anchors.status='SECURED'` **and** confirmations ≥ 1; proof → a row in `anchor_proofs`
  whose `block_header` is **80 raw bytes** (`bytea`, `\x` hex). End-to-end = a document fingerprint submitted on
  Day 1 is independently verifiable from its proof bundle alone by Day 7.
- **(b)** `docs/staging/evidence/S1/<date>/anchor-lifecycle.json` — one row per anchor with stage timestamps.
- **(c) TRAP 1:** `USE_MOCKS=true` fakes the chain client and returns synthetic txids — everything "confirms"
  instantly and nothing touches a real network. **Control:** assert `USE_MOCKS=false` on the running revision and
  independently confirm each txid on a signet explorer.
  **TRAP 2:** `MEMPOOL_API_URL` set → confirmation silently never happens; anchors sit `SUBMITTED` forever with no
  error. **Control:** assert the var is unset **and** that SECURED count rises daily.

**S16 — Billing / credits / checkout**

- **(a)** Complete a **real Stripe test-mode purchase** and assert credits actually land in `org_credits` and the
  ledger balances. Assert `PricingPage` is reachable from a route and `paymentTierRouter` is mounted.
- **(b)** `docs/staging/evidence/S16/<date>/checkout-e2e.json` + Stripe test-mode event ids.
- **(c) TRAP:** the checkout API returns 200 and the webhook is never delivered, so credits never arrive — the
  customer is charged and gets nothing. **Control:** assert on the **credit balance delta**, never the checkout
  response.

**S2 — Bitcoin safety loops** *(all 5 unscheduled in prod)*

- **(a)** Force each loop to run and assert it did work: `detect-reorgs` observes a chain tip and writes its
  observation row; `monitor-stuck-txs` flags a deliberately stuck tx; `rebroadcast-txs` re-broadcasts it.
- **(b)** `docs/staging/evidence/S2/<date>/safety-loops.json`, every day for 7 days — dormant-control evidence is
  exactly what CC7.1 needs.
- **(c) TRAP:** the Scheduler job is bound to a route the revision does not serve → **404 forever, no log, no
  Sentry**, and the job shows as "succeeded" at the Scheduler level. **Control:** assert non-404 **and** the
  handler's observable state change (§2.3 step 3).

**S12/S13 — MCP + SDKs**

- **(a)** Drive all 16 MCP tools from a real client; assert each tool's observable effect. Install both SDKs from
  their published artifacts (not the repo) and run their test suites against the rig.
- **(c) TRAP:** testing the SDK from the repo working tree instead of the published artifact — the JS SDK has
  **never been published**, so a repo-based test passes while no customer can install it. The Python SDK ships
  internal engineering notes.

---

## 6. Cross-tenant isolation — mandatory, never before proven

This is the coverage nobody has established. It was the security vendor's **primary objective and it remains
unmet**: their Org B never authenticated. **Their package must never be cited as evidence for tenant isolation.**

`e2e/cross-tenant.spec.ts` exists and requires two genuinely separate, genuinely authenticated organisations.

- **(a)** Org A and Org B, each with real authenticated users. For every tenant-scoped surface, assert Org B
  **cannot** read/write/enumerate Org A's anchors, documents, folders, API keys, credits, webhooks, or audit rows —
  via UI, public API, MCP, **and** direct PostgREST with Org B's JWT. Assert public-by-design endpoints are
  unaffected (they are cross-tenant intentionally and must not be flagged).
- **(b)** `docs/staging/evidence/S21/<date>/cross-tenant.json` + the RLS suite result. Re-run **daily**, so the
  control is shown to operate over the period. This becomes the CC6.1 centrepiece.
- **(c) TRAP:** Org B never actually authenticates, so every request is an anonymous 401 and the test "passes"
  while proving nothing — **this is exactly what happened to the vendor.** **Control:** assert Org B's session is
  live (it can read its *own* data) immediately before each isolation assertion. An isolation test that cannot
  first prove positive access is void.

```bash
E2E_SEED_PASSWORD=... E2E_SUPABASE_SERVICE_KEY=... \
  npx playwright test e2e/cross-tenant.spec.ts --reporter=json
```

The 46-spec suite needs only those two vars wired to the rig, and **fails loudly (exit 1)** if absent — it will not
silently pass.

---

## 7. Day-by-day schedule

Clock = **Cloud Run worker uptime** on the rig, not a probe loop (probe loops die on restart). Rollover 00:00 UTC.
Day 0 is not part of the 7 days.

| Day | Focus | Trigger cycles | Observed / captured |
|---|---|---|---|
| **0** | **Gate 0 + provisioning.** §1 flag matrix; rig 0400→0405; secrets/Cloud Run/Scheduler; fixture seed; preflight `clean_mirror`; `SOAK_GATE_DISABLED=false`; zombie check; **change freeze begins**; alert cleanup (§8). | — | Gate 0 artifacts; preflight output. **Clock does not start until all four Gate 0 exits pass.** |
| **1** | Anchoring + auth. Submit Day-1 anchor cohort (must reach verifiable proof by Day 7). Full 46-spec E2E. Cross-tenant #1. | Trigger A ×2 | Baselines for every surface; `manifest-DAY-1.txt` |
| **2** | Connectors (DocuSign, Drive) incl. **connection loss + recovery**. Job queue under load. Claims §3.1/§3.2 assertions. | A ×2, **B (03:00 daily flush)** | First flush observation; connector artifacts |
| **3** | Public API (v1+v2), MCP 16 tools, both SDKs from published artifacts, webhooks incl. retries + failure handling. | A ×2, B | SDK install logs; webhook retry evidence |
| **4** | Billing: real Stripe test-mode purchase → credits land. Revocation, attestations. **Mid-soak rollback rehearsal** (apply a `-- ROLLBACK:` block, confirm `/health`, re-apply). | A ×2, B | Rollback rehearsal record (T3 requirement) |
| **5** | **Orphan sweep (S23).** Every unlinked route, `PricingPage`, `paymentTierRouter`, `/.well-known/arkova-keys.json`, all 8 zero-importer hooks incl. both HIPAA controls. Reachability, not just render. | A ×2, B | The reachability finding list |
| **6** | Dashboards at 1280px + 375px. Admin surfaces. Fraud/compliance/expiry (§3.3) with flags ON. Sustained load. | A ×2, B | UAT screenshots; fraud detection rows |
| **7** | **Proof close-out.** Day-1 cohort must verify **offline from its proof bundle alone**. Cross-tenant #2 (independent re-run). Final flush. Assemble evidence pack + go/no-go. | A ×2, B | Final manifest; §10 decision |

**Every day, without exception:**

- **Daily flush observation** — the 03:00 UTC forced flush (`batch-anchors?force=true`) drained the pending queue;
  record queue depth before/after.
- **Per-org isolation check** — the §6 assertion, re-run. Daily, not once.
- **All 5 Bitcoin safety loops** forced and asserted non-404 with observable effect.
- **Alert review** — every alert fired in 24h, triaged real vs noise (§8), with the count recorded.
- **`sha256sum` manifest** committed.

---

## 8. Pre-soak pre-mortem

*It is 7 days later. The soak completed green. We shipped, and a customer hit a visible failure. What happened?*

| # | Cause | Why the soak missed it | Control (pre-soak) |
|---|---|---|---|
| **P1** | **Alert fatigue — the leading candidate.** ~**25,000 false cron-failure events in 13 days** across **four duplicate monitors** watching the same jobs while those jobs ran normally, plus a **dead-tuple alert firing every 2 minutes on a 16-row table**. A real outage is invisible inside that. | The soak's own alerts drown in the same noise; nobody reads alert #24,998. | **Blocking, Day 0:** delete 3 of the 4 duplicate cron monitors; fix or delete the dead-tuple alert; then require a **24h quiet baseline** before the clock starts. Any alert during the soak is then signal by construction. |
| **P2** | A flag was off, so the feature was never exercised. | Green result across a disabled product. | Gate 0 (§1) with runtime-path resolution + the ON-by-default rule. |
| **P3** | `USE_MOCKS=true` — nothing touched a real chain. | Everything "confirmed" instantly. | Gate 0 exit criterion 4 + independent signet explorer confirmation. |
| **P4** | `MEMPOOL_API_URL` set — confirmation silently dead. | Anchors sit SUBMITTED; no error anywhere. | Gate 0 exit 4 asserts unset; daily SECURED-count-rises check. |
| **P5** | Cron bound to an unserved route → **404 forever, silently**; Scheduler reports success. | "All jobs scheduled" ≠ "all jobs run." | §2.3 step 3: assert non-404 **and** observable state change. |
| **P6** | **Feature shipped but unreachable** — the repo's proven pattern. | Screenshot tests navigate by direct URL, so the page renders and the test passes while no customer can reach it. | S23 + the reachability column in §4; Day 5 orphan sweep. |
| **P7** | **The feature inventory was incomplete**, so a whole surface was never listed. | You cannot test what you did not enumerate. | Inventory derived from **code evidence** (routes, migrations, git history, prod schema), not memory. Absence from the list is itself a finding. |
| **P8** | **A merge deployed to prod mid-soak.** `DEPLOY_WORKER_PAUSED=false` today. | Evidence pinned to a head SHA that prod no longer runs; §1.11A invalidates it. | **Change freeze from Day 0.** Set `DEPLOY_WORKER_PAUSED=true`, or require RTE sign-off per merge and re-pin evidence. Any runtime/migration commit after a soak invalidates exact-head evidence. |
| **P9** | We proved the software works while **advertising things it does not do**. | Claims were never in scope. | §3 claims register; no claim ends "not demonstrated and not retracted." |
| **P10** | **Tenant isolation "passed" without Org B ever authenticating** — the vendor's exact failure. | Anonymous 401s look like isolation. | §6: prove positive access before every isolation assertion. |
| **P11** | Evidence was **stale or copied** — a leftover file read as `healthy` (§0.1 — this actually happened). | Artifact looked valid. | §5.0 evidence-integrity rules + daily hash manifest. |
| **P12** | Green gate meant nothing: `SOAK_GATE_DISABLED=true`. | Gate passes without reading the body. | §2.4, flipped Day 0 and re-verified Day 7. |
| **P13** | **86% proof gap** shipped as-is; a customer asked for an offline proof bundle and got an error — including our flagship partner's own record. | Anchoring is genuinely healthy; the gap is in *proof*, not anchoring. | Day 7 Day-1-cohort offline verification proves the path works **for new records**; the historical backlog is a **founder decision** (§10 G8), not something the soak can close. |
| **P14** | Load never approached real concurrency. | Sequential smoke ≠ soak. | Volume + concurrency in the load harness; record p95 under concurrent org load. |
| **P15** | Rig ≠ prod schema (rig was 0400, prod 0405). | A migration-dependent path behaves differently. | Gate 0 step 0.1; re-verify head at Day 7 (prod may advance if the freeze is lifted). |

---

## 9. SOC 2 Type 2 control mapping

Type 2 requires evidence that controls operated **throughout the period**. Daily artifacts + the hash manifests are
what make this period evidence rather than a point-in-time screenshot.

| TSC | Control | Soak evidence | Gap / honest note |
|---|---|---|---|
| **CC6.1** logical access | Tenant isolation enforced by RLS | §6 daily cross-tenant runs, both orgs authenticated; RLS suite | **Never before proven.** Vendor's package is NOT evidence — their Org B never authenticated. |
| **CC6.1** least privilege | Prod service account privilege | — | **GAP — no evidence.** Prod runs with **Owner** on the whole GCP project; 3 non-expiring downloadable keys; the same identity can impersonate one that reads the treasury WIF (SCRUM-3023). The §0.1 teardown was performed by that identity. **Founder authorisation required; the soak cannot close this.** |
| **CC6.6/6.7** boundary + transmission | TLS posture | §4 S14/S17 | **GAP** — two public sites still accept outdated TLS. Config fix; likely audit finding. |
| **CC6.8** API authn/authz | 19 prod API keys, HMAC-SHA256, scopes, rate-limit tiers, revocation | Exercise scope enforcement + revocation daily; assert a revoked key is refused | Key **designation** (owner, scope, tier, expiry) is required audit evidence — see §11. |
| **CC7.1** detect config/vuln | Bitcoin safety loops, connector health, db-health | §4 S2 daily forced runs | **52 of 105 cron routes have no prod schedule**, incl. all 5 Bitcoin safety loops + both proof backfills. Soak proves they *can* operate; **prod scheduling must follow or the control remains dormant in prod.** |
| **CC7.2** monitoring | Alerting | §8 P1 cleanup + daily alert triage counts | **GAP today.** ~25,000 false events/13 days across 4 duplicate monitors + a 2-minute dead-tuple alert. An auditor would reasonably conclude we cannot detect incidents. Must be cleaned **before** Day 1. |
| **CC7.3/7.4** incident response | Rollback rehearsal | Day 4 rehearsal record | |
| **CC8.1** change management | Change freeze, PR gates, staging evidence | Freeze log; `SOAK_GATE_DISABLED=false` for the period | **Any gate result while the bypass was `true` is not citable.** |
| **A1.1/A1.2** availability | Worker uptime, latency, queue depth | 7-day uptime, hourly p95, daily queue depth | Search p95 **6.5s** with intermittent 500s is an availability finding today (§3.1). |
| **PI1.1–PI1.3** processing integrity | Anchor lifecycle correctness; credits conserve | §5.1 S1 per-stage assertions; Day-7 offline proof; credit conservation | **GAP — 85.4% (2,967,774) of SECURED anchors have no per-document proof.** Only new records (≈1 Aug onward) have coverage. The offline-verification promise is unmet for historical records. |
| **PI1.2** completeness of audit records | Audit trail writes | Assert rows land for every audited action | **GAP** — 8 code paths attempt audit writes that never send; emergency-access audit trail has **zero rows** in prod. An audit trail that silently does not record is worse than none. |
| **All** claims accuracy | Public + auditor-facing claims | §3 claims register | **GAP** — fraud detection asserted **"Continuous"** to the auditor at `soc2-type2-evidence-matrix.md:42` while its flags are false. Correct before the auditor sees it. |

---

## 10. Go / No-Go criteria

Decided in advance. **Every G-criterion is blocking.** Measured at Day 7 close.

| # | Criterion | Measure | GO threshold |
|---|---|---|---|
| **G1** | Gate 0 complete | All 4 exit criteria (§1.4) | 100%, no exceptions |
| **G2** | Coverage | Features in inventory with all three of (a)(b)(c) recorded | **100%.** Any unlisted or untested feature = NO-GO until listed and tested or explicitly accepted in writing |
| **G3** | Anchoring integrity | Day-1 cohort verifiable **offline from proof bundle alone** at Day 7 | 100% of cohort |
| **G4** | Tenant isolation | Daily cross-tenant runs, Org B authenticated each time | **7/7 days, zero leaks** |
| **G5** | Safety loops | All 5 forced daily, non-404, observable effect | 7/7 days |
| **G6** | Alert signal | False-positive alerts during soak | **< 10 total over 7 days.** Above that, monitoring is not audit-ready |
| **G7** | Claims register | Claims in "not demonstrated and not retracted" | **Zero** |
| **G8** | Proof backlog | Founder decision recorded: backfill before launch **or** publish the limitation | Decision recorded either way — **not** silence |
| **G9** | Evidence integrity | Daily hash manifests, no copied/stale artifacts | 7/7 committed |
| **G10** | Change freeze | Runtime/migration commits to prod during soak | **Zero**, or evidence re-pinned + residual-risk note |
| **G11** | Gate honesty | `SOAK_GATE_DISABLED` | `false` for the entire period, verified at both ends |
| **G12** | Availability | Worker uptime; search p95 | ≥ 99.5% uptime; **search p95 < 2s** (today 6.5s → NO-GO without a fix) |

**Automatic NO-GO, independent of everything else:**

- Any cross-tenant leak.
- Any anchor SECURED without a materialisable proof **in the Day-1 cohort**.
- Any credit charged without credits delivered.
- Any claim in §3 still asserted publicly or to the auditor while demonstrably false.

**Explicitly NOT blocking for launch** (they are founder decisions or tracked remediation, and the soak cannot
close them):

- The 2,967,774-record historical proof backlog — **G8 requires a recorded decision, not a fix**.
- SCRUM-3023 privileged-access remediation — **requires founder authorisation**; track separately.
- Prod Scheduler bindings for the 52 unscheduled cron routes — the soak proves they operate; **prod scheduling is
  follow-on work that must be tracked, or the control stays dormant in prod**.

---

## 11. API key designation (audit evidence, CC6.8)

Prod holds **19 API keys**. `api_keys` carries `org_id`, `key_prefix`, `key_hash` (HMAC-SHA256 — raw keys never
persisted), `name`, `scopes[]`, `rate_limit_tier`, `last_used_at`, `expires_at`, `is_active`, `revoked_at`,
`revocation_reason`, `created_by`, plus FERPA fields (`ferpa_exception_category`, `institution_type`,
`access_purpose`, `ferpa_verified`) and `agent_id`.

An auditor will ask who holds each key and what it can do. Produce
`docs/staging/evidence/CC6.8/api-key-designation.csv` before Day 7 — **never including `key_hash`**:

```sql
select k.key_prefix, k.name, o.display_name as org, k.scopes,
       k.rate_limit_tier::text as tier, k.is_active,
       k.revoked_at is not null as revoked,
       to_char(k.expires_at,'YYYY-MM-DD') as expires,
       to_char(k.last_used_at,'YYYY-MM-DD') as last_used,
       k.ferpa_verified, k.access_purpose
from api_keys k left join organizations o on o.id = k.org_id
order by k.is_active desc, o.display_name, k.name;
```

For each key record: owner, business purpose, least-privilege justification for its scopes, expiry, and rotation
plan. **Any key with no expiry, no identified owner, or no recent use is a finding** — flag it rather than leaving
it undesignated. During the soak, assert daily that a **revoked** key is refused and that scope enforcement holds.

---

## 12. Evidence pack layout

```
docs/staging/evidence/
  gate0/              env-*.txt, db-{prod,rig}.txt, frontend-flags.txt,
                      flag-decision-matrix.csv
  claims/             claims-register.csv, semantic-search-*.json,
                      ades-sdk-*.log, fraud-detection-runs.json
  S1..S23/<UTC-date>/ per-surface artifacts (a)+(b)
  CC6.8/              api-key-designation.csv
  manifest-DAY-{1..7}.txt        sha256 of every artifact, committed daily
  SOAK-SUMMARY.md                final go/no-go against §10
```

Every artifact names: rig project ref `gnkuaywlpmsaezwvlvhk`, Cloud Run service + revision, image digest, PR head
SHA, capture timestamp (UTC). Per §1.11A evidence may not be copied across heads, services, or projects.

---

## 13. Open items requiring the founder

Carried here so they are not lost between the launch-readiness review and this soak:

1. **Authorise the privileged-access fix** (SCRUM-3023) — Owner rights on prod's runtime identity + 3 non-expiring
   keys + the treasury-key impersonation path. Highest security risk we carry. Removing Owner alone is insufficient;
   both paths must close together.
2. **Decide the proof-backfill question** (G8) — backfill before launch, or state the limitation plainly in
   customer material and the HakiChain conversation.
3. **Decide the claims retractions** (§3) — particularly the priced `/ai/search` offer on `/developers` and the
   fraud-detection assertion in the SOC 2 evidence matrix.
4. **Remove the outside vendor's write access** to the deployment-config repository.
5. **Change freeze** — approve `DEPLOY_WORKER_PAUSED=true` for the soak window.

---

_Runbook prepared 2026-08-11 by the RTE. Every fact in §0 was verified live against production, the rig, GCP, or
GitHub on that date — not carried from any prior document. Items that could not be verified are marked as gaps or
as decisions, never asserted._
