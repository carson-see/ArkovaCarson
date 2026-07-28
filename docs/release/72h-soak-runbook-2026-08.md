# 72h Soak Runbook — 2026-08 Launch Wave

> **Story:** SCRUM-2980 (Sprint B, RTE lane). This is a real sprint deliverable, not a narrative doc.
> **Scope:** the exact, executable procedure to stand up, run, observe, and gate the single 72h isolated-rig soak covering the ~40-PR Sprint A/B wave ahead of the 2026-08-10 launch.
> **Obeys:** `CLAUDE.md` §1.11 / §1.11A (staging integrity) / §1.12 (soak tiers) / §1.13 (tiered merge). Companion process doc: [release-management-runbook.md](./release-management-runbook.md) (SCRUM-2898, ran once already for PI-0.5 — this is iteration 2 at ~5x batch size). Rig standup detail: [staging-parity-path.md](./staging-parity-path.md) (SCRUM-2896) + [docs/reference/STAGING_RIG.md](../reference/STAGING_RIG.md).
> **Manifest:** [docs/staging/rc-manifests/rc-2026-08-launch-72h.json](../staging/rc-manifests/rc-2026-08-launch-72h.json) — the master RC manifest this soak populates. Currently `approval_status: "pending"` — see that file's `_append_procedure`.
> **CTO ruling reference:** R17 (ratified sprint plan, 2026-07-28) — this soak runs `ENABLE_ORG_CREDIT_ENFORCEMENT=ON` and `ENABLE_OUTBOUND_WEBHOOKS=ON` in the rig, a deliberate documented divergence from prod's current flag state, plus a SCRUM-3031 regression check.
> **Verification status:** every tool path, script, and flag cited below was read/verified live against the repo on 2026-07-28 (paths exist, flags exist as documented). Nothing about the wave's PR set, migration numbers, or CI state is assumed stale — cross-check `docs/staging/rc-manifests/rc-2026-08-launch-72h.json` and `gh pr list` before executing, since PRs are still being opened as of this writing.

---

## 0. Why this soak is different from PI-0.5's

PI-0.5 ran this procedure once, mostly T2. This wave is ~5x the PR count, mixes
T1/T2/T3 in the same window, and per R17 deliberately runs two flags ON that
prod does not yet have on. The **single 72h window covers T1/T2/T3
simultaneously** — 72h exceeds all three tier floors (2h / 12h / 48h), so
running one long window for the whole batch is correct and cheaper than
splitting soaks by tier, provided every included PR's changed surface is
actually exercised (§5) — a long clock alone is not evidence
(`memory/feedback_soak_evidence_standard.md`).

---

## 1. Go/No-Go checklist — everything that must be TRUE before the clock starts

Do not start the soak clock until **every** row below is checked. This is the
gate between "rig exists" and "soak evidence is real."

