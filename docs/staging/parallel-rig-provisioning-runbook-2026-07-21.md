# Parallel-Rig Provisioning Runbook (SCRUM-2906 R1)

**Owner:** Release/Train lane (RTE). **Status:** DESIGN / runbook only — this document stands up **nothing**. **Freeze:** PI-0.5 W3; Draft / `do-not-merge`.

**Problem it solves.** PI-0.5 soak throughput is the serial-train bottleneck (R-3). The fix is *parallel* isolated rigs — one rig per soaking rail — not a committed/stretch scope split (`feedback_dont_split_sprint_scope`). Running rigs in parallel introduces two failure modes this runbook + the reservation ledger close:

1. **Double-booking** — two sessions reserve the same Cloud Run service or the same Supabase project and one silently writes into a rig another session is mid-soak on, contaminating the evidence (`feedback_no_live_soak_rig_as_validation_target`, `feedback_dont_touch_soaking_prs`).
2. **Crash-loop on standup** — the worker's Zod config fails closed at boot when required env vars are missing, so a freshly-provisioned rig never becomes healthy and the soak clock (= Cloud Run uptime, `feedback_soak_clock_is_worker_uptime`) never legitimately starts.

Companion artifacts:
- `docs/staging/rig-reservations.json` — the machine-checkable reservation ledger (scaffold).
- `scripts/staging/check-rig-reservations.ts` — the double-booking / malformed-active-row validator.
- Existing single-rig procedure: `docs/reference/STAGING_RIG.md` + memory `project_isolated_soak_standup_procedure`. This runbook is the *parallel* wrapper around it, not a replacement.

---

## 0. Preconditions (before any rig work)

- Read `CLAUDE.md` + run `scripts/agent/ack-claude-bootstrap.sh` (§1.11A hook gate).
- Confirm the freeze posture for your change: nothing here authorizes starting a real soak, tearing down a live rig, or a prod write. Under W3 freeze, provisioning itself is a founder/RTE-gated action — this runbook is the *procedure*, not the go-ahead.
- One rail = one rig = one concurrent soak. Never reuse a rig whose rail is mid-soak.

---

## 1. Reserve BEFORE you provision (ledger-first)

The ledger is claim-first so two parallel sessions can't race onto the same rig. In the **same** change that will stand up the rig:

1. Add a row to `docs/staging/rig-reservations.json` with `status: "active"` and, at minimum, the required fields the validator enforces: `reservation_id`, `rail`, `rig.cloud_run_service`, `rig.supabase_ref`.
2. Run the validator and confirm exit 0:
   ```
   npx tsx scripts/staging/check-rig-reservations.ts docs/staging/rig-reservations.json
   ```
   It fails closed (exit 1) if your new row double-books a Cloud Run service or a Supabase ref already held by another `active` row, or if the active row is missing required identity. **Cloud Run tag URLs isolate worker revisions only; the Supabase project ref is the isolation boundary (CLAUDE.md §1.11A)** — both must be unique across active reservations.
3. Fill the remaining identity fields as they materialize (`worker_revision`, `image_digest`, `pr_head_sha`, `deploy_log_id`, `soak.start/end`, `preflight_result`) so the reservation doubles as the §1.11A isolated-evidence manifest.
4. At teardown, flip `status` to `"released"` (do not delete the row — history stays addressable; `reservation_id` is unique across all rows).

Rows with `status: "example"` are inert (documentation of the shape only).

---

## 2. Provision each rig (repeat per rail, in parallel)

Follow `project_isolated_soak_standup_procedure` per rail — build → rig → schema → deploy → tag → IP-rotation — but keep the rails on **distinct Supabase projects and distinct `arkova-worker-<rail>-staging` services**. Provisioning a rig *alone* (no soak load) is an invalid soak; the rig must run the changed behavior.

Parallelize the independent standups (`feedback_work_in_parallel`) — image builds and rig creations for different rails have no ordering dependency — but serialize any writes to a *single* rig.

**Gotcha — Cloud Scheduler cron.** In-process `node-cron` does not fire on a throttled/scaled-to-zero Cloud Run instance (`project_cloudrun_inprocess_cron_gotcha`). Rig cron triggers must be driven by Cloud Scheduler → `/jobs/*` with an OIDC token whose **audience is the rig service ORIGIN** (see the anti-hollow-soak `scheduler-oidc-audience` guard, SCRUM-2977 — a mismatched audience 401s and the trigger under test never fires).

---

## 3. Crash-loop env checklist (VERIFIED against `services/worker/src/config.ts`)

