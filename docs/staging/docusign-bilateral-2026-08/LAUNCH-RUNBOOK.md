# DocuSign Bilateral — Soak Launch Runbook (Carson-gated)
Date staged: 2026-08-30 by the CTO session. **The soak is STAGED, not started — no rig exists, no clock is running.**

## Why this is a hand-off, not a fired soak
The CTO session prepared everything up to the single human-gated, irreversible step. It did NOT fire the live provision because:
1. `scripts/staging/provision-isolated-rig.sh` labels live `--apply` **"Carson-gated"** (the `CONFIRM_PROVISION` token is the tooling's deliberate human gate).
2. The Supabase CLI (`supabase projects create`, the provision's first step) has **no clean headless auth** here — `supabase projects list` hung and timed out. The live provision would stall at project creation.
3. A valid SOC 2 soak's validity depends on a clean, *watched* launch; firing a 48h unattended commitment at the tail of an autonomous session risks invalid evidence. Launch from a session that can watch the first ~2 h (when crash-loops / secret drift surface) and can seal the evidence at maturity.

## What is ready
- **RC branch `rc/docusign-bilateral-2026-08-30` @ `1cf939e5a`** (worktree `.claude/worktrees/rc-docusign-bilateral`), 17 commits ahead of `main`: worker (PR #2474 + #2476), migrations `0423` + `0424`, frontend (PR #2473), and the soak harness driver — one complete tree. Worker suite verified green on the merge (10,861/10,905, only the 3 documented env failures).
- **Harness** (PR #2479, CI-green): `services/worker/scripts/load-test/docusign-bilateral-soak.js` (driver), `docusign-guard-probe.js` (guard-trigger DB probe), `docusign-bilateral-evidence.sql` (SOC 2 assertions), extended `docusign-synth.js`.
- **Provision path dry-run-validated** (2026-08-30): the plan creates `arkova-soak-docusign-bilateral` (Supabase, us-east-2, $10/mo) + `arkova-worker-docusign-bilateral-staging` (Cloud Run, mock profile — boot secrets wired so no crash-loop, seeds a baseline fixture, requires `clean_mirror`).

## Prerequisites for launch
- Supabase CLI authenticated (`SUPABASE_ACCESS_TOKEN` or an interactive `supabase login`) — the blocker above.
- gcloud authenticated (compute SA present; verified this session — `gcloud run services describe arkova-worker` works).
- Ability to watch the rig for the first ~2 h and to seal at ~48 h.

## Launch steps
1. **Build the RC worker image** (linux/amd64, full 40-char SHA) from the RC worktree's `services/worker` via Cloud Build; capture the immutable `@sha256` digest.
2. **Provision + deploy** (run from the RC worktree so `db push` carries `0423`+`0424`):
   ```
   CONFIRM_PROVISION=docusign-bilateral \
   STAGING_DRIVER_PATH=services/worker/scripts/load-test/docusign-bilateral-soak.js \
   STAGING_CHANGED_BEHAVIOR="DocuSign bilateral: outbound signer capture (_signers, GUIDs only); record deep-link metadata write-authority guard (0423); inbound Recipient-Connect server-side classification + declared-hash DECLARED_UNVERIFIED evidence class; nonce tenant-scoping (0424)" \
   ./scripts/staging/provision-isolated-rig.sh --name docusign-bilateral --profile mock \
     --image <rc-image@sha256> --source-head <full-40-char 1cf939e5a...> \
     --soak-id docusign-bilateral-2026-08-30 --rig-id docusign-bilateral --lease-id <session> --apply
   ```
3. **Add the DocuSign flags to the rig deploy** (the mock profile does not set them): redeploy the rig service with `ENABLE_DOCUSIGN_WEBHOOK=true`, `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE=true`, `ENABLE_CONNECTOR_ARTIFACT_DRAIN=true`, and — staging-only, to exercise the path that stays OFF in prod — `ENABLE_DOCUSIGN_INBOUND=true`. (Do NOT set these in prod; prod keeps inbound OFF pending the SCRUM-3818 go-live gate.)
4. **Drain firing**: the mock profile deploys `--min-instances=0`, so in-process node-cron will NOT fire the connector-artifact drain. Either set `--min-instances=1` on the rig, OR confirm the harness supervisor POSTs to `/jobs/connector-artifact-drain` on its loop (it should — verify in `docusign-bilateral-soak.js`). Without one of these, connector_artifacts never materialize into anchors and the end-to-end proof is missing.
5. **Seed a second org**: the baseline fixture seeds one org; add a second synthetic org with a distinct `account_id` + `hmac_keys` so per-org isolation can be asserted.
6. **Verify before starting the clock**: rig `/health` healthy (database/anchoring/kms ok), `list_migrations` head `0424`, preflight `environment_type=clean_mirror`.
7. **Launch load, detached, 48 h**: `nohup` the harness driver against the rig worker URL with the documented mix (steady RPS + the adversarial families), writing evidence to `docs/staging/docusign-bilateral/evidence/`. **Soak clock = Cloud Run worker uptime**, not the driver loop.
8. **Capture INITIAL evidence** (first cycles) with `docusign-bilateral-evidence.sql` against the rig ref: `_signers` landing with no name/email; guard strips of forged `connector_source`/`account_id`; inbound classification + `DECLARED_UNVERIFIED`; the F1 provenance-conflict alert on the forgery-collision; nonce replay rejection; two-org isolation. This proves the soak is real from the outset.
9. **PR-3 evidence**: run `e2e/record-detail.spec.ts` DocuSign block against the rig and capture UAT screenshots at 1280 + 375.

## Seal at maturity (~48 h later)
- Verify Cloud Run worker **uptime continuity** across the window (a restart resets the clock — `feedback_soak_clock_is_worker_uptime`).
- Filter evidence to `<= window end` (avoid the post-window-overrun trap from the 2026-08 soaks).
- Populate `docs/staging/rc-manifests/rc-docusign-bilateral-2026-08-30.json`: per-PR head SHAs (#2472 `b89fdd6ac`, #2474 `877a553db`, #2473 `615db8b71`, #2476 `a7695f305`), base SHAs, tier, clean preflight, rig ref + service + revision + image digest, deploy log id, E2E result, rollback rehearsal (down/up of 0423+0424), soak start/end.
- Then mark PRs Ready (Mergify merges, order #2472 → #2474 → #2473 → #2476). **PR #2476 must be reconciled onto #2474 first** (adopt the `fingerprint_source` `document_bytes`/`issuer_record_attestation` ternary + the 4 test updates the RC merge required — see the RC branch resolution) or the merge conflicts.
- Tear down after seal (§7): `scripts/staging/teardown-isolated-rig.sh docusign-bilateral`.

## Do NOT
- Do not flip `ENABLE_DOCUSIGN_INBOUND` in prod — the go-live gate (SCRUM-3818 comment) is unmet.
- Do not touch the two soaks other sessions are running (`credits-2442`, `cleanup-2335`).