- [ ] **Wave G merged.** #1722/#1723/#1724 (gate fixes) are on `main` — the staging-evidence gate itself must be running its fixed (live-PR-state, re-fireable) version before it's trusted to grade this soak's PRs. See [wave-merge-choreography-2026-08.md](./wave-merge-choreography-2026-08.md).
- [ ] **Manifest PR set is current.** `docs/staging/rc-manifests/rc-2026-08-launch-72h.json` `included_prs[]` reflects the actual PR list at freeze time (`gh pr list --state open --json number,title,headRefOid,baseRefName,isDraft` re-run, not trusted from an earlier session) — new sprint PRs (Wave S) were still opening as of the manifest's draft; append per its `_append_procedure` before freezing.
- [ ] **Every included PR's blockers are cleared:** #1618 `do-not-merge` label removed (or excluded from this wave), #1654 rebased off CONFLICTING/DIRTY, #1716/#1721 rebased onto current `main`, and each PR's currently-red required check (see manifest `ci_summary` per PR) is green.
- [ ] **Integrated head frozen.** Pick one exact `main` SHA + the full PR branch set; record it as `train_launch_sha`/`build_sha_baked`. Do not float the head mid-soak.
- [ ] **Isolated rig provisioned** per §2 below, profile `chain` (not `mock` — see §4 flag matrix), **built at the frozen head** (`memory/feedback_soak_merge_grade_procedure.md` — a stale image is a re-soak).
- [ ] **`staging-honesty-preflight.ts` reports `environment_type=clean_mirror`** against the isolated rig's exact project ref. Capture the JSON artifact.
- [ ] **Cloud Scheduler jobs enabled**, not relying on in-process node-cron (§3).
- [ ] **JWT / secrets expire after the full 72h window** (§3.4) — a mid-soak expiry silently degrades authenticated-path coverage without failing loudly.
- [ ] **Baseline fixture seeded** (≥1 `SUBMITTED` anchor) — required for preflight Check 5.
- [ ] **Flag matrix applied** exactly as documented in §4, and the divergence from prod is written into the manifest's `environment.profile_note` (already templated).
- [ ] **Migration train order confirmed**: 0359 → 0360 → 0362 → 0364 → 0368 (plus any newly appended numbers per the RTE table) applied via `supabase db push --linked` on the rig, in that order, each with rollback rehearsed (§7 of the release-management-runbook).
- [ ] **Rollback rehearsal completed and recorded** for all five migrations above before the clock starts (not "during" — rehearsal is a pre-soak gate, the soak itself observes forward-path behavior).
- [ ] **Release owner (Carson) has NOT flagged `do-not-merge`/`work-in-progress`** on any PR still in the included set at freeze time.

Once every box is checked, record the clock start (`soak.start`, anchored to
Cloud Run revision uptime — §6) and proceed to §5's daily observation loop.

---

## 2. Isolated-rig provisioning

Follow [staging-parity-path.md](./staging-parity-path.md) §3 exactly; this
section pins the flags for *this* soak.

```bash
# 1. Dry-run first — always. Prints the exact plan, mutates nothing.
scripts/staging/provision-isolated-rig.sh \
  --name 2026-08-launch-72h \
  --profile chain

# 2. Live run — profile=chain needs BOTH confirms (real credentials: GetBlock
#    RPC + WIF signer + KMS_PROVIDER from Secret Manager).
CONFIRM_PROVISION=2026-08-launch-72h \
CONFIRM_REAL_CONFIG=chain \
  scripts/staging/provision-isolated-rig.sh \
  --name 2026-08-launch-72h \
  --profile chain \
  --apply
```

`--name` must be lowercase DNS-safe (3-30 chars, `a-z0-9-`); the script hard-denies
the prod ref (`vzwyaatejekddvltxyye`) and the shared staging services — it exits 1
rather than ever touch either.

What this buys you (per the script + staging-parity-path.md):
1. A **standalone** Supabase project (region `us-east-2`, PG 17.x) — not a
   preview branch (lettered-suffix migration builder bug).
2. Schema replayed via `npx supabase db push --linked` to the frozen head's
   ledger.
3. A wired `arkova-worker-2026-08-launch-72h-staging` Cloud Run service on the
   **prod-pinned image** (see §2a — this soak needs the *frozen wave* image,
   not literally the prod image; build it first, see §2a), profile `chain`:
   `USE_MOCKS=false`, `ENABLE_PROD_NETWORK_ANCHORING=true`, real GetBlock RPC +
   WIF signer + KMS_PROVIDER, boot-critical secrets (Stripe / API-key HMAC /
   cron / `FRONTEND_URL`) wired so `config.ts`'s Zod `superRefine` doesn't
   crash-loop the worker.
4. **Cloud Scheduler jobs** wired (chain profile is non-mock, so this happens
   automatically) POSTing to `/jobs/*` — mandatory, not optional (§3).
5. Baseline fixture seeded (`scripts/staging/seed-baseline-fixture.sql`) — ≥1
   `SUBMITTED` anchor for preflight Check 5.
