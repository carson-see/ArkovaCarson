# DocuSign Bilateral — Batched RC Soak Plan
Date: 2026-08-30. Authority: CTO. Governs the soak for PRs #2472 / #2474 / #2473 / #2476.
SOC 2 Type 2 bar: continuous load, exercises the changed behavior end-to-end, per-org isolation, empirical DB proof — no hollow soaks (`feedback_soaks_must_meet_soc2_type2`).

## Why one rig, not four
All four PRs are one feature that lands together. Per §1.12, a batched T2/T3 release candidate may centralize soak evidence in an RC-manifest while preserving per-PR authorization, tier, exact head SHA, and rollback. A single isolated rig with **both** migrations applied (`0423` guard + `0424` nonce) + the combined worker is the honest merged state. This is cost-efficient (two other soaks — `credits-2442`, `cleanup-2335` — are already running; do not touch them) and §1.11A-compliant (exclusive, verified-clean, isolated project).

## Rig standup (isolated project, NOT a preview branch)
1. `scripts/staging/provision-isolated-rig.sh --apply` with `CONFIRM_PROVISION` + `CONFIRM_REAL_CONFIG` as required — name `docusign-bilateral`. Creates a standalone Supabase project (us-east-2) + wired `arkova-worker-docusign-bilateral-staging` Cloud Run service on the prod-pinned image, replays schema, seeds baseline, requires `clean_mirror` from `scripts/ci/staging-honesty-preflight.ts` before returning.
2. Link the rig, apply the feature migrations: `npx supabase db push --linked` (brings the rig to head `0424` on top of the replayed baseline).
3. Build + deploy the combined-RC worker image (all four branches merged into an RC tree) to the rig service. linux/amd64, full 40-char SHA (`feedback_docker_amd64_for_cloud_run`, `feedback_full_sha_for_cloud_run`).
4. Rig env deltas vs prod: `USE_MOCKS=true`, `ENABLE_PROD_NETWORK_ANCHORING=false` (zero real Bitcoin), `ENABLE_DOCUSIGN_WEBHOOK=true`, `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE=true`, `ENABLE_CONNECTOR_ARTIFACT_DRAIN=true`, and **`ENABLE_DOCUSIGN_INBOUND=true`** — staging-only, to exercise the inbound path that stays OFF in prod. Do NOT set `MEMPOOL_API_URL` (`project_mempool_api_url_contract_bug`).
5. Seed **two** synthetic orgs with distinct DocuSign `account_id` + `hmac_keys` (per-org isolation assertion needs two tenants).
6. Confirm rig `/health` healthy + `list_migrations` head `0424` before the clock starts. `preflight = clean_mirror`.

## Load profile (48h continuous)
Driver: the `test/docusign-bilateral-soak-harness` harness (R9), steady RPS with the documented mix across the two orgs, for the full window. Soak clock = **Cloud Run worker uptime** (`feedback_soak_clock_is_worker_uptime`), not the probe loop. Mix families (each labeled in evidence):
- Outbound envelope-completed WITH signers (0/1/20/25→capped, + max-cardinality 100 docs×20 signers).
- Inbound Recipient-Connect (foreign `senderAccountId`, declared sha256, no bytes).
- Adversarial: self-forgery (incl. F1 envelopeId collision with a real outbound), wrong-HMAC, replay, self-send collision, unknown-account orphan, malformed.
- Guard-trigger probe (direct non-service_role PostgREST write of forged `connector_source`/`account_id`/`_signers`).

## Per-PR evidence assertions (empirical, via the rig service key)
| PR | Tier | Must prove |
|---|---|---|
| #2472 guard `0423` | T3 | Non-service_role writes of the DocuSign key family are stripped/reverted; service_role (worker) writes preserved; `account_id`/`envelope_id` preserved on non-DocuSign rows (conditional guard); zero regression to anchor ingestion. Trigger A/B cycles + daily flush + per-org isolation. |
| #2474 worker signers | T2 | `_signers` (GUIDs only, no name/email) land on `anchors.metadata` at volume; 16KB rule-event payload never exceeded; `_docusign_env` correct; email/name-shaped GUIDs skipped. 12h + rollback rehearsal. |
| #2473 frontend | T2 | E2E `record-detail.spec.ts` DocuSign block passes against a seeded DocuSign anchor on the rig; account/envelope links render + resolve; signer rows render; UAT screenshots at 1280 + 375. Frontend-targeted evidence (`T2_FRONTEND_FIELDS`, `project_frontend_t2_targeted_evidence_path`). |
| #2476 inbound `0424` | T3 | Inbound classification correct (foreign→inbound, self-send→outbound, DB-error→inbound); flag-ON declared-hash anchors are `issuer_record_attestation`/`DECLARED_UNVERIFIED`; **F1 provenance-conflict alert fires** on the forgery-collision; nonce tenant-scoping rejects replays; two-org isolation; no cross-account API fetch invoked. 48h + multiple trigger cycles. |

## RC-manifest
Record the batch in `docs/staging/rc-manifests/rc-docusign-bilateral-2026-08-30.json`: per-PR head SHAs (2472→b89fdd6ac, 2474→877a553db+F1?, 2473→dde760817, 2476→2776e1f23 — capture final heads at freeze), base SHAs, tier, clean preflight result, rig project ref + service + revision + image digest, deploy log id, E2E result, rollback rehearsal (migration down/up for 0423+0424), soak start/end, per-PR risk rationale. Stale heads / dirty preflight / expired evidence fail the same `Staging Soak Evidence Gate`.

## Merge ordering (post-soak, via Mergify — Claude never merges)
PR-1 (#2472 guard) must reach prod before PR-3 (#2473 frontend) renders the trust signal. Land order: #2472 → #2474 → #2473 → #2476. #2476 merges flag-OFF; go-live (flag flip) is separately gated on the SCRUM-3818 go-live checklist + spike SCRUM-3817.

## Honest boundary
T3 = 48h, T2 = 12h wall-clock. These clocks run past the standing-up session. The session that provisions + starts the soak reports precise start/expected-close times and captures INITIAL evidence proving the load is real and the changed paths fire; it does NOT claim completion. Do not mark any PR Ready or transition any Jira issue to Done until its clock matures and evidence is sealed.
