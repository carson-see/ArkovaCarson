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

> **DEG-7 protection (do not delete this secret).** Secret `treasury-wif-legacy-soak-2026-08-staging` is named
> for the deleted legacy rig but is **load-bearing for the fullsoak rig**: it is the rig's live signet treasury
> WIF binding. Deleting it during teardown hygiene stops the worker, and since the soak clock is rig uptime,
> that costs soak days. Do NOT delete it, and do NOT re-point the rig to a renamed secret mid-window — that
> forces a new revision and a different derived treasury address, and voids the clock.

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

> **[Corrected 2026-08-12 — see §4.5 and FD-13.]** This section is the *plan*; it was **not** executed as written.
> The rig binds **25 of 109 code routes (22.9%)**, not "all". DEG-1 added exactly two jobs (`anchor-expiry-sweep`,
> `anchor-public-records`) and re-timed four to prod cadence; the 5 Bitcoin safety loops are among the 25 bound.
> The remaining **84 routes are DECLARED-UNTESTED** (force-run-testable, not continuously scheduled) — family
> breakdown in §4.5. Read the numbered procedure below as the intended method, not as an achieved state.

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

> **[Corrected 2026-08-12 — §4.5 / FD-13.]** This did not happen. The rig ended Day 0 with **25 of 109 routes
> bound (22.9%)** — the 5 Bitcoin safety loops among them — and **84 routes DECLARED-UNTESTED**. The Day-7 report
> must carry FD-13's fraction, never this paragraph's "all".

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

**DEG-6 re-certification rule (decided at Day 0, before it is needed).** Preflight Check 5 requires
`submitted_anchors > 0` and the classifier returns `clean_mirror` only when no check fails — so the moment the
soak *works* (a SUBMITTED anchor confirms to SECURED), Check 5 fails and the environment reclassifies away from
`clean_mirror`. The rule for this window: `environment_type = clean_mirror` is captured **once, at Day 0**, and
hashed into `manifest-DAY-0`. Check 5 failing after the clock starts because anchors are confirming is
**expected healthy behaviour and is not contamination**; it must be recorded as such on the day it first occurs
and never "repaired". Under no circumstance may a SUBMITTED row be hand-inserted to re-green the preflight —
that is the fabricated-anchor class Gate 0 removed. If a Day-7 re-certification is wanted, fix the check
(`submitted_anchors > 0 OR secured_anchors_created_after_clock_start > 0`) in a post-window PR, not the
environment.

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

## 4. Reconciled coverage — every LIVE feature in exactly one state

> **Reconciled 2026-08-12 under the founder's ruling that the 7-day soak covers the ENTIRE application:** the rig
> worker, `app.arkova.ai` (React frontend, full mode), `search.arkova.ai` (same frontend, hostname-gated
> search-only mode — `src/App.tsx` `isSearchSubdomain()`, ~line 159), and the `edge.arkova.ai` Cloudflare Worker.
> Standard: SOC 2 Type 2, no hollow soak. **Every LIVE feature is in exactly one of two states: IN-SCOPE with a
> named, mechanical assertion, or DECLARED-UNTESTED with a written reason. Zero features in neither state. A
> Day-7 report implying 100% coverage is an automatic NO-GO (G13).**

### 4.0 Provenance — the inventory file is missing, and this table says so

The feature-inventory workflow this section was waiting for produced numbers that survive in two documents
(~1,151 features across 7 domains per the pre-mortem BL-7; 596 features / **400 LIVE** after the checklist's
`MISSED_BY_INVENTORY` correction, §8.1–8.2 of `PRE-SOAK-CHECKLIST-AND-PREMORTEM.md`), **but the inventory file
itself is not in the repository.** A full-tree search on 2026-08-12 found no artifact under `docs/` (or anywhere
else in the working tree) containing the per-feature rows; only the two documents' citations of its totals
survive. Consequently:

- The **400-LIVE ledger** is carried from the checklist's reconciliation and cannot be re-derived row-by-row.
- The internal decomposition of its **106 unplanned LIVE items** is unrecoverable, except where the checklist
  names weights in prose (the edge Worker = "6 route families").