6. Preflight run automatically as the script's final step — **must** report
   `clean_mirror` before you proceed.

### 2a. BUILD AT HEAD — non-negotiable

The rig's worker image must be built from the exact frozen integrated head
(all included-PR branches merged onto the pinned `main` SHA), **not** reused
from a prior soak or from the plain prod image:

```bash
cd services/worker
gcloud builds submit \
  --tag us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:2026-08-launch-72h-<frozen-head-short-sha>
```

Then point the rig's Cloud Run service at that exact image digest (record it
in the manifest's `environment.image_digest`). A stale rig image invalidates
the whole soak (`memory/feedback_soak_merge_grade_procedure.md`) — if any
included PR gets a new commit after this build, the image is stale for that
PR specifically; either exclude that PR from this window or rebuild.

### 2b. Preflight

```bash
npx tsx scripts/ci/staging-honesty-preflight.ts \
  --project-ref <SOAK_PROJECT_REF> \
  --prod-project-ref vzwyaatejekddvltxyye \
  --format json > docs/staging/preflight-2026-08-launch-72h.json
```

Must report `environment_type=clean_mirror`. Capture the JSON — it's a
required SOC2/ISO evidence artifact (§8). Re-run if any migration lands on the
rig after the first pass.

---

## 3. Cloud Scheduler wiring (NOT node-cron)

`node-cron` does not fire on a throttled/scale-to-zero Cloud Run service
(`memory/project_cloudrun_inprocess_cron_gotcha.md`). This rig runs
`--profile chain`, which is non-mock, so `provision-isolated-rig.sh` wires
Cloud Scheduler automatically — verify it landed rather than assuming:

```bash
gcloud scheduler jobs list --location=us-central1 \
  --filter="name~2026-08-launch-72h"
```

Expected jobs, mirrored from the working pattern already used on prior soaks
(`rc-t2-docusign-20260726`, `railb220260719-staging`):

| Job | Endpoint | Schedule |
|---|---|---|
| `…-batch-anchors` | `POST /jobs/batch-anchors` | `*/5 * * * *` |
| `…-check-confirmations` | `POST /jobs/check-confirmations` | `*/5 * * * *` |
| `…-recover-broadcasts` | `POST /jobs/recover-broadcasts` | `*/10 * * * *` |
| `…-org-queue-scheduler` | `POST /jobs/org-queue-scheduler` | `*/5 * * * *` |
| `…-populate-confirmation-proofs` | `POST /jobs/populate-confirmation-proofs` | `*/5 * * * *` |

Verify OIDC auth end-to-end at least once before the clock starts:

```bash
gcloud scheduler jobs run 2026-08-launch-72h-check-confirmations \
  --location=us-central1
# expect HTTP 200 from the worker, not 401/403
```

### 3.4 JWT / secret expiry > 72h

Any short-lived credential minted for this soak (service-role JWT used by the
load harness, any manually-minted test JWT for authenticated-path coverage,
`STAGING_PROMOTE_TOKEN` if used) must have an expiry that outlives the full
72h window plus buffer — mint for **≥80h**. A credential that expires at hour
50 silently degrades authenticated-path coverage for the remaining 22h without
failing loudly; this has bitten prior soaks in spirit (the JWT-secret
gotchas noted in `docs/reference/STAGING_RIG.md`) even if not this exact
failure mode. Record the expiry timestamp in the manifest's `soak` block notes
when it's filled in.

---

## 4. Flag matrix (CTO ruling R17)

