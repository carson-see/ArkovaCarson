# T+0–2h Smoke Gate — legacy-soak-2026-08 — PASS (infra), OPEN ITEM (SS4.3 journey assignment)

Soak: `legacy-soak-2026-08` · Clock start: `2026-07-28T21:32:17.475418Z` · Revision `arkova-worker-legacy-soak-2026-08-staging-00002-4sr` · Head `42ad98c9c48cacdddd078a73cdae2fcaf59f1ac2` · Supabase `ryasykzdduzymschbucr`

| Check | Result | Evidence |
|---|---|---|
| Health | PASS | `GET /health` → `{"status":"healthy","network":"signet","checks":{"database":"ok","anchoring":"ok","kms":"ok"}}` |
| Signet network | PASS | verified live in `/health` response body, not inferred from deploy intent |
| Migrations (clean_mirror preflight) | PASS | `environment_type=clean_mirror`, `docs/staging/legacy-soak-2026-08/preflight-legacy-soak-2026-08.json`, missing-from-staging `0362`/`0364` informational only (same as launch rig) |
| Schedulers | PASS | 5/5 jobs (`batch-anchors`, `check-confirmations`, `populate-confirmation-proofs`, `org-queue-scheduler`, `recover-broadcasts`) ENABLED, each force-run once, each shows a real `lastAttemptTime` |
| Auth | PASS | unauthenticated `GET /health` → HTTP 403 (Cloud Run IAM) |
| Zero 5xx | PASS | last 200 log lines for the service contain no 5xx responses |
| Flags verified live | PASS | all 23 prod `switchboard_flags` rows mirrored into rig DB; `ENABLE_ORG_CREDIT_ENFORCEMENT=true` confirmed as a Cloud Run env var directly (this flag is env-source-only, DB mirror alone is a no-op — same trap the launch rig hit, applied correctly here from initial deploy) |
| First anchor SECURED end-to-end | **NOT REACHED — SUBMITTED only, not yet confirmed** | anchor `b1c56602-ed81-4d89-b0ff-6eec0b04e470`, status `SUBMITTED`, txid `60b0b57486f13977f3c3e1a6671f28e01567d32bf8b418ce0dc6fe84af7f5cc0`, independently visible on mempool.space/signet at broadcast time; confirmation to `SECURED` requires the `check-confirmations`/`populate-confirmation-proofs` jobs to observe a signet block, which had not yet happened as of gate close — this is expected signet-timing, not a failure, but is stated as not-yet-reached rather than asserted complete |

## Anti-hollow evidence (real, independently checked)

- Real broadcast, forced via `POST /jobs/batch-anchors?force=true` against a purpose-inserted `PENDING` anchor (the seeded baseline fixture is `SUBMITTED`, not eligible for batching — see provenance JSON `anti_hollow_verification.batch_anchor_forced_run_note`).
- `batchId=batch_1785274559967_1`, `merkleRoot` matches the seeded fingerprint exactly.
- `txId=60b0b57486f13977f3c3e1a6671f28e01567d32bf8b418ce0dc6fe84af7f5cc0` confirmed independently via direct `curl` against `mempool.space/signet/api/tx/...` (not asserted from worker logs alone) — spends a real 757,540-sat UTXO from this rig's own isolated treasury address.
- DB row transitioned `PENDING → SUBMITTED` with matching `chain_tx_id`, verified via MCP `execute_sql` against `ryasykzdduzymschbucr`.

## Treasury

New isolated signet keypair (`tb1qrjarsqj0ewqh3u9fdcu7yfyl0sx78k4savtmv7`), generated via `services/worker/scripts/generate-signet-keypair.ts` and funded via the public `alt.signetfaucet.com` faucet (757,540 confirmed sats) — **not** the shared `arkova-s33-rig-b1-treasury-wif-signet` address used by `launch-72h-2026-08`. Chosen to eliminate UTXO-selection race risk between two concurrently-broadcasting soaks sharing one WIF; the launch soak's treasury was not touched or spent from this session. See provenance JSON `treasury_decision` for full rationale.

## Disclosed exceptions / open observations

1. **GetBlock broadcast parity NOT covered by this soak** — same disclosed exception as `launch-72h-2026-08`: no valid signet GetBlock credential exists; `BITCOIN_UTXO_PROVIDER=mempool` set from initial deploy (applied proactively this session, not discovered mid-soak).
2. **First-anchor-SECURED not yet reached** — the forced-broadcast anchor is `SUBMITTED`, not `SECURED`; needs at least one more signet block plus a `check-confirmations`/`populate-confirmation-proofs` cycle. Re-check before citing this soak as having a full SECURED-anchor proof point.
3. **Supabase compute tier not yet resized to Medium** — provisioned at script default; the task's 10k-DAU load model requires Medium (`ci_medium`) sizing via the Management API `PATCH /v1/projects/{ref}/billing/addons`, same as the launch rig. **Not done this session** — flagged as an open item, not silently assumed.
4. **Load generation NOT started** — no 10k-DAU load-generation mechanism (script/tool) was found in the repo for either soak as of this session. This rig is real and verified-non-hollow at the infrastructure/single-transaction level, but is not yet under the target load profile. Stated explicitly rather than implied.
5. **SS4.3 journey-table assignment NOT done** — the plan's own pre-mortem item #1 requires the T+0–2h gate to hard-stop on confirming each `PLAN-legacy-soak-pre-launch-window.md` §4.3 subsystem row has an assigned, scheduled exercise before the soak can be called non-hollow *for its actual purpose* (legacy code-path exercise, not generic uptime). That assignment step has not been performed this session — this smoke gate covers infrastructure anti-hollow verification only (real broadcast, real schedulers, real flags), not the SS4.3 legacy-surface exercise plan itself. Recorded as an open item per the plan's own mitigation for pre-mortem item #1, not treated as satisfied by infra-up alone.
6. **JWT/secret expiry beyond the 72h window not independently verified** this session (task lesson #8).

## gcloud environment finding (non-rig-specific)

`gcloud`'s bundled Python 3.9 crashes loading the `run`, `builds`, and `scheduler` component groups in this shell (`CommandLoadFailure: unsupported operand type(s) for |`). Worked around this session via `export CLOUDSDK_PYTHON=/opt/homebrew/opt/python@3.14/bin/python3.14`. Flagging for any future session using this same shell.

_Last refreshed: 2026-07-28 by RTE session — claims verified against gcloud output, MCP `execute_sql` output, and direct `curl` against mempool.space/signet, not asserted from worker logs or prose alone._
