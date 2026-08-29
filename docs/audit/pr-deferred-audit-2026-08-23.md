# PR Deferred & Discovered Work Audit — 2026-08-23

> Every PR ever opened in `carson-see/ArkovaCarson` was swept for work its author deferred,
> discovered-but-did-not-fix, or left as a known limitation. Each item was then reconciled against
> Jira and against `origin/main`, and independently peer-reviewed.
>
> **Nothing in this document is asserted from memory.** Every evidence quote is a machine-verified
> verbatim substring of its source PR, and every verdict was checked against code on `origin/main`
> @`3db27b540` by one agent and re-checked by a second adversarial agent.
>
> Tracking epic: [SCRUM-3373](https://arkova.atlassian.net/browse/SCRUM-3373) ·
> 375 stories filed under label `pr-deferred-audit`.

## Method

- Dumped all **2,365 PRs** from `carson-see/ArkovaCarson` (16.7 MB of bodies) plus **1,223 PRs' worth of human comments** (bot authors filtered).
- Keyword-swept for deferral/discovery language → 663 candidate PRs (bodies) + 192 (comments).
- 17 parallel extraction agents pulled **854 discrete work items**, each carrying a verbatim evidence quote.
- **Every one of the 854 quotes was machine-verified as an exact substring of its source text — zero paraphrases, zero fabrications.**
- Cross-source dedupe → **839 distinct issues**.
- 42 reconciliation agents checked each against `origin/main @3db27b540` and the full **3,197-issue** Jira index (SCRUM-1 → SCRUM-3197, zero gaps).
- 42 adversarial peer reviewers independently re-ran the decisive check on all 839. **61 verdicts corrected (7.3%).**
- 4,918 verification tool calls total.

## Outcome

| Verdict | Count | Meaning |
|---|---:|---|
| `untracked-open` | 280 | No Jira issue, work outstanding → **story created** |
| `tracked-open` | 174 | Existing open Jira issue covers it |
| `tracked-done-resolved` | 145 | Closed and genuinely shipped |
| `untracked-resolved` | 111 | No ticket, but work has since landed |
| `tracked-done-but-open` | 95 | **Jira says Done, code says otherwise** → story created |
| `not-actionable` | 33 | Superseded / stale / process-only |
| `unclear` | 1 | Undetermined |

**549 actionable** of 839. 375 new Jira stories filed under epic SCRUM-3373.

| Priority | Total | untracked-open | tracked-open | false-Done |
|---|---:|---:|---:|---:|
| P0 | 6 | 2 | 4 | 0 |
| P1 | 143 | 53 | 65 | 25 |
| P2 | 278 | 144 | 87 | 47 |
| P3 | 122 | 81 | 18 | 23 |

Soak tiers: T0 159 · T1 85 · T2 199 · T3 106. 
67 need a migration. 138 require a prod check to close out.

## P0 — verified against origin/main

### DI-398 · [API] GET /api/v1/anchor/{publicId}/evidence 404s for every anchor — select references three nonexistent columns
*untracked-open · T2/M · Jira (new) · PRs #1316*

MUCH WORSE THAN THE PR DESCRIBED — this is a live broken endpoint, not a latent null. services/worker/src/api/v1/anchor-evidence.ts defaultLookup.byPublicId (lines 271-280) selects from `anchors`: '… description, jurisdiction, merkle_root, recipient_hash, org_id, organization:org_id(display_name)'. NONE of jurisdiction, merkle_root or recipient_hash is a column on anchors: the baseline CREATE TABLE "public"."anchors" in 00000000000000_baseline_at_main_HEAD.sql lists 37 columns and contains none of them, and the generated anchors Row type in BOTH src/types/database.types.ts and services/worker/src/types/database.types.ts omits all three. The sibling file states it outright — services/worker/src/api/v1/verify.ts lines 668-671: 'NOTE on jurisdiction + merkle_root: neither is a top-level `anchors` column. `merkle_root` lives on `anchor_proofs.merkle_root` … `jurisdiction` lives in `anchors.m

### DI-453 · [SEC-HARDEN-02] Finish IAM blast-radius remediation — compute-SA key migration, Owner removal, key-creation org policy
*tracked-open · T0/L · Jira SCRUM-3127 · PRs #1536*

Half executed, half explicitly deferred — read from two docs on origin/main. DONE: docs/security/gcp-key-remediation-2026-08-21.md records the arkova-cli downloadable key 00548b68a6195b5422eb6031a537f9bc07cbaace deleted 2026-08-21T16:09Z after verifying the serviceAccountTokenCreator impersonation path worked, with post-checks (keys list --managed-by=user empty, local credential revoked, all 7 Cloud Run services reachable); a second key cea7e000… had already gone; Data Access audit logging for secretmanager/cloudkms was enabled. Also done: the P0-b cron rotation (see DI-450). NOT DONE, per the same doc: the compute-SA key fd2b4667ee93b9c16644cc4174448cc41d706283 must not be deleted yet (17 auths in 24h, drives rig standup and is the active local gcloud identity; two prerequisites named — amend scripts/ops/gcloud-auth-preflight.sh, rehearse a rig standup on the new identity); `constraints

### DI-575 · [SEC] Verify 0378/0380/0391/0396 SECURITY DEFINER revokes and guards are applied in prod
*tracked-open · T3/M · MIGRATION · Jira SCRUM-2918 · PRs #1758*

ALL SEVEN NAMED FUNCTIONS ARE REMEDIATED IN CODE. supabase/migrations/0378_sec_recon_revoke_deferred_security_definer_grants.sql is on origin/main, contains 50 `REVOKE ALL` statements and explicitly covers the CRITICAL set — finalize_public_record_anchor_batch (line 140), BOTH drain_submitted_to_secured_for_tx overloads (lines 131 and 134), bulk_promote_confirmed (line 137) — and the MEDIUM set — increment_org_usage (187), search_credential_embeddings (241), link_public_records_to_anchors (143), get_pending_user_anchors (224) — each as `REVOKE ALL ... FROM PUBLIC, anon, authenticated` followed by `GRANT EXECUTE ... TO service_role`, which is the correct form given anon/authenticated are granted directly at CREATE. Its header (lines 7-11) records the trigger: an unauthenticated POST /rpc/bulk_promote_confirmed returned HTTP 200 against a prod-mirror rig. The two functions 0378 deferred (g

### DI-635 · [FD-PROD-1] Apply migration 0386 to prod — close the anon fingerprint existence oracle
*tracked-open · T3/S · MIGRATION · Jira SCRUM-3185 · PRs #1841*

supabase/migrations/0339_get_public_anchor_by_fingerprint.sql line 67 restricts to `AND a.status = 'SECURED'`. supabase/migrations/0386_fingerprint_lookup_secured_only.sql exists on origin/main and its header records the drift in detail: base captured via pg_get_functiondef on prod ref vzwyaatejekddvltxyye 2026-08-02 (body md5 1fd78aece7613fd191f7a053f2f66475), 'Production instead runs `a.status IN ('SECURED','SUBMITTED','PENDING')`. No migration on main redefines this function after 0339, so the running body has NO SOURCE IN THE REPOSITORY', with measured exposure '3 PENDING + 48,149 SUBMITTED non-deleted anchors are currently confirmable by an ANONYMOUS caller'. Jira SCRUM-3185 (Bug, To Do, parent SCRUM-3160): 'FD-PROD-1 — migration 0386 is merged but was never applied to prod; the fingerprint existence oracle it closed is still open live'.

### DI-708 · [OPS] Apply cloud-scheduler.sh to prod — provision the 11 declared-but-missing Scheduler jobs
*tracked-open · T3/L · Jira SCRUM-3192 · PRs #2067*

The manifest half landed (commit 52eb167cc 'feat(gcp-setup): scheduler-coverage ratchet + 2026-08-10 CTO-decision bindings'): scripts/gcp-setup/cloud-scheduler.sh now declares nonce-sweep (L64), drive-file-changed (L154), cleanup-retention (L209, header notes cleanup_expired_data() was verified NOT covered by prod pg_cron), treasury-alert-check, detect-reorgs/monitor-stuck-txs/rebroadcast-txs, plus a NOT_SCHEDULED block and a coverage contract pinned by cloud-scheduler.test.ts. The provisioning half is NOT done: SCRUM-3192 (Bug/To Do, parent SCRUM-2509) reads 'cloud-scheduler.sh defines 70 jobs, prod has 60; detect-reorgs, monitor-stuck-txs, rebroadcast-txs among the 11 missing.'

### DI-833 · [WORKER] Audit every unleased in-process cron for double-fire at minScale=2 and retract the CPU-throttling dormancy claim
*untracked-open · T3/L · Jira (new) · PRs #2335*

CONFIRMED outstanding on origin/main. `services/worker/src/routes/scheduled.ts` registers 19 in-process jobs via `scheduleInProcess(...)` (recover-stuck-broadcasts, process-batch-anchors, check-submitted-confirmations, process-revoked-anchors, process-webhook-retries, process-monthly-credits, reconcile-credit-conservation, anchor-expiry-sweep, check-stuck-anchors, cleanup-expired-data, detect-reorgs, monitor-stuck-transactions, rebroadcast-dropped-transactions, consolidate-utxos, monitor-fee-rates, populate-confirmation-proofs, drain-connector-artifacts, drive-file-changed, drive-subscription-renewal). Only FOUR job entrypoints wrap `withRunLease` outside tests: `jobs/batch-anchor.ts:641`, `jobs/check-confirmations.ts:901`, `jobs/drive-subscription-renewal-deps.ts:281`, `jobs/publicRecordAnchor.ts:886`. `.github/workflows/deploy-worker.yml:479-480` deploys `--min-instances 2 --max-instan

## False-Done — closed tickets whose work is not on main

The highest-trust-cost category: 95 issues Jira reports as Done where the code demonstrably lacks the work.

| Audit id | Jira | Prio | Summary | Verified reality |
|---|---|---|---|---|
| DI-017 | SCRUM-1108 | P1 | [SDK-PUBLISH] Publish @carsonarkova/sdk and @arkova/embed to npm and wire the em | Split outcome, verified against live registries. NOT PUBLISHED: `npm view @carsonarkova/sdk version` → npm error code E404, 'Not Found - GET https://registry.npmjs.org/@carsonarkova%2fsdk';  |
| DI-048 | SCRUM-1021 | P1 | [CIBA] Wire ARK-109 semantic matcher and ARK-110 rule-draft endpoint into produc | LOUD: both modules exist but NEITHER has a single production importer on origin/main — they are dead code behind Done tickets. ARK-109: `git grep -rn "ruleMatcher" origin/main -- services/wo |
| DI-058 | SCRUM-1063 | P1 | [GCP-MAX] Wire runCloudLoggingDrain to a cron route and Cloud Scheduler job (SOC | LOUD: the drain is dead code — worse than the item's 'needs manual Cloud Scheduler provisioning' framing. `services/worker/src/jobs/cloud-logging-drain.ts:36` exports `runCloudLoggingDrain() |
| DI-077 | SCRUM-1167 | P1 | BILLING Build POST /api/v1/org/split-from-parent — clone sub-org, carry anchor l | getJiraIssue SCRUM-1167 = Done; its Technical Notes say 'Split-off flow: new POST /api/v1/org/split-from-parent with signed-token auth. Worker clones rows under a transaction.' On origin/mai |
| DI-078 | SCRUM-1165 | P1 | BILLING Ship the anchor-fee credit pack family — purchase route, consumption ord | getJiraIssue SCRUM-1165 ('Extend prepaid credit packs to cover Bitcoin anchoring network fees') = Done, with ACs 'New pack type anchor_fee_credits distinct from existing API credit packs', ' |
| DI-090 | SCRUM-1208 | P1 | [SEC] ENABLE_ATS_WEBHOOK kill-switch is inert — wire it or delete it; reconcile  | FLAG LOUDLY — two concrete defects survive the Done epic. (1) The ENABLE_ATS_WEBHOOK kill-switch DOES NOT EXIST on any route. It is declared in services/worker/src/middleware/integrationKill |
| DI-094 | SCRUM-1146 | P1 | [UI] Build the connector setup wizard + health dashboard against GET /api/admin/ | FLAG LOUDLY — backend shipped, UI never did, story is Done. SCRUM-1146 '[R2/P1] Connector setup wizard and health dashboard' is Done and its acceptance criteria are explicitly UI ('Wizard li |
| DI-106 | SCRUM-1024 | P1 | [INFRA] Complete SCALE-02: Cloud Run scale metrics, PgBouncer, DB circuit breake | FLAG: getJiraIssue SCRUM-1024 → status Done, yet EVERY acceptance-criteria and DoD checkbox in the description is still `[ ]` (Cloud Run config, scale metrics, PgBouncer, circuit breaker, lo |
| DI-116 | SCRUM-123 | P1 | [CHAIN] Migrate treasury signing from WIF to GCP KMS or record a formal WIF-rete | origin/main: `services/worker/src/chain/signing-provider.ts:47-72` defines `WIFSigningProvider` (`readonly name = 'WIF (ECPair)'`, `ECPair.fromWIF`), and its header (:5-15) plus `services/wo |
| DI-128 | SCRUM-1265 | P1 | [BILLING] Add real Stripe test-mode E2E asserting credit-pack checkout is mode=p | Read SCRUM-1265 via getJiraIssue: status Done, but its own acceptance-criteria list still shows unchecked boxes '[ ] Real Stripe-test E2E test green' and '[ ] Smoke test addition active and  |
| DI-147 | SCRUM-1272 | P1 | [SEC-API] Add a JWT-claims scope-enforcement path and mount compliance:read on F | LOUD FLAG — PHI/PII routes are still scope-unguarded. origin/main:services/worker/src/api/v1/router.ts:655-660 mounts `router.use('/ferpa', requireAuth, aiRateLimiter, ferpaDisclosuresRouter |
| DI-175 | SCRUM-1283 | P1 | [R3-10] Verify + document the Cloudflare bot-management rule the MCP edge gate d | Sub-issue D is the one of the four that did NOT land. The consuming code exists — `services/edge/src/mcp-server.ts:1022-1024` reads `((request as any).cf?.botManagement?.verdict as string \| |
| DI-187 | SCRUM-1283 | P1 | [EDGE-SEC] Provision R2_REPORT_DOWNLOAD_SECRET via wrangler and document it in E | services/edge/src/report-generator.ts:57-67 hard-fails report generation with HTTP 503 when env.R2_REPORT_DOWNLOAD_SECRET is unset, and `git grep -n R2_REPORT_DOWNLOAD_SECRET origin/main` sh |
| DI-244 | SCRUM-1722 | P1 | [INFRA] Generate BigQuery table schemas from bq-export-schemas.ts and retire the | SCRUM-1722 is Subtask/Done, and services/worker/src/jobs/bq-export-schemas.ts (the TS source of truth) exists. But the drift it was supposed to reconcile is UNFIXED on origin/main: scripts/g |
| DI-248 | SCRUM-1743 | P1 | [WEBHOOKS] Mark credential.issued/status_changed live in the event catalog and t | Three of the four checklist items landed and are verified on origin/main: credential.issued at services/worker/src/api/v1/credential-sources.ts:608 (comment at :751 cites SCRUM-1798); creden |
| DI-333 | SCRUM-1869 | P1 | [CLE] Pass cle_metadata from RecordDetailPage into AssetDetailView — the CLE det | SCRUM-1869 is Done in Jira but the CLE detail path is demonstrably NOT wired on origin/main. Piece 1 (RPC) IS done: 0331_scrum1847_1869_public_anchor_cpe_cle_metadata.sql adds cle_metadata,  |
| DI-348 | SCRUM-1849 | P1 | [CPE] Wire org-admin per-member CPE export UI + threshold alerts (SCRUM-1849/186 | SCRUM-1849 (Story/Done) scope reads "New route /org/cpe behind ORG_ADMIN role gate", "Configurable threshold alerts", "Org CPE export: delegates to R2 export endpoint per member"; its subtas |
| DI-355 | SCRUM-1849 | P1 | [CPE] Wire org-admin per-member CPE export UI + threshold alerts (SCRUM-1849/186 | Identical checks to DI-348: on origin/main `git grep -rn "exports/org/cpe-log" origin/main -- src e2e` returns ZERO hits — the org-admin per-member export backend (services/worker/src/api/v1 |
| DI-390 | SCRUM-2247 | P1 | [SEC] Set ENABLE_SEMANTIC_SEARCH + ENABLE_AI_FRAUD false in deploy-worker.yml an | LOUD FLAG. SCRUM-2247 (and its duplicate SCRUM-2241) '[HARDEN-1-D] Switchboard flag env/DB fail-open re-enables disabled features' is marked Done, and its description is verbatim this item:  |
| DI-436 | SCRUM-2484 | P1 | [SEC] Provision RECIPIENT_IDENTIFIER_PEPPER + app.recipient_pepper GUC and backf | FLAG: SCRUM-2484 is Done and its code shipped, but the control is INERT. origin/main:docs/design/provenance-chain-spec-2026-08-20.md:163 records a direct verification three days ago: 'app.re |
| DI-558 | SCRUM-3061 | P1 | [FRONTEND] Stop the disabled drop-zone file input swallowing Remove-file clicks | Fixed on origin/main by commit `5674ae63d` ("fix(upload): stop the drop-zone file input swallowing Remove-file clicks (#1747)"), found via `git log -S"inputInert" -- src/components/anchor/Fi |
| DI-587 | SCRUM-1108 | P1 | [SDK-NPM] Publish @carsonarkova/sdk v2.2.0 to npm and finish the scope rename fo | Live registry check: `npm view @carsonarkova/sdk version` → npm error code E404, "404 Not Found - GET https://registry.npmjs.org/@carsonarkova%2fsdk" (run 2026-08-23). packages/sdk/package.j |
| DI-593 | SCRUM-2075 | P1 | [DS-PROD] Reopen SCRUM-2075 — production DocuSign OAuth round-trip was closed Do | Fetched live: SCRUM-2075 "[Verify] Production round-trip — real envelope, HMAC, anchor queue, Confluence close-out" is status Done with resolution Done, last updated 2026-08-02, parent SCRUM |
| DI-671 | SCRUM-3112 | P1 | [CE] Confirm registry-anchor self-recipient fix live in prod and close SCRUM-311 | CODE FIX HAS LANDED: services/worker/src/api/v1/credentials-ctdl-registry-anchor.ts on origin/main defines `linkSelfRecipient(anchorId, userId)` at line 280 (inserts anchor_id + recipient_em |
| DI-785 | SCRUM-2603 | P1 | [API] Land the withheld verify mount-order fix — public /api/v1/verify must get  | LOUD FLAG — SCRUM-2603 is Done in Jira (fetched live, status 'Done') but the defect is demonstrably still on origin/main. `git show origin/main:services/worker/src/index.ts` line 422 still r |
| DI-015 | SCRUM-643 | P2 | [INT-02b] Expose cle_verify as an MCP tool by threading caller API keys through  | SCRUM-643 '[INT-02] MCP Server Tool Enhancement — anchor/verify/batch/nessie/cle' is status Done, and I fetched its description: the acceptance criteria explicitly include '`cle_verify` tool |
| DI-027 | SCRUM-907 | P2 | [NCA-FU3-FU] Close jurisdiction_rules to >=100 rules + add LGPD/Thailand/Malaysi | SCRUM-907 is Done, and its AC1 is literally 'jurisdiction_rules in prod contains >=100 rules across >=20 jurisdictions + >=10 industries', AC2 requires LGPD / Thailand PDPA / Malaysia PDPA / |
| DI-029 | SCRUM-916 | P2 | [DEP-FU] Clean up react-hooks v7 React Compiler violations and re-enable the fiv | Checked all three follow-up stories against main. SCRUM-915 (Tailwind 3->4) LANDED: package.json:137 `"tailwindcss": "4.3.3"` + :107 `@tailwindcss/postcss` 4.3.3, and `git grep -l '@theme' 3 |
| DI-032 | SCRUM-921 | P2 | [MCP-SEC-03-FU] Stop routing edge MCP reads through service_role — scoped RPC or | SCRUM-921 is Done with AC 'All 6 tools converted' and 'Test: two API keys in different orgs see only their own data across every tool'. Main contradicts it. services/edge/src/mcp-server.ts:1 |
| DI-061 | SCRUM-1024 | P2 | INFRA Finish SCALE-02 Cloud Run autoscale: max-instances 20, explicit concurrenc | getJiraIssue SCRUM-1024 = Done; its AC list demands `min_instances: 2, max_instances: 20, concurrency: 80`, PgBouncer at 100 connections with 10 per instance, and a custom queue-depth scale  |
| DI-072 | SCRUM-1168 | P2 | CONNECTORS Build Microsoft Graph and Adobe Sign OAuth connectors + admin cards o | getJiraIssue SCRUM-1168 = Done and its ACs cover all four providers ('POST /api/v1/integrations/:provider/oauth/start ... Microsoft Graph: POST /subscriptions on driveItems (30-day) ... Adob |
| DI-073 | SCRUM-1147 | P2 | CONNECTORS Implement Microsoft Graph subscription renewal and retire the throwin | getJiraIssue SCRUM-1147 ('[R2/P1] Google Drive and Microsoft Graph subscription renewal monitor') = Done, AC 'Renewal job refreshes channels before expiration'. On origin/main the workspace  |
| DI-076 | SCRUM-1167 | P2 | BILLING Wire grace-warning and parent-delinquent-split emails to a sender — both | Both template modules DID land: `services/worker/src/emails/grace-warning.ts` exports `GraceWarningEmailData` (:10), `buildGraceWarningEmail` (:32) and `sendGraceWarningEmail` (:60); `servic |
| DI-108 | SCRUM-1094 | P2 | [TEST] Add notification-center E2E specs, screenshots, and keyboard-accessibilit | FLAG: getJiraIssue SCRUM-1094 → status Done, AC explicitly requires "E2E green at 1280px + 375px", "Screenshots attached to PR" and DoD "Accessible keyboard navigation verified". On origin/m |
| DI-110 | SCRUM-1087 | P2 | [TEST] Seed a 3-level sub-org fixture and extend public-org E2E with depth-3 ren | FLAG: getJiraIssue SCRUM-1087 → Done, with AC "Test case: org with 3-level hierarchy renders correctly", "Test case: attempting to insert a 4th-level sub-org is rejected by CHECK constraint" |
| DI-120 | SCRUM-1304 | P2 | [CI] Enable SonarQube Coverage-on-New-Code >= 80 quality gate | `scripts/ci/check-sonar-quality-gate.ts` on origin/main (header: "SCRUM-1304 / SCRUM-1681 — SonarCloud quality-gate verification CI script") polls the SonarCloud API and exits non-zero unles |
| DI-123 | SCRUM-1305 | P2 | [OPS] Deploy/verify all 6 SCRUM automation rules in Jira UI and stamp deployed_a | origin/main:docs/jira-workflow/automation-rules.json line 9 still reads "deployed_at": null in _metadata, and rule R6 carries a `corrected_2026_08_01` field whose own text says: "Re-apply th |
| DI-131 | SCRUM-896 | P2 | [API] Document GET /anchor/{publicId}/lifecycle in the served OpenAPI spec and b | Split outcome, verified path-by-path. The SCRUM-895 (API-RICH-02) half genuinely landed: confidence_scores and sub_type are in the SERVED spec at origin/main:services/worker/src/api/v1/docs. |
| DI-132 | SCRUM-896 | P2 | [API] Close SCRUM-896 DoD — lifecycle endpoint missing from served spec and both | Same checks as DI-131, run against SCRUM-896's DoD rather than the deferral note. SCRUM-896 ('New endpoint: GET /api/v1/anchor/{publicId}/lifecycle') is Done in Jira while origin/main shows  |
| DI-135 | SCRUM-1172 | P2 | [API] Implement webhook delivery replay by date range and anchor ID (SCRUM-1172  | SCRUM-1172 read via getJiraIssue — AC3 verbatim: 'Given a partner wants reconciliation, when they call the replay endpoint, then events can be replayed for a date range, anchor ID, or failed |

*(showing 40 of 95; full set in Jira under label `tracked-done-but-open`)*


## Where the numbers come from

Reproduction artifacts live in the session scratchpad (`prs-all.json`, `extracted-all.json`,
`issues-deduped.json`, `verdicts-final.json`, `created-map.json`). The evidence validator
re-runs as `validate_evidence.py` and reported `Counter({'exact': 854})` — every quote matched
its source exactly.

Verification counts: 4,918 tool calls across 84 reconciliation/review agents; 635 across the
15 story-creation agents. Story creation was confirmed server-side by JQL
(`project = SCRUM AND labels = "pr-deferred-audit"` → 375), not from agent self-report.

_Last refreshed: 2026-08-23 by CTO (Claude) — claims verified against origin/main, GitHub API and Jira JQL output._