| Flag | Prod (current) | This rig | Why |
|---|---|---|---|
| `USE_MOCKS` | `false` | `false` (profile=chain) | real anchoring path under test |
| `ENABLE_PROD_NETWORK_ANCHORING` | `true` | `true` (profile=chain) | wave includes chain/anchoring surfaces (SCRUM-3031 fix, bulk anchoring) |
| `ENABLE_ORG_CREDIT_ENFORCEMENT` | verify live before assuming — do not infer from code (`memory/feedback_assert_prod_state_directly.md`) | **`ON`** | **R17 deliberate divergence** — launch-target evidence; this wave's credit/queue work (A3 fail-closed, A5 admin adjust, R4 org_credits canon) needs enforcement ON to be exercised meaningfully |
| `ENABLE_OUTBOUND_WEBHOOKS` | verify live before assuming | **`ON`** | **R17 deliberate divergence** — needed to exercise B2/B3 webhook hardening + Developer tab |
| `ENABLE_AI_FRAUD` / `ENABLE_AI_REPORTS` | `true` | `false` (per standard isolated-rig posture, `docs/reference/STAGING_RIG.md`) | no need to burn Gemini budget; not this wave's changed surface |
| `BATCH_ANCHOR_MAX_SIZE` | `10000` | `10000` | keep Trigger A/B semantics production-like |

**Before the clock starts:** query prod's actual `switchboard_flags` state for
`ENABLE_ORG_CREDIT_ENFORCEMENT` and `ENABLE_OUTBOUND_WEBHOOKS` via Supabase MCP
`execute_sql` against `vzwyaatejekddvltxyye` and record both the prod value and
the rig's `ON` override in the manifest — the divergence must be *documented*,
not assumed from memory (switchboard flags are a dark API on fresh envs;
`memory/project_switchboard_flags_dark_api.md` — mirror prod's flag table onto
the rig first, then apply the two R17 overrides on top, don't build the flag
table from scratch).

---

## 5. The 4-pillar evidence standard, mapped to this wave's surfaces

Per `memory/feedback_soak_evidence_standard.md`: durability = VOLUME +
CONCURRENCY (pgbench-style) + EDGE CASES + ISOLATION, empirical. One seed +
one trigger is not evidence. Below is what "real" looks like for **this
wave's** changed surfaces specifically — generic worker-health load is
supporting evidence only; it does not substitute for exercising the changed
path (`CLAUDE.md` §1.12).

### VOLUME
- **Mixed-format bulk anchoring** (founder amendment A1): drive ≥100 anchors
  through `POST /api/v1/anchor/bulk` (`services/worker/src/api/v1/anchor-bulk.ts`)
  in a single mixed-format batch (.csv + .pdf + Drive doc + .xml in one call),
  exercising the dedup strategies and per-row error paths already built into
  that endpoint.
- **22-format extraction matrix** (F6 KPI evidence item): run the fixture
  corpus test (once F1-F6 land) end-to-end — upload → extract → anchor — for
  every one of the 22 formats. This artifact **is** the KPI proof per the
  sprint plan; do not substitute a partial run.
- Row-mode spreadsheet extraction at ≥100 rows (existing capability, verify it
  still holds post-wave: 10,000-row cap, 10MB, batches of 10 via
  `bulk_create_anchors`).

### CONCURRENCY
- Parallel `POST /api/v1/anchor` calls (≥15 concurrent, matching the pattern
  already proven on the maxsoak rig 2026-07-23) with exact credit-balance
  conservation checked before/after — no race, no double-charge. Repeat with
  `ENABLE_ORG_CREDIT_ENFORCEMENT=ON` specifically (this is the R17 divergence
  surface — prior soaks proved this pattern with the flag off or unverified).
- Concurrent DocuSign webhook deliveries against the rig's `/webhooks/docusign`
  route while the queue-vs-instant admin rule (L3-B3) is toggled mid-run.