- The denominator below is therefore **reconstructed from code evidence** captured live on 2026-08-12:
  `services/worker/src/routes/` (110 cron routes in `cron.ts` on `origin/main`; 106 on this working branch —
  the soak tests prod's build, so 110 governs), `services/worker/src/api/v1/` (75 non-test modules),
  `services/worker/src/api/v2/` (8 non-test modules), `admin.ts` (40 routes), `anchor.ts` (7), `billing.ts` (3),
  8 inbound webhook families in `index.ts` (stripe, middesk, docusign, adobe-sign, ats, checkr, veremark,
  microsoft-graph), `src/App.tsx` (92 `<Route>` elements; 10 named routes + catch-all in search-only mode),
  `src/pages/` (109 page components), `services/edge/src/` (7 route families: `/health`, `/report`,
  `/reports/dl/`, `/ai-fallback`, `/crawl`, `/x402`, `/mcp`; 16 MCP tools in `mcp-tools.ts`), the migration-greppable
  RPC surface (239 distinct `CREATE FUNCTION` names: 60 in `supabase/migrations/`, 179 in
  `docs/migrations-archive/` — against the checklist's live-prod measurement of **258 anon-executable
  functions**), and `sdks/` (3 packages: `mcp-server`, `langchain-ts`, `langchain`).

Missing-inventory items that could not be classified at all are listed in §4.3 — they are findings, not
footnotes.

### 4.1 Coverage, stated honestly

**[Corrected 2026-08-12 — see §4.5.]** **At least ~~301~~ 298 of 401 LIVE features (~~75.1%~~ 74.3%) are IN-SCOPE
with a named per-feature assertion.** Ledger arithmetic:
the checklist's 400 LIVE, plus 1 for the `search.arkova.ai` hostname-gated mode the inventory never listed;
in-scope = 278 (checklist plan) + 13 recovered by Gate 0 flag seeding (BL-3, agent-owned Day-0 work) + ~~3
recovered by binding the unbound credit-cron routes (§2.3)~~ **0 — the credit crons were never bound (§4.5)** +
6 edge route families now probed as the live
deployment + 1 search-hostname mode = **298**. This is a **floor**: the grouped mechanical sweeps below (the 258-
function RPC deny-sweep, the storage anon-deny probes, the security-trigger negative tests) give per-item
assertions to an unknown-weight portion of the remaining ≤103 ledger items, but because the missing inventory's
weighting is unrecoverable we do not claim the higher figure. Every one of the remaining items appears in §4.2
either under a grouped sweep or as an explicit DECLARED-UNTESTED row with a written reason — none is silent.
**Do not present any number in this section as 100%, and do not present 74.3% without its floor caveat.**

**The largest exclusions, named:** the production Bitcoin rail as production runs it (GetBlock broadcast + UTXO
listing, mainnet signing, the GCP KMS signing path — the rig anchors real signet through WIF + mempool.space);
the nine advertised-but-inoperable capabilities of pre-mortem §5.1, including the two **priced** dead offers
`/ai/search` and `/nessie/query` on the public `/developers` page; Stripe checkout end-to-end (every UI-wired
plan has `stripe_price_id = NULL`, #2049); Upstash rate limiting (the rig runs the in-memory limiter);
the prod-environmental fault class (the 2026-08-11 `PGRST002` schema-cache outage — the rig is structurally
incapable of reproducing it, G15); prod-only pg_cron jobs and Storage write-path RLS (prod is change-frozen);
per-trigger assertions for ~66 of 76 DB triggers (exercised incidentally, not individually asserted); and the
**2,967,774-anchor historical proof gap** (85.4% of SECURED anchors have no per-document proof — not a test
item; a founder decision under G8, where a recorded decision either way is the PASS and silence is the FAIL).

### 4.2 The coverage table

Structural rule, derived from the repo's own failure pattern: **inventory by code evidence, not by navigation.**
For every feature the table records both "does it work" and "can a customer get to it" (the S23 reachability
discipline). States: **IN** = IN-SCOPE, **DU** = DECLARED-UNTESTED. Assertions are mechanical — a query, spec,
or probe with a pass condition a second person can evaluate; "works" is not an assertion. `S#` cross-references
the surface groups used by §5, §7 and §12 (S24–S26 are new; §12's evidence layout extends to them).

#### A. Rig worker — Bitcoin anchoring and chain (S1–S4)

| S# | Feature | State | Assertion (named, mechanical) | Reason if out |
|---|---|---|---|---|
| S1 | Signet anchoring end-to-end (WIF sign → broadcast → confirm → SECURED) | IN | BL-2 PASS criterion verbatim: post-final-revision anchor reaches `status='SECURED'`; txid `confirmed:true` **with block height** on BOTH mempool.space/signet and blockstream.info/signet; `anchor_proofs.block_header` is 80 raw bytes (`bytea`, `\x` hex); boot log names the fee estimator. Daily: SECURED count rises monotonically excluding the frozen baseline (BTC8) | — |
| S1 | Dynamic fee estimation (mempool.space estimator, ceiling, fallback) | IN | Conditional on `FORCE_DYNAMIC_FEE_ESTIMATION=true` on the final rig revision (BL-2 fix): boot log reads `fee=Mempool`; per-broadcast fee rate recorded and > 1.005 sat/vB relay floor | — |
| S1 | GetBlock RPC broadcast + RPC inclusion proofs (prod's rail) **[Corrected 2026-08-12 DU→IN — §4.5 / FD-3]** | IN | FD-3 provider flip: the authorised pre-clock freeze-break deploy to `00013-mrw` (**2026-08-12T15:09:40Z**) set `BITCOIN_UTXO_PROVIDER=getblock` over the `fullsoak-btc-rpc` VPC connector, so the rig runs **prod's exact hybrid chain architecture** — RPC broadcast + RPC `gettxoutproof` inclusion proofs + mempool.space UTXO/fees. `fullsoak-daily-check.sh` A17/A17b assert the RPC node VM is RUNNING and within 2 blocks of the public signet tip | — (was DU as "mainnet-only, unreachable on a signet rig"; that is now **stale** — the flip put RPC broadcast + RPC inclusion-proof under soak. mempool.space still serves UTXO listing + fees, matching prod) |
| S1 | Mainnet signing + broadcast | DU | BTC9: zero mainnet broadcasts attributable to the rig, checked daily | Deliberately out of scope; the rig must never touch mainnet. PR #2140 backfill must not run in the window |
| S1 | GCP KMS signing path | DU | `/health` `kms` field captured daily (config-presence only, per DEG-8 caveat) | Rig sets no `GCP_KMS_KEY_RESOURCE_NAME`; WIF is the active signer. DEG-8 caveat applies verbatim |
| S1 | Treasury balance + `ENABLE_TREASURY_ALERTS` | IN | Balance read from a signet explorer directly (not `treasury-cache.ts`, BTC4); alert flag probe produces a named row delta. Note: the mainnet-explorer bug fix `e3ac0e928` enters the rig with the BL-1 rebuild | — |
| S2 | 5 Bitcoin safety loops (detect-reorgs, monitor-stuck-txs, rebroadcast-txs, consolidate-utxos, monitor-fees) | IN | Forced daily, 7/7: non-404 AND a named observation/row delta per loop (G5). First operating-effectiveness evidence these controls have ever had; prod scheduling remains follow-on work (CC7.1 note) | — |
| S3 | Batch anchoring — Trigger A, Trigger B, forced flush | IN | Queue depth before/after each flush recorded; PENDING falls; one flush observed end-to-end before clock start (§2.2 open question). DEG-1 cadence caveat applies verbatim (rig cadence ≠ prod cadence) | — |
| S4 | Proof materialization + both backfill jobs | IN | Every soak-window SECURED anchor gains an `anchor_proofs` row with an 80-raw-byte header; backfill jobs forced with named row deltas | — |
| S4 | **Historical proof backlog: 2,967,774 SECURED anchors (85.4%) with no per-document proof** | DU | — | Not closeable by any soak (pre-mortem §5.4). G8: founder decision recorded — backfill before launch, or publish the limitation. A recorded decision is the PASS; silence is the FAIL |

#### B. Rig worker — cron, jobs, queue (S2/S3/S10/S11)

| S# | Feature | State | Assertion (named, mechanical) | Reason if out |
|---|---|---|---|---|
| S10 | ~~All **110**~~ **25 of 109** cron routes Scheduler-bound **[Corrected 2026-08-12 — §4.5 / FD-13]** (`origin/main` = 109 distinct routes; 25 bound = 22.9%) | IN (25 bound) · DU (84 unbound) | §2.3 procedure *as executed*: the 25 bound routes get per-job forced runs asserting non-404 AND a named DB row-count delta (C4/F5) — a 200 is never a PASS. The **84 unbound routes are DECLARED-UNTESTED** (force-run-testable, not continuously scheduled), by family in §4.5: 42 public-record feeders, 13 ops, 9 connector, 8 credit/billing, 6 expiry, 4 proof-backfill, 3 BigQuery | 84 unbound: live-external-registry / OAuth-tenant / CE-credential / BigQuery-dataset dependencies, or must-never-run-on-a-signet-rig (`mainnet-migration`) — enumerated §4.5 |
| S10 | Cron payloads gated by must-stay-OFF flags (Nessie, demo-injector, synthetic-data, maintenance) | DU | Binding + response class asserted; flag asserted OFF on the running revision daily | Flags must stay off (pre-mortem §5.3); enabling them fabricates soak data or tests a maintenance page |
| S11 | `org-queue-scheduler` | IN | DEG-5 rule: INTERNAL(13) failure tracked daily against prod finding F-1; root cause named or acceptance recorded in writing before Day 0 | — |
| S10 | Job queue: every job type, retry/backoff, `last_error`, lease CAS | IN | Induced-failure job shows retry/backoff rows and bounded `last_error`; lease-CAS contention probed under pgbench concurrency; queue depth sampled daily | — |
| S11 | Throughput monitor + pipeline controls | IN | Monitor row advances daily; forced run row delta | — |

#### C. Rig worker — APIs, auth, billing, webhooks (S6/S14/S15/S16/S18/S19/S20)

| S# | Feature | State | Assertion (named, mechanical) | Reason if out |
|---|---|---|---|---|
| S14 | Public API v1 — 75 modules, excluding the named-dead rows below | IN | Per-module smoke asserting response schema + at least one auth-negative (401/403) per authenticated module; hourly availability + p95; scope enforcement + revoked-key refusal daily (K6/K7, CC6.8) | — |
| S14 | `/ai/search` (semantic search, **priced $0.010**) | DU | Claims probe A-3.1a/b runs anyway and records the lexical-vs-semantic outcome | `credential_embeddings` = 0 rows; edge fallback is literal `ILIKE %query%`; flag off in prod. Priced dead offer → claims register row 2, RETRACT-recommended |
| S14 | `/nessie/query` (**priced $0.010**) + all Nessie surfaces | DU | Daily probe asserts fail-closed | Founder directive 2026-08-01: Nessie stays OFF, permanently. Priced dead offer → claims register row 4, RETRACT-recommended |
| S14 | Visual fraud detection (`ai-fraud-visual`) | DU | Probe asserts the documented 410 daily | Returns HTTP 410 unconditionally (pre-mortem §5.1) |
| S14 | AI fraud scoring (`ai-integrity` / `computeIntegrityScore`) | DU | — | No caller in code (pre-mortem §5.1) |
| S14 | Fraud detection | DU | Claims probe A-3.3 daily with flags ON on the rig; DB rows sampled | Results filtered out of all six display surfaces; asserted "Continuous" to the SOC 2 auditor (`soc2-type2-evidence-matrix.md:42`) → claims register rows 6–7 |
| S14 | AdES signatures | DU | Claims probe A-3.2 from clean installs of both published SDKs, verdict recorded | Defaults to `aws_kms`; no AWS account exists. Ships in published npm packages — a false claim needs a corrective release (claims register row 9) |
| S14 | Compliance engine | DU | `get_flag` probe recorded | Flag gates nothing (pre-mortem §5.1) |
| S14 | Partner provisioning (**the HakiChain onboarding path**) | DU | Flag seeded at Gate 0 and `get_flag` probe recorded; forced run recorded if it produces a delta | Pre-mortem §5.1 classifies it cannot-be-exercised; flag seeding alone is not a demonstration. Do not promise it to partners |
| S14 | Public API v2 — 8 modules (agentTools, auth, openapi, problem, rateLimit, resourceDetails, scopeGuard, search, router) | IN | Same per-module discipline as v1 + the `mcpParity` spec green against the rig | — |
| S14 | Public verify (`GET /api/v1/verify/{id}`) | IN | Known public id → 200 with verification body; unknown id → 404 (not 503); hourly | — |
| S17 | `/.well-known/arkova-keys.json` | IN | GET asserted 200 + valid key material. **Currently 404 (`proof-keys.ts` never imported): recorded as a reachability FINDING, never converted to a pass by softening the assertion** | — |
| S6 | Auth: signup, login, activation, invite, password reset | IN | Daily Playwright E2E; recipient activation gets an explicit spec (launch-blocker fix `225dbfc04` enters with the BL-1 rebuild) | — |
| S16 | Credits: ledger, enforcement, conservation | IN | Charge → 201; exhaustion → 402 `insufficient_credits` (proven at Gate 0); `reconcile-credit-conservation` cron bound and row-delta asserted; conservation invariant checked daily | — |
| S16 | **Stripe checkout end-to-end (purchase → credits land)** | DU | Daily probe records the `stripe_price_id IS NULL` state of every UI-wired plan | 100% dead: all plans NULL (#2049, founder-blocked). §5.1 S16 worked example cannot run as written. Claims register row 12 |
| S16 | Stripe webhook signature handling | IN | Synthetic events: valid signature → row delta; invalid → 400/401 via `constructEvent()` | — |
| S15 | Inbound webhooks ×8 (stripe, middesk, docusign, adobe-sign, ats, checkr, veremark, microsoft-graph) | IN | Per family: valid-signature synthetic → named row delta; invalid signature → 400/401. docusign/drive/microsoft-graph flag-gated — Gate 0 turns them ON. Middesk: signature-rejection assertion only (provider inert in prod) | — |
| S15 | Outbound webhook delivery, retries, failure handling | IN | Forced-failure endpoint shows the retry schedule rows and terminal failure state | — |
| S18/S19 | Revocation + attestations | IN | `process-revocations` and `anchor-attestations` forced with row deltas; a revoked API key refused daily | — |
| S20 | Admin API (40 routes in `admin.ts`) + admin pages | IN | Every route: anon → 401/403; authenticated functional smoke; mutating routes exercised against rig fixtures only | — |
| S7/S8 | Connectors: DocuSign + Drive (OAuth, webhooks, changes runner, artifact enqueue/drain, renewal) | IN | Conditional on Gate 0 seeding all connector flags: connection loss + recovery exercised (Day 2); `drain-connector-artifacts` row delta — never a 200 | — |
| — | Rules engine, rule-action dispatcher, queue reminders, expiry alerts | IN | Conditional on Gate 0 (BL-3): env-path flags set on the revision (a `switchboard_flags` row cannot reach an env-backed flag — PM-D); forced run per job produces a named row delta | — |
| S14 | Rate limiting as production runs it (Upstash) | DU | The rig's in-memory limiter IS asserted: 429 + `Retry-After` + limit headers on every response (K7) | Prod uses Upstash; no management credential exists (pre-mortem §5.2). Open shadow finding F-2 noted |
| — | `/health` + `/health?detailed=true` | IN | DEG-3 mitigation: `HEALTH_DETAIL_TOKEN` set on the rig; hourly detailed probe asserts `drainStalled=false`, `pendingCount`, `lastSecuredAt` advances daily, `feeRateSatVb` non-null. The undetailed `checks.anchoring` constant is never cited as anchoring evidence | — |
| — | Prod-environmental fault class (PGRST002 schema-cache) | DU | Prod `/health` monitored throughout the window; any degradation is a material finding about prod | The rig runs a different database and PostgREST and is structurally incapable of reproducing it (pre-mortem §5.2). G15 residual-risk statement mandatory |

#### D. `app.arkova.ai` — React frontend, full mode (S5/S6/S17/S23)

The frontend deploys via Vercel, separately from the rig. Two complementary tracks, both honest about what they
test: **(1) rig-wired E2E** — a build of the frozen soak head with `VITE_*` env pointed at the rig, driven by
**daily Playwright E2E against the rig-wired stack** (the full 46-spec suite plus the assertions below), which
tests the frontend code at the pinned SHA against real rig behaviour; **(2) as-deployed probes** — daily
read-only synthetic requests against the live Vercel deployment, which test what customers actually receive but
cannot be pinned to the rig's head. Evidence artifacts label which track produced them.

| S# | Feature | State | Assertion (named, mechanical) | Reason if out |
|---|---|---|---|---|
| S5 | All 92 `<Route>` targets / 109 page components, full mode | IN | Daily Playwright E2E against the rig-wired stack at 1280px + 375px: per-page render assertion + one named interaction per page; zero console-error budget; screenshots archived per §5.0 | — |
| S6 | Client-side boundary: fingerprint, OCR, PII strip | IN | E2E upload spec asserts fingerprint computed in-browser and the network log contains **no document bytes** leaving the device (§1.6 guarantee, asserted not assumed) | — |
| S21 | Cross-tenant isolation via UI | IN | DEG-4-fixed spec daily: positive-access precondition (Org B reads its own data first), explicit blocked-state assertion (403/404/`Record Not Found`), **FAIL on `/login` redirect**, no service-role SECURED fixtures | — |
| S23 | Orphaned/unreachable features: 11 unlinked routes, `PricingPage` (no route), `paymentTierRouter` (never mounted), 8 zero-importer hooks incl. 2 HIPAA controls (inactivity timeout, MFA gate) | IN — **reachability IS the test** | Nav-graph crawl: every route proven reachable from rendered navigation or recorded as an orphan finding; each of the 8 hooks grepped for importers with the zero-importer result recorded | — |
| S5 | Auditor mode (VAI-04), theming, route prefetch | IN | E2E toggle assertions in the daily run | — |
| S17 | Live `app.arkova.ai` as deployed | IN | Daily read-only probes: `GET /` + key public routes → 200 + expected app shell; deployed bundle identity captured daily and any change during the freeze logged as an R7-class event | — |

#### E. `search.arkova.ai` — hostname-gated search-only mode (S24, new)

The same frontend bundle, gated by `isSearchSubdomain()` (`src/App.tsx`, ~line 159): 10 named routes (SEARCH,
ISSUER_REGISTRY, PUBLIC_PROFILE, VERIFY, VERIFY_FORM, ABOUT, PRIVACY, TERMS, THIRD_PARTY_NOTICES, CONTACT) plus
a catch-all redirect to SEARCH. This mode was **absent from the feature inventory** (+1 to the denominator).

| S# | Feature | State | Assertion (named, mechanical) | Reason if out |
|---|---|---|---|---|
| S24 | Search-only route gating | IN | Daily Playwright E2E against the rig-wired stack served under a `search.arkova.ai` host alias: exactly the 10 routes render; an app-only route (e.g. `/dashboard`) is NOT served; `*` redirects to SEARCH | — |
| S24 | Public search behaviour (lexical, as shipped) | IN | Known-match query → asserted **result-set contents** and p95 < 2 s (G12 — today 6.5 s, currently failing) + the RPC's own error rate; never the HTTP envelope (the §5.1 S17 trap) | — |
| S24 | Live `search.arkova.ai` as deployed | IN | Daily read-only probe of the live host: same query assertion + p95, recorded as as-deployed evidence | — |
| S24 | **Semantic** search on this surface | DU | A-3.1a records the semantic-vs-lexical outcome | Same root cause as `/ai/search`: 0 embeddings, `ILIKE` fallback. The claim, not the page, is what fails — see claims register rows 1–2 |

#### F. `edge.arkova.ai` — Cloudflare Worker (S12/S25)

**Honesty note, stated plainly:** the edge Worker is a separate deployment target (`wrangler`), not part of the
rig, and nothing in this soak pins it to a head SHA. It is therefore tested **as the live deployment**: synthetic
probes of each route family, daily, against `edge.arkova.ai` itself, with the deployment version captured at
every probe (`wrangler deployments list` id or response version header) so evidence names exactly what was probed.
Evidence from these probes describes the live edge at probe time — it does not describe a rig-pinned build, and
the Day-7 report must not imply otherwise. This supersedes pre-mortem §5.2's "cannot be exercised" row for the
edge: probing the live deployment is exercise; head-pinned certification remains out of reach and is said so.

| S# | Feature | State | Assertion (named, mechanical) | Reason if out |
|---|---|---|---|---|
| S25 | `/health` | IN | Daily GET with body assertion (never status-code-only) | — |
| S12 | `/mcp` — all 16 tools (anchor_document, get_anchor, get_document, get_fingerprint, get_organization, get_record, list_agents, list_orgs, nessie_query, oracle_batch_verify, search, search_credentials, verify, verify_batch, verify_credential, verify_document) | IN | Driven daily from a real MCP client; per-tool observable effect asserted; `search_credentials` runs the semantic-vs-lexical claims probe A-3.1b; `nessie_query` asserted fail-closed | — |
| S25 | `/report` + `/reports/dl/` (R2 signed URLs) | IN | Generate → download via signed URL → content assertion; expired/invalid signature → 403 | — |
| S25 | `/ai-fallback` | IN | Response-class probe; `ENABLE_AI_FALLBACK` default-false asserted (fallback OFF is the expected state) | — |
| S25 | `/crawl` (cloudflare-crawler) | IN | Probe with a fixture target; response schema asserted | — |
| S25 | `/x402` facilitator | IN (validation-only) | Negative/validation probes only: malformed payment → rejection asserted. **No funds move** — x402/Base is a payment rail, never anchoring, and the soak must not execute payments | — |
| S25 | Edge middleware: HMAC, JWT verify, origin allowlist, rate limit, prompt safety, anomaly detection, audit log | IN | Negative probes: bad HMAC → 401; disallowed origin → 403; malformed JWT → 401; audit-log row observed for a probe call | — |
| S25 | Edge kill-switch behaviour under a live flip | DU | Current kill-switch state asserted daily (read-only) | Flipping the kill switch on the **live** edge during the freeze is a prod mutation; the flip path is untested and said so |

#### G. Database surface (S21/S26)

| S# | Feature | State | Assertion (named, mechanical) | Reason if out |
|---|---|---|---|---|
| S21 | RLS + cross-tenant isolation, all four planes (UI, public API with Org B's key, MCP, direct PostgREST with Org B's JWT) | IN | §6 daily, 7/7: positive access proven immediately before every negative assertion; any leak = immediate hard stop (automatic NO-GO) | — |
| S26 | Anon-executable RPC surface — **258 functions live in prod** (checklist measurement); 239 names reconstructable from migrations | IN (grouped) | Scripted sweep on the rig: `POST /rest/v1/rpc/<fn>` as `anon` for every function; response class asserted against a deny-by-default allowlist; result diffed against the Day-0 baseline daily. The 258-vs-239 delta (~19 functions with no surviving migration source) is itself recorded as a finding | — |
| S26 | DB triggers — security-critical subset (~10: anchor immutability, SECURED-write guard, ledger guards, the Gate-0 anti-reseed triggers) | IN | Negative-test fixtures: each forbidden write attempted and the trigger's rejection asserted by error class | — |
| S26 | DB triggers — remaining ~66 of 76 | DU | Exercised incidentally by all soak DML; no per-trigger assertion | Enumerating and fixture-testing 76 triggers exceeds the Day-0 budget; risk accepted in writing here rather than silently |
| S26 | pg_cron jobs that exist only in prod (no repo migration creates them) | DU | — | Prod-only infrastructure; prod is change-frozen for the window and the rig cannot host jobs whose definitions are unrecoverable from the repo (§4.3 unclassifiable) |
| S26 | Storage buckets + storage RLS (prod-only) — read plane | IN (read-only) | Anon-deny probes against prod: unauthenticated GET per bucket path → 400/403 asserted (non-mutating) | — |
| S26 | Storage buckets — write plane + authenticated storage RLS | DU | — | Buckets exist only in prod; writing to prod during the freeze is prohibited. Bucket inventory itself is unrecoverable from the repo (§4.3) |

#### H. SDKs and published packages (S13)

| S# | Feature | State | Assertion (named, mechanical) | Reason if out |
|---|---|---|---|---|
| S13 | `sdks/mcp-server` (published npm) | IN | Installed **from the registry** (never the working tree — the §5.1 S12/S13 trap), suite run against the rig; installed version recorded; AdES tool probed per A-3.2 | — |
| S13 | `sdks/langchain-ts` (published npm) | IN | Same discipline; AdES claim probe A-3.2 | — |
| S13 | `sdks/langchain` (Python) | IN | Installed from the published PyPI artifact, suite vs rig; the internal-engineering-notes shipping defect recorded as a finding | — |
| S13 | The never-published JS SDK | DU | Registry lookup asserting absence, recorded | No customer can install it; its absence from the registry is the reachability finding, and repo-tree testing would be the exact false-pass §5.1 warns about |

#### I. Flags that must stay OFF (pre-mortem §5.3) — declared, not skipped

| S# | Feature | State | Assertion (named, mechanical) | Reason if out |
|---|---|---|---|---|
| S22 | `MAINTENANCE_MODE`, Replicate/QA-only AI providers, `DEMO_INJECTOR`, `SYNTHETIC_DATA`, `ENABLE_NESSIE_RAG_RECOMMENDATIONS` | DU | Asserted OFF on the running revision daily (flag matrix rationale column) | Enabling any of them fabricates soak data or tests a maintenance page |
| S22 | `ENABLE_ORG_CREDIT_ENFORCEMENT` in **production** semantics | DU | Rig code path exercised (Gate 0 behavioural proof stands); the prod-semantics gap asserted only as the open defect | #2050: the flag gates on balance while ignoring `anchor_quota`; enabling in prod would 402 HakiChain immediately. Code fix + founder decision required — the soak cannot resolve it |
| S22 | `ENABLE_PROD_NETWORK_ANCHORING` at mainnet scope | DU | `BITCOIN_NETWORK=signet` asserted daily | Signet-scoped by design |

### 4.3 Unclassifiable — the honest remainder

Items that could not be placed in either state because the evidence to classify them does not exist in the
repository. Each is a finding in its own right:

1. **The feature-inventory file itself** (~1,151 features / 7 domains; 596 / 400-LIVE corrected ledger) — absent
   from the repo. Its per-feature rows, its 7-domain decomposition, and the internal weighting of the 106
   unplanned LIVE items are unrecoverable. This table reconstructs the denominator from code; the two cannot be
   proven equivalent.
2. **The prod-only pg_cron job set** — asserted to exist by the checklist (§8.1); not enumerable from any repo
   artifact. Count and identity unknown until queried live in prod.
3. **The prod-only Storage bucket + storage-RLS inventory** — same status.
4. **The ~19-function gap between prod's 258 anon-executable RPCs and the 239 reconstructable from
   migrations** — functions live in prod with no surviving migration source. Identity unknown docs-side.
5. **Which package "the JS SDK (never published)" (old S13) denotes** — `sdks/` holds `mcp-server`,
   `langchain-ts` (both published npm) and `langchain` (Python); the never-published JS SDK named by the prior
   inventory is not identifiable from the repo tree alone.

### 4.4 Claims register (pre-seeded)

The §3.5 register is pre-seeded at **`docs/staging/fullsoak-2026-08/claims-register.csv`** — one row per
pre-mortem §5.1 advertised capability (all nine), plus the two priced offers as separate commercial-representation
rows, the SOC 2 evidence-matrix "Continuous" fraud-detection claim (`docs/compliance/soc2-type2-evidence-matrix.md:42`,
CC3.3), and the historical proof gap (G8). Reviewed **daily** during the soak per §3.5; decisions are
KEEP / RETRACT / HEDGE and no row may end the soak "not demonstrated and not retracted". The two priced dead
offers (`/ai/search`, `/nessie/query`) are marked RETRACT-recommended pending founder sign-off; the fraud
"Continuous" claim is HEDGE-recommended (correct the matrix before the auditor sees it); the remainder are HEDGE
with caveat-language pointers into pre-mortem §4/§5.

### 4.5 Post-Day-0 audit corrections (2026-08-12)

A founder coverage audit (`docs/staging/fullsoak-2026-08/founder-coverage-checklist.md`), run against the live
rig (`gnkuaywlpmsaezwvlvhk`) and prod (`vzwyaatejekddvltxyye`) on 2026-08-12, found overclaims in §2.3 / §4.1 /
§4.2 and two prod-exposed defects. Each correction is recorded here rather than silently rewritten, so the
change is auditable; every corrected §2.3/§4 line now carries a `[Corrected 2026-08-12 — §4.5]` marker pointing
here. **Understating coverage is safe; overstating is the cardinal sin — these move numbers only downward.**

| # | Location | Claimed | Corrected | Basis |
|---|---|---|---|---|
| C-1 | §2.3 heading + body; §4.2 S10 | "all **110** (or all 52 unscheduled) cron routes bound on the rig" | **25 of 109 code routes Scheduler-bound (22.9%); 84 DECLARED-UNTESTED** (force-run-testable, not continuously scheduled) | `cron.ts` on `origin/main` = 109 distinct routes; `gcloud scheduler jobs list … --format='value(httpTarget.uri)'` = 26 fullsoak jobs / 25 distinct routes (`batch-anchors` + `batch-anchors-forced-flush` share `/jobs/batch-anchors`); checklist §1; FD-13 |
| C-2 | §4.1 coverage floor | "**301** of 401 LIVE (**75.1%**)", incl. "+3 recovered by binding the unbound credit-cron routes (§2.3)" | **298 of 401 LIVE (74.3%)**; the "+3 credit-cron" credit is **withdrawn — those crons were never bound** | 278 + 13 (Gate 0 flag seed) + **0** (credit crons unbound) + 6 (edge families) + 1 (search-hostname) = 298; checklist §1 |
| C-3 | §4.2 S1 "GetBlock broadcast + UTXO listing" | **DECLARED-UNTESTED** ("mainnet-only, unreachable on a signet rig") | **IN-SCOPE** — RPC broadcast + RPC inclusion proofs now under soak | FD-3: the authorised freeze-break deploy to `00013-mrw` at **2026-08-12T15:09:40Z** set `BITCOIN_UTXO_PROVIDER=getblock` over the `fullsoak-btc-rpc` VPC connector, putting the rig on prod's exact hybrid chain architecture; `fullsoak-daily-check.sh` A17/A17b |

**The 84 DECLARED-UNTESTED cron routes, by family** (each force-run-testable, none continuously scheduled, none
silently passing — the Day-7 report lists them as declared-untested with a reason, never as covered):

| n | Family | Why unbound |
|---|---|---|
| **42** | Public-record / registry feeders (`fetch-*` ×38, `edgar-backfill`, `edgar-bulk`, `openalex-bulk`, `embed-public-records`, `regulatory-change-scan`) | Each hits a live external registry; binding `anchor-public-records` on a populated table converts an unbounded fetch batch into PENDING anchors and contaminates the controlled cohort. Prod's feeders are paused (259k pending-anchoring backlog) |
| **13** | Ops / observability / reporting (`db-health`†, `pipeline-health`, `pipeline-throughput-monitor`, `lock-wait`, `migration-status`, `smoke-test`, `financial-report`, `generate-reports`, `queue-digest`, `queue-reminders`, `calibration-refit`, `professional-education-extraction`, `mainnet-migration`) | Mostly no-ops on a small rig; `queue-digest` needs email channels; `mainnet-migration` must **never** run on a signet rig. †`db-health` **is** bound (job `db-health-monitor`) — it appears here only because job name ≠ route name |
| **9** | Connector jobs (`docusign-*` ×6, `drive-*` ×2, `connector-health-check`) | Need real OAuth tenants; the vendor-fetch leg is structurally unreachable without credentials |
| **8** | Credit / billing / metering (`ai-credit-reconcile`, `credit-expiry`, `monthly-allocation-rollover`, `payment-recovery`, `reconcile-credit-conservation`, `reconcile-stripe`, `report-metered-usage`, `workspace-subscription-renewal`) | **These are the crons §4.1 wrongly credited as "+3 recovered". None is bound.** `reconcile-credit-conservation`, named in §4.2 S16's assertion, is not bound |
| **6** | Expiry / lifecycle (`check-credential-expiry`, `check-attestation-expiry`, `ce-key-expiry-check`, `ce-registry-drift-check`, `cleanup-retention`, `treasury-alert-check`) | `check-credential-expiry` is **FD-2**, a prod-exposed 500 (queries non-existent `anchors.not_after` / `anchors.document_title`); the CE jobs need CE credentials |
| **4** | Proof backfill / coverage (`classify-proof-backcatalog`, `materialize-proof-backcatalog`, `proof-coverage-monitor`, `supplementary-proof-anchor`) | The 2.97M-record proof gap is a founder decision (G8), not a soak item; no prod schedule either (§9 CC7.1) |
| **3** | BigQuery export (`bq-export-backfill`, `bq-export-incremental`, `bq-export-snapshot`) | No BigQuery dataset wired to the rig |

**Two prod-exposed defects surfaced by the audit** (both carried in the manifest findings register, §11):

- **FD-P7 — API-key revocation/deletion unreachable from any client (prod-exposed, CC6.8 control gap).**
  `toPublicKey()` (`services/worker/src/api/v1/keys.ts:36`) strips `id` from **both** the create response (`:163`)
  and every list row (`:214`), but `PATCH /api/v1/keys/:keyId` (revoke, `:224`) and `DELETE /api/v1/keys/:keyId`
  (`:302`) are addressed by that id. A customer therefore **cannot revoke a leaked API key through the product**,
  and `PATCH` sets only `is_active:false` — `revoked_at` / `revocation_reason` stay NULL. Verified live: `GET
  /api/v1/keys` → 200 with no `id` field. Filed **BUG-2026-08-12-004**; fix task `task_3e97fc2e` spawned.
- **FD-17 — rig anon-grant fidelity caveat (rig-provisioning artifact, prod NOT affected).** CTO ruling boxed
  below; manifest FD-17. Filed **BUG-2026-08-12-005** (migration-hygiene; prod clean, any rebuilt env is not).

> **CTO ruling — rig anon-grant fidelity caveat (recorded verbatim; also manifest FD-17).**
>
> MEASURED: the rig has 282 anon-executable functions vs prod's 262; 20 SECURITY DEFINER functions are
> anon-callable on the rig that are correctly revoked in prod (incl. admin_set_platform_admin,
> anonymize_user_data). ROOT CAUSE: the rig was built from a squashed baseline that emits only
> `REVOKE ... FROM PUBLIC`; the `anon`/`authenticated` REVOKEs live in docs/migrations-archive/ and never replay
> on a squashed rebuild (the known [[supabase-revoke-from-public-is-not-enough]] class). ASSERTED: prod's
> anon-RPC posture is clean, verified directly against prod (vzwyaatejekddvltxyye). NOT ASSERTED: that the rig's
> anon-RPC security sweep certifies prod's posture — it cannot; prod is certified directly. RULING (CTO): this is
> a rig-provisioning artifact, not a prod defect and not a clock-reset — anchoring/queue/DB-schema/uptime
> evidence is unaffected. The rig is declared NOT a faithful mirror for the anon-grant surface; that surface is
> evidenced against prod directly. The rig is NOT patched mid-soak (freeze discipline outranks faithfulness). A
> migration-hygiene fix (replay archive revokes into the squashed baseline) is filed for any future rebuilt
> environment.

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