The worker's config is a Zod schema that **fails closed at boot**. A rig missing any of these never becomes healthy — you see a Cloud Run crash-loop, not a running soak. `USE_MOCKS=true` does **not** relax any of it: the mock switch changes chain/Stripe *behavior*, not config *validation*.

### 3a. Always required (base Zod — any `NODE_ENV`, including `USE_MOCKS=true`)
| Env var | Rule (`config.ts`) |
|---|---|
| `SUPABASE_URL` | `z.string().url()` (line 39) |
| `SUPABASE_SERVICE_ROLE_KEY` | `z.string().min(1)` (line 40) |
| `STRIPE_SECRET_KEY` | `z.string().min(1)` (line 45) |
| `STRIPE_WEBHOOK_SECRET` | `z.string().min(1)` (line 46) |

### 3b. Additionally required when `NODE_ENV=production` (`superRefine`, lines 428–458) — and staging rigs run as `production` to mirror prod
| Env var | Why it fails closed |
|---|---|
| `CRON_SECRET` **or** `CRON_OIDC_AUDIENCE` | at least one required — cron endpoints would be unauthenticated (line 430) |
| `API_KEY_HMAC_SECRET` | empty secret makes API-key HMAC hashes reproducible (line 440) |
| `FRONTEND_URL` | must be set explicitly; the `http://localhost:5173` default is rejected in prod so verify/invite URLs aren't broken (line 452) |

> If you run the rig with `NODE_ENV=development` instead, only §3a applies — but then the rig no longer mirrors prod behavior (§1.11 proportional-tier requirement). Prefer `NODE_ENV=production` + the full §3b set. For a mock rig, these can be non-secret placeholders that satisfy the shape (e.g. a dummy `STRIPE_SECRET_KEY`, a ≥16-char `CRON_SECRET`, a real `https://` `FRONTEND_URL`), since `USE_MOCKS=true` means they're never dialed — but they must be *present and well-formed* or Zod rejects boot.

### 3c. Conditional (only if you exercise that path)
- `GEMINI_API_KEY` etc. — only if the rig exercises AI extraction.
- `KMS_PROVIDER=gcp` + a signer — only for `NODE_ENV=production` **mainnet** `ENABLE_PROD_NETWORK_ANCHORING` (lines 466–477). Rigs should not anchor to mainnet; keep `BITCOIN_NETWORK=signet`/`testnet` + `USE_MOCKS` for the chain path.
- Secrets live in Secret Manager (`supabase_access` etc. per `project_isolated_soak_standup_procedure`); the shared `arkova-worker-staging` template can drift onto a dead rig's secrets — set each rig's env explicitly rather than inheriting (`project_staging_worker_secret_drift`).

**Boot verification:** after deploy, confirm the revision is serving (`gcloud run services describe <svc> --format='value(status.latestReadyRevisionName)'`) and `/health` is 200 **before** treating the soak clock as started. A crash-looping revision has zero valid uptime.

---

## 4. Post-soak / teardown

- Capture the §1.11A evidence into the reservation row and the RC manifest.
- Flip the reservation `status` to `released`; re-run the validator (still exit 0).
- Tear down by **exact service name** — a name-pattern sweep (`*rig*`, `*staging*`, `*NNNN*`) matches multiple live services including any frozen mid-soak rig (SCRUM-2978 near-miss). The ledger's `cloud_run_service` + `supabase_ref` are the exact-name source of truth.
- Paid Supabase rigs can't be paused via MCP — delete the rig or flag Carson to downgrade/pause from the dashboard (§7 cost sweep).

---

## 5. Pre-mortem (how this runbook could still let a bad soak through)

- **Ledger honored only if consulted.** The validator is not (yet) a gating CI job under the W3 freeze, so a session that skips step 1 can still collide. Mitigation: reservation-first is the standing rule; wire the validator to CI report-only after ≥1 real parallel run calibrates it (mirrors SCRUM-2977/2897).
- **Placeholder env that's too permissive.** A mock rig with well-formed-but-fake secrets boots green but a code path that actually dials Stripe/KMS (mis-set `USE_MOCKS`) would fail mid-soak. Mitigation: assert `USE_MOCKS=true` in the reservation notes and in the boot log check.
- **Supabase-ref uniqueness ≠ schema cleanliness.** Distinct refs prevent *collision*, not *contamination* — a reused isolated project can still be dirty. The clean-mirror preflight (§1.11A) remains mandatory and is out of scope for this ledger.

_Last refreshed: 2026-07-21 by RTE — env checklist verified against `services/worker/src/config.ts` (lines cited); no rig stood up, no prod state asserted._