### EDGE CASES
- **DocuSign E2E**: run both `e2e/integrations-docusign.spec.ts` and
  `e2e/integrations-docusign-member.spec.ts` against the rig, plus a live
  changed-path webhook liveness probe (signed / unsigned / garbage-control
  triad, same pattern as `rc-t2-docusign-20260726.json`'s
  `webhook_liveness_evidence` block) for whatever DocuSign surface landed this
  wave (#1711 auto-seed rule, L3-B2 per-member attribution).
- **Mixed multi-file drop bug** (found in the BULK AUDIT, `BulkUploadWizard.tsx:97-99`
  silently discarding files when no spreadsheet is present): confirm W1's fix
  actually surfaces an error instead of a silent empty prompt.
- **Row-derived vs document-derived evidence class** (R19): confirm a
  row-import without a mapped fingerprint column correctly tags
  `proof_completeness_class` as record-derived/issuer-attestation, not
  document-derived, and that the public verify page renders the distinction.
- Quota/credit exhaustion boundary (dup-fingerprint idempotent → 200; malformed
  → 400; quota exhaustion → 402 at the exact boundary; credit exhaustion → 402
  ×N clean, matching the pattern already proven on `maxsoak-154f9ff2`).
- **SCRUM-3031 `batch_insert_anchors` regression check** (explicitly required
  by this runbook's scope): force a repeat-submission scenario against the rig
  and confirm the fix (0370, R15) does NOT reproduce the ~106s/zero-rows
  wedge with near-continuous `RowExclusive` lock on `anchors`. If R15's
  root-cause fix landed in the RPC, assert the call completes in a bounded
  time; if only the worker-side defensive timeout/backoff landed, assert the
  backoff actually engages and the lock is released between attempts. Record
  timing evidence either way — this is a named regression, not a smoke check.
- **Proof-materializer — DRY-RUN preflight ONLY.** Run
  `scripts/ops/materializer-preflight.ts` (read-only) against the rig to
  confirm the preflight logic itself is sound. **Do NOT run the real
  materializer EXECUTE path against the rig's backlog as a stand-in for the
  2.96M-row prod backfill** — that backfill is explicitly founder-reserved
  scheduling (`docs/runbooks/ops/proof-materializer-execute.md`, once #1728
  lands); this soak proves the preflight and the DRY-RUN path work, not the
  live materialization run.

### ISOLATION
- Prod (`vzwyaatejekddvltxyye`) unchanged across the whole 72h window — spot
  check anchor count + a hash of recent rows at soak start, midpoint, and end.
- Per-org isolation check on the credit-enforcement path (R4/R17): two
  synthetic orgs on the rig, confirm credit deduction/queue state never
  crosses org boundaries under concurrent load.
- Confirm no writes landed on any *other* active soak rig or the shared
  `arkova-staging` project during this window (`memory/feedback_no_live_soak_rig_as_validation_target.md`).

---

## 6. Soak clock

Per `memory/feedback_soak_clock_is_worker_uptime.md`: the clock is **Cloud Run
worker revision uptime**, not a probe-loop timestamp. Record the exact
revision id at deploy time; if the worker restarts for any reason, the clock
resets to actual observed uptime — re-verify before declaring 72h matured:

```bash
gcloud run revisions describe <revision-id> \
  --region=us-central1 --format="value(status.conditions)"
```

72h from stabilization, not from the provisioning script's exit — wait for
`/health` to report the frozen head's `git_sha` and all subsystems `ok` before
starting the clock.

---

## 7. Daily observation checklist

Run once per 24h window (three times over the 72h soak) and log the result
against the evidence artifacts in §8:

- [ ] `/health` on the rig's URL — `git_sha` matches frozen head, all
      subsystems `ok`, network matches profile (`chain` → not `mock`).
- [ ] Cloud Run revision uptime ≥ elapsed soak time (no silent restart).
- [ ] All Cloud Scheduler jobs still `ENABLED`, last-run timestamps within
      their interval (no silently-disabled job).
- [ ] Anchor count on the rig monotonically increasing (or stable if no new
      traffic that day) — a **decrease** is contamination, stop the clock.
- [ ] Prod anchor count spot-check unchanged except for prod's own real
      traffic (isolation pillar, daily not just at start/end).
- [ ] No new unexpected ledger rows (`supabase_migrations.schema_migrations`)
      beyond the ones this wave intentionally applied.
- [ ] Credit-ledger conservation check on the rig (sum of `org_credits`
      deltas matches expected activity, no drift).
- [ ] JWT/secret expiry still comfortably ahead of the remaining window (§3.4).
- [ ] No `do-not-merge`/`work-in-progress` label appeared on any included PR
      since the last check (Carson can veto mid-soak).

---

## 8. Abort criteria

Stop the clock and mark evidence **invalid** the moment any of these appear —
identical to `release-management-runbook.md` §8, reproduced here for this
soak's operator convenience:

| Trigger | Action |
|---|---|
| Dirty preflight (anything but `clean_mirror`) | Stop. Rebuild cleanly with explicit approval, or move to a fresh isolated project. Never repair/delete ledger rows or `db push --linked` to fake clean. |
| Base drift (any included PR's base moved under the soak) | Stop that PR's coverage. Re-soak it at the new integrated head; does not necessarily invalidate the whole wave if isolable. |
| Head drift (new commit on an included PR after freeze) | That PR's evidence is stale. Bump its manifest entry's `head_sha`, needs its own re-soak or explicit exclusion for this window. |
| Contamination (unexpected ledger rows, cross-PR writes, a write to this rig from outside this soak) | Stop the clock, mark invalid, rebuild or move to isolated project. |
| Worker restart | Clock resets to actual observed uptime — re-run to the 72h floor. |
| Rig hollow (worker never booted, or 0 SUBMITTED anchors) | Soak is a no-op. Fix wiring/seed, restart clock. |
| CI red on a required check for any included PR | That PR is not mergeable regardless of soak status. Fix the gap, never workaround. |
| Prod credit-ledger or anchor-count discrepancy discovered during a daily check | Stop, escalate — isolation pillar failure is a stop-the-line event per §1.11A. |

When in doubt, stop and escalate to RM/CTO — a false-green soak has repeatedly
cost real money (`memory/feedback_soak_merge_grade_procedure.md`).

---

## 9. SOC2 / ISO evidence artifacts to capture

Durable, timestamped artifacts — not agent self-report — for the audit trail:

1. **Preflight JSON** (§2b), captured before the clock starts and re-captured
   after any post-freeze migration lands on the rig.
2. **`staging_deploy_log` provenance rows** (`public.staging_deploy_log` on the
   rig's Supabase project) — one row per deploy, written by
   `scripts/staging/deploy.sh` where applicable, or the documented deviation
   note if `provision-isolated-rig.sh --apply` is used directly (its own
   equivalent audit trail — record whichever path was actually taken).
3. **Per-pillar logs** for §5: raw request/response pairs or log excerpts for
   the DocuSign webhook liveness triad, the bulk-anchor volume run, the
   concurrency run's before/after credit balances, the SCRUM-3031 regression
   timing, and the 22-format matrix's per-format pass/fail table.
4. **Daily observation checklist results** (§7), timestamped, three
   snapshots minimum.
5. **`gcloud run revisions describe` output** at clock start and clock
   maturity, proving continuous uptime.
6. **Rollback rehearsal transcripts** for all five (or more, if appended)
   migrations — apply / rollback / re-apply, each step's `/health` result.
7. **Final RC manifest** (`rc-2026-08-launch-72h.json`) with `approval_status`
   flipped to `"approved"`, all `TBD`/`PENDING` placeholders replaced with
   real values, and `approval_note` updated to reference this evidence set.

Store artifacts under `docs/staging/` (JSON) and link them from the manifest's
`soak.evidence_links` per the existing convention
(`rc-t2-docusign-20260726.json` is the model).

---

_Last refreshed: 2026-07-28 by Release Manager agent (SCRUM-2980 draft) — every path/flag/script cited was verified to exist in the repo at commit `ae2209fd771ff088d8f3ef12070f4028cbd421a7`; no soak has started, no rig is provisioned, no PR has been merged as part of this doc's authoring. Re-verify PR states and migration numbers against `gh pr list` / the RC manifest before executing, since the wave's PR set was still open as of this writing._
