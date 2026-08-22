# Founder Coverage Checklist — 7-Day Full-Functionality Soak

> **Audit date:** 2026-08-12 · **Soak clock:** `2026-08-12T15:51:30Z` → `2026-08-19T15:51:30Z` (rig Cloud Run uptime).
> **Rig:** `arkova-worker-fullsoak-2026-08-staging` rev `00013-mrw`, Supabase `gnkuaywlpmsaezwvlvhk`.
> **Prod:** `arkova-worker`, Supabase `vzwyaatejekddvltxyye`. Both at `git_sha f5d1070fc…`, ledger head **0409** (111 rows).
>
> **What this document is.** The founder's 17-item list, each answered with a *state* and a *receipt* — a §4 row,
> a Day-0 probe number, an e2e spec, or a live query run today. Where an item was weakly covered, a daily probe
> was wired and executed; where it cannot be covered, the reason is named and the founder-side lever (if one
> exists) is listed in the last section.
>
> **The finding that governs the rest of this document:** `scripts/staging/fullsoak-daily-check.sh` is a
> **parity/integrity checker** (assertions `A1`–`A19`: frozen SHA, image digest, env hash, flag hash, scheduler
> census, ledger head, `/health`). It asserts the rig has not *drifted*. **It contains zero product-behaviour
> assertions.** Every §4 coverage row that promised "daily" for a *feature* — cross-tenant isolation, the
> anon-RPC deny sweep, revoked-key refusal, webhook HMAC rejection — had no instrument behind it. Those rows
> were planned, not wired. `scripts/staging/fullsoak-daily-probes.sh` (new, this audit) is that instrument.

---

## 0. What was wired and run today

**New:** `scripts/staging/fullsoak-daily-probes.sh` — 10 probe groups, 39 assertions. JWT / API-key traffic only;
no service-role writes; never touches `anchors` / `anchor_proofs` directly; cannot restart the worker, so it
cannot void the clock. Run it **alongside** `fullsoak-daily-check.sh`, not instead of it.

Full run executed 2026-08-12T16:26:33Z against the live rig — **35 PASS · 2 FAIL · 2 SKIP**.
Artifact: `docs/staging/evidence/fullsoak-2026-08/2026-08-12/probes-162633Z.{txt,json}`.

| Probe | Item | Runs | Status today |
|---|---|---|---|
| P1 login (both orgs mint real JWTs; wrong password refused) | 3 | daily | 3 PASS |
| P2 cross-tenant (positive access **then** denial, 4 planes) | 14 | daily | 4 PASS |
| P3 invitations (`invite_member` row delta; escalation + cross-org refused; public token preview) | 6 | daily | 4 PASS |
| P4 folders (create / rename / file anchor / cross-org denial / delete releases) | 13 | daily | 5 PASS |
| P5 DPA field policies (anon denied; ORG_ADMIN cannot self-disarm) | 10 | daily | 3 PASS, 1 SKIP (inert by design) |
| P6 QR verification target (anon `get_public_anchor`; distinct not-found payload) | 11 | daily | 2 PASS |
| P7 API-key scope + revocation | 17 | daily | 2 PASS, **2 FAIL — real defect** |
| P8 anon-RPC deny sweep (grant census rig+prod, then safe invocation sweep) | 14 | daily | 5 PASS |
| P9 webhook HMAC rejection (DocuSign + Drive, forged) | 8 | daily | 2 PASS |
| P10 dashboards data-level (4 worker dashboards + anon 401) | 15 | daily | 4 PASS, 1 SKIP (429) |

**Fixture ledger for this audit** (§1.11A honesty — every row I created):

| Table | Delta | Detail |
|---|---|---|
| `api_keys` | 7 → **11** | 4 × `soak-daily-revocation-probe-*`, `verify` scope only, free tier, org Arkova. **They cannot be deleted through the product surface** — see item 17. Script now caps probe keys at 8. |
| `invitations` | 0 → **2** | `ORG_MEMBER` invites to `soak-probe-*@arkova-soak.invalid` (non-routable domain, no email sent). |
| `folders` | 0 → **0** | Probe folders created and deleted in-run; self-cleaning. |
| `anchors` / `anchor_proofs` | 12 / 12 → **12 / 12** | Unchanged. No anchor created, no proof written, no status touched. |
| `organization_field_policies` | 0 → **0** | The write-lock held — the attempted INSERT was refused (that *is* the assertion). |

Three probe defects were found and fixed by running the instrument against reality rather than trusting it:
the `invite_member` role argument is `ORG_MEMBER` (not `MEMBER`); `folders_insert_own` requires `created_by =
auth.uid()`, so the probe must send the JWT's own `sub`; and the Drive rejection path keys off a **known**
channel with a wrong token — a made-up channel id acks with 200 and proves nothing. A fourth apparent failure
(`get_public_anchor` on an unknown id) turned out to be correct product behaviour: HTTP 200 carrying
`{"error":"Record not found"}`. The assertion was corrected to test the payload, not the status.

---

## 1. All cron jobs — the honest fraction

**State (updated 2026-08-12T17:00Z): 25 of 110 routes SOAKING-CONTINUOUS + 31 now DAILY-EXERCISED = 56 of 110
(50.9%) reached. 51 remain uninvoked, and every one of them is uninvoked BY A WRITTEN POLICY, not by omission.**

**The instrument that changed this row: `scripts/staging/fullsoak-cron-exerciser.sh` (new).** It enumerates
routes from the SHA the rig is actually running (`git show f5d1070fc:…/cron.ts` — 110 declarations), diffs
against the live Scheduler census, and force-runs the unbound set that a per-route policy table permits. Every
route it will not invoke carries a deny code (D1–D8) or a live precondition guard (G1–G5); a route present in
`cron.ts` but absent from the table is denied as `unclassified`, so adding a route can never silently cause an
unreviewed invocation. Anchor-cohort integrity is asserted before and after every run.

**First run, 2026-08-12T16:58Z — `CRON_EXERCISER: 31 ok / 3 findings / 51 denied`**, cohort `anchors 12 → 12 ·
anchor_proofs 12 → 12` **intact**. Artifact: `docs/staging/evidence/fullsoak-2026-08/2026-08-12/cron-exerciser.md`.

| Finding | Route | What it is |
|---|---|---|
| **FD-2 reproduced independently** | `/jobs/check-credential-expiry` | HTTP 500. Rig log: `42703 column anchors.document_title does not exist`. Confirmed **prod-exposed** — neither `document_title` nor `not_after` exists in prod's `anchors` either. |
| **FD-C1 (new)** | `/jobs/calibration-refit` | HTTP 500. Rig log: `PGRST205 Could not find the table 'public.calibration_features'`. The view **does not exist in prod either** (`information_schema.tables` count = 0 on `vzwyaatejekddvltxyye`). Same shape as FD-2: an unbound route that 500s on its first line the moment anyone schedules it or triggers it from the admin dashboard. |
| **FD-C2 (new)** | `/jobs/smoke-test` | HTTP 503 — `passed 5, failed 1`. The failing check is `anchor-count: "0 total anchors"` while the rig holds 12. Root cause: `refresh_cache_anchor_status_counts()` derives its total from `pg_class.reltuples` (a planner estimate) and its SECURED bucket by subtraction, so on any environment whose `anchors` statistics are stale or never analysed it publishes **0** — passed through as a real zero, with no staleness sentinel (the function has a `-1` sentinel for the *absent-cache* case but none for the *stale-estimate* case). Live: rig cache `{"total":0,"SECURED":0}` refreshed 16:52:16Z while `anchor_type_counts`, computed by direct `count(*)` on the same table in the same pass, correctly reports 12. Prod reads 3,492,637 only because autovacuum keeps a 3.5M-row table's estimate warm. **Consequence: the platform/pipeline admin dashboards report 0 anchors on the rig for the whole soak, and daily probe P10 cannot catch it** — P10a/P10b assert a populated payload shape, never a correct number. |

`/jobs/professional-education-extraction` returns 503 and is recorded **BY-DESIGN**, not as a finding: it is the
`ENABLE_PROFESSIONAL_EDUCATION_SCHEMA_READY` gate answering exactly as designed.

**The 51 uninvoked, by policy code:** D1 external-registry ingestion ×42 · D2 retention purge ×1
(`cleanup-retention`) · D3 mainnet ×1 · D4 real BTC spend ×1 · D5 writes `anchor_proofs` ×1 · D6 advances a
durable census checkpoint even in dry-run ×1 · D7 unbounded backfill export ×1 · D8 mutates the Drive
connection row P9b depends on ×1 · **G2 guard failed** (`report-metered-usage`: 2 active/trialing subscriptions
on the rig — invoking it would fire real Stripe meter events) · **G4 guard failed** (`queue-reminders`: 1 enabled
`SCHEDULED_CRON`/`QUEUE_DIGEST` rule — invoking it would queue a PENDING execution the BOUND
`rule-action-dispatcher` then really delivers). The three guards that passed (`credit-expiry`,
`monthly-allocation-rollover`, `payment-recovery`) were each proven inert by a live read first, then invoked.

**D1 is the one a human should re-examine** — it is 42 of the 51. Those routes are denied because
`/jobs/anchor-public-records` **is** Scheduler-bound on this rig (`*/10`) and converts unlinked `public_records`
rows into PENDING anchors, so fetching even one page mutates the 12-anchor BL-2 cohort the Day-7 offline proof
verification depends on. Exercising them needs either the `anchor-public-records` job paused for the duration
(a scheduler change — not available mid-soak) or a separate rig. That is a deliberate trade, not a gap in the
instrument.

**Receipt (original census).** `cron.ts` on `origin/main` declares **109 unique routes** (`cronRouter.get|post`,
115 declarations, 109 distinct paths); the exerciser's own parse of the frozen SHA counts **110** distinct paths,
the extra being the `GET /jobs/smoke-test/history` sub-path. Cloud Scheduler binds **26 fullsoak jobs** covering
**25 distinct routes** —
`batch-anchors` and `batch-anchors-forced-flush` both target `/jobs/batch-anchors`, and `db-health-monitor`
targets `/jobs/db-health` (verified live: `gcloud scheduler jobs list … --format='value(httpTarget.uri)'`).
Job list and force-run proof: `docs/staging/fullsoak-2026-08/deg1-cron-parity-evidence.md` §4.
Canonical finding: **FD-13** in `manifest-DAY-0.md` §11 ("Cron coverage is ~21–24%").

**The §4 table overstates this.** Row S10 reads *"All **110** cron routes | IN | §2.3 procedure: every route
bound on the rig"*, and §2.3 says *"Every cron route in code gets a rig Scheduler job for the soak, **including
all 52 currently unscheduled ones**."* **That did not happen.** DEG-1 added exactly two jobs
(`anchor-expiry-sweep`, `anchor-public-records`) and re-timed four to prod cadence. The Day-7 report must carry
FD-13's number, not §4 S10's claim.

**The unbound 84, by family:**

| n | Family | Why unbound |
|---|---|---|
| **42** | Public-record / registry ingestion feeders (`fetch-*` ×38, `edgar-backfill`, `edgar-bulk`, `openalex-bulk`, `embed-public-records`, `regulatory-change-scan`) | Each hits a live external registry. Day-0 probe #26 declined them deliberately: `anchor-public-records` on a populated table converts an unbounded fetch batch into PENDING anchors and contaminates the controlled cohort. Also the 259k pending-anchoring backlog lives here; prod's feeders are paused. |
| **13** | Ops / observability / reporting (`db-health`†, `pipeline-health`, `pipeline-throughput-monitor`, `lock-wait`, `migration-status`, `smoke-test`, `financial-report`, `generate-reports`, `queue-digest`, `queue-reminders`, `calibration-refit`, `professional-education-extraction`, `mainnet-migration`) | Mostly no-ops on a small rig; `queue-digest` needs email channels; `mainnet-migration` must never run on a signet rig. †`db-health` **is** bound (job `db-health-monitor`) — it appears here only because job name ≠ route name. |
| **9** | Connector jobs (`docusign-*` ×6, `drive-*` ×2, `connector-health-check`) | Need real OAuth tenants. Day-0 #8/#18 proved the claim/execute legs; the vendor-fetch leg is structurally unreachable. |
| **8** | Credit / billing / metering (`ai-credit-reconcile`, `credit-expiry`, `monthly-allocation-rollover`, `payment-recovery`, `reconcile-credit-conservation`, `reconcile-stripe`, `report-metered-usage`, `workspace-subscription-renewal`) | §4.1 claims 3 of these were "recovered by binding the unbound credit-cron routes (§2.3)". **None is bound.** `reconcile-credit-conservation` in particular is named in §4 S16's assertion ("cron bound and row-delta asserted") and is not bound. |
| **6** | Expiry / lifecycle (`check-credential-expiry`, `check-attestation-expiry`, `ce-key-expiry-check`, `ce-registry-drift-check`, `cleanup-retention`, `treasury-alert-check`) | `check-credential-expiry` is **FD-2**, a prod-exposed 500 (queries `anchors.not_after` / `anchors.document_title`; neither column exists). The CE jobs need CE credentials. |
| **4** | Proof backfill / coverage (`classify-proof-backcatalog`, `materialize-proof-backcatalog`, `proof-coverage-monitor`, `supplementary-proof-anchor`) | The 2.97M-record proof gap is a founder decision (G8), not a soak item. §9's CC7.1 note says both proof backfills have no prod schedule either. |
| **3** | BigQuery export (`bq-export-backfill`, `bq-export-incremental`, `bq-export-snapshot`) | No BigQuery dataset wired to the rig. |

**Correction to §4.1's arithmetic:** the "+3 recovered by binding the unbound credit-cron routes" credit should
be withdrawn. The floor drops from 301 to 298 of 401 (74.3%).

---

## 2. Bitcoin anchoring on signet — full lifecycle incl. safety loops

**State: SOAKING-CONTINUOUS (lifecycle) · SOAKED-DAY0-PROBE + scheduled (safety loops) · one OPEN blocker.**

**Receipt.** §4 rows S1–S4. BL-2 **CLOSED, PASS** on `00013-mrw` — `manifest-DAY-0.md` §9.2: **12/12 SECURED,
12/12 `anchor_proofs.block_header` at 80 raw bytes**, verified through 15:47:33Z. Confirmed live today:
`anchors=12, SECURED=12, anchor_proofs=12`. Dynamic fee path live (Day-0 probe #22, boot line
`feeEstimator: "Mempool.space"`). Mock detector clean (probe #23: 0 anchors with `chain_block_height > 400000`).

All **5 safety loops are Scheduler-bound** on the rig (`detect-reorgs`, `monitor-stuck-txs`, `rebroadcast-txs`,
`consolidate-utxos`, `monitor-fees` — deg1 evidence §4) and fire continuously. This is the first
operating-effectiveness evidence these controls have ever had; **52 of 105 prod cron routes still have no prod
schedule, including all five** (§9 CC7.1) — the soak proves they *can* operate, prod scheduling is follow-on.

**FD-3 is a parity upgrade, and it changes item 2's answer.** The §4 S1 row marks *"GetBlock broadcast + UTXO
listing (prod's rail)"* as **DECLARED-UNTESTED**. That is now **stale**: the authorised freeze-break to
`00013-mrw` set `BITCOIN_UTXO_PROVIDER=getblock` over the `fullsoak-btc-rpc` VPC connector, so the rig runs
prod's exact hybrid architecture (RPC broadcast + RPC inclusion proofs + mempool.space UTXO/fees).
`fullsoak-daily-check.sh` A17/A17b assert the RPC node VM is RUNNING and within 2 blocks of the public signet
tip. **Update the §4 S1 GetBlock row from DU to IN before Day 7.**

**Still DECLARED-UNTESTED, correctly:** mainnet signing/broadcast (BTC9, by design — the rig must never touch
mainnet); the GCP KMS signing path (no `GCP_KMS_KEY_RESOURCE_NAME`; WIF is the active signer, config-presence
only per DEG-8).

**Mainnet — SUPPLEMENTARY prod observation added 2026-08-12, and it does NOT convert the row above.**
`scripts/staging/fullsoak-prod-mainnet-evidence.sh` (new, read-only on prod) captures, daily, what production's
own mainnet operation looked like during the soak window. First run 17:04Z — **`PROD_MAINNET_EVIDENCE: 10 pass /
0 fail`**; artifact `docs/staging/evidence/fullsoak-2026-08/2026-08-12/prod-mainnet-evidence.md`.

*Measured:* prod `/health` `status=healthy`, `network=mainnet`, `git_sha f5d1070fc…` (identical to the rig's),
`checks {database, anchoring, kms} = ok`; **6,553 anchors created in prod in the last 24 h, 6,553 of them
SECURED**; latest mainnet txid `69b0b0d193cf132f15edceea513d2e5dbf2646bc5b6f47660b0d39307ee95dab` at block
**962,153** (network observed time 2026-08-12T14:15:50Z, anchor `ARK-FED-T8CCPC`); and that txid independently
confirmed by **two** mainnet explorers — mempool.space and blockstream.info — both resolving it to block 962,153,
matching the Arkova database. Neither explorer shares infrastructure with Arkova and neither was told what height
to expect. The height also defeats the mock detector by construction (MockChainClient seeds 800,000).

*NOT asserted, and no reading in that artifact may be presented as it:* that the **rig** tested mainnet. It did
not and must not. The artifact carries its own counter-assertion (M10): the rig holds **zero** anchors above
height 850,000. Mainnet signing and broadcast remain DECLARED-UNTESTED for this soak. Also not asserted: that
prod is under test — prod is change-frozen for the window and every access in that script is a SELECT or a
public GET; and that prod's volume and the rig's controlled cohort are comparable.

**OPEN, blocking, prod-exposed — FD-4.** A hung `check-confirmations` run deadlocks SUBMITTED→SECURED promotion
fleet-wide: `startRunLeaseHeartbeat` renews forever so the TTL never expires, `withRunLease`'s in-process
`inFlight` guard short-circuits before the lease check, and every call returns HTTP 200 `{"checked":0,
"confirmed":0}` with no warn/error log. 31 forced invocations over 29 minutes, silent. **Prod runs `minScale=2`
and is exposed identically.** FD-6 is its blindfold: a lease-blocked run is indistinguishable from an empty one.

---

## 3. Login (Supabase auth, frontend session flows)

**State: DAILY-E2E + now DAILY-PROBE.**

**Receipt.** §4 S6 ("Auth: signup, login, activation, invite, password reset | IN | Daily Playwright E2E").
Specs: `e2e/auth.spec.ts` (login form, Google OAuth button, signup stops at email confirmation, password
mismatch/length validation, sign-out redirect), `e2e/route-guards.spec.ts` (unauthenticated redirects for
`/records`, `/vault`, `/dashboard`, `/onboarding/role`, `/profile`), `e2e/auth.setup.ts` (storageState).

**Gap closed.** The §4 row says "daily Playwright E2E" but **nothing schedules it** — there is no cron, launchd
entry, or CI trigger that runs the 46-spec suite against the rig on a daily cadence, and the CI e2e job is
path-gated (`ci.yml` `e2e-changed`) so it skips and reports green on doc-only changes. Until a scheduler exists,
"daily E2E" is a plan. **P1** now proves the server-side leg unconditionally each run: both orgs mint real JWTs
from `POST /auth/v1/token?grant_type=password`, and a wrong password is refused (http 400). That is also the
**precondition** the whole cross-tenant control depends on (item 14).

---

## 4. Document upload + anchoring for the HakiChain document types

**State: SOAKING-CONTINUOUS (anchoring path) · **NO TYPE MATRIX EXISTS TO MAP** (the contract's placeholder was never filled).**

**Receipt — what the executed agreement actually enumerates.** The HakiChain LOI (DocuSign `5BE7302F`, signed
2026-07-15) Exhibit A enumerates **22 FILE FORMATS, not document types**, transcribed verbatim at
`src/components/anchor/FileUpload.test.tsx:232–239`: PDF, .doc/.docx, .odt, RTF, plain text, HTML, XML, JSON,
.xls/.xlsx, .ods, CSV, .ppt/.pptx, .odp, EPUB, Markdown, PNG, JPEG, TIFF, GIF, WebP, SVG, HEIF/HEIC. All 22
fingerprint and anchor (no `accept` allowlist); **extraction is 20/22** — legacy binary CFB `.doc`/`.ppt` have
no extractor anywhere; `.csv/.xlsx/.xls` are paused on the row-mode-vs-document-mode decision
(`docs/staging/sprint-2026-07-28-plan-of-record.md:82`).

**`[PRIORITY DOCUMENT TYPES]` is still an unfilled literal placeholder** in both the LOI and the Pilot Success
Criteria doc — `docs/lane3/s33-hakichain-packet-readiness.md:33`. **There is no contractual document-type matrix
to map probes against.** Anything presented as one would be invented.

**What does exist, and must not be mistaken for the contract:** an 11-row Kenya-first candidate matrix in
`docs/lane4/s33-wave1-entry-datasheet.json` (`GD-S33-KE-001..011`), each row carrying `priorityDocumentType` →
`credentialType`/`subType` — Nursing Council registration → `LICENSE/nursing_rn`; KMPDC practising licence →
`LICENSE/medical_md`; LSK advocate certificate → `LICENSE/law_bar_admission`; TSC registration →
`LICENSE/teaching`; EBK registration → `LICENSE/engineering_pe`; KRA PIN → `IDENTITY/government_id`; KRA Tax
Compliance Certificate → `ATTESTATION/good_standing`; BRS incorporation certificate → `BUSINESS_ENTITY/
corporation`; DCI police clearance → `ATTESTATION/good_standing`; KNEC KCSE → `CERTIFICATE/completion_
certificate`; Kenyan degree + KNQA equation → `DEGREE/bachelor`. Its own status field reads
`PRODUCER_R12_CANDIDATE_PENDING_L3_FORMAL_ACCEPTANCE`, and the packet doc says explicitly it "must not be pasted
into the LOI or Exhibit A as final language." Two of its subtypes (`government_id`, `good_standing`) are **not**
in `CREDENTIAL_SUB_TYPES` (`src/lib/validators.ts`) — they are corpus labels, not runtime-validated values.

**The product taxonomy is `credential_type`: 27 enum labels** (baseline `:206–232` + `0315` adding `CPE`),
`src/lib/validators.ts:46–74`. `document_type` is **free text** (`z.string().max(100).optional()`), no enum, no
CHECK. So "map each type to a probe" resolves to: 27 credential types, 22 file formats, zero contractual
document types.

**Coverage today.** The upload→fingerprint→anchor path is exercised continuously (12/12 SECURED with real signet
txids) and by `e2e/anchor-creation.spec.ts`, `e2e/secure-document.spec.ts`, `e2e/csv-upload.spec.ts`,
`e2e/template-review.spec.ts` (which asserts **no raw document content on the wire** — the §1.6 client-side
boundary). The **22-format matrix run is the KPI-2/F6 evidence artifact** and is not part of the daily probe
set; it is a one-shot to schedule inside the window.

**Do not tell the partner a type matrix was soaked.** Fill the placeholder first (founder lever, §Levers).

---

## 5. Queue — org-queue, job_queue, batch drain

**State: SOAKING-CONTINUOUS · DEG-5 fixed behaviourally on this revision.**

**Receipt.** §4 rows S11 (`org-queue-scheduler`), S10 (job queue: every job type, retry/backoff, `last_error`,
lease CAS), S3 (batch anchoring: Trigger A / Trigger B / forced flush).

- **org-queue-scheduler** — Day-0 probe #21: `organization_queue_runs` 0 → 2, trigger `scheduled`, status
  **`succeeded`**, real batch txids `eb28b03a…` (org A) / `d73a3f0b…` (org B). DEG-5 (INTERNAL/13 every 5 min,
  zero rows ever written) is **fixed on this revision**. Root cause is FD-15: Zod 4 strict `uuid()` on
  DB-sourced ids — one bad row DoSes a whole job pass, and **57 call sites share the pattern**. The rig side was
  fixed data-only (image untouched); **the validator-side defect is open** (PR #2215 held for the window).
- **job_queue** — Day-0 probes #8/#9: claim → attempt → `failed` with a bounded `last_error`
  (`docusign_integration_missing_base_uri`, no payload bytes — §1.6A clean), then a full drain to `anchored`
  with anchor + credit deltas.
- **batch drain** — `batch-anchors` `*/30`, forced flush `0 3 * * *` (prod parity, DEG-1). Dead-man's switch
  asserted daily by `fullsoak-daily-check.sh` **A16a** (`checks.anchoring.drainStalled == false`), with A16b/c
  (`lastSecuredAt` present and advancing) and A16d (`feeRateSatVb` non-null).

**Weakness worth naming:** FD-5 — PENDING anchors cannot persist on this rig while an org is org-queue-due; the
scheduled pass force-flushed the first cohort within ~107 s. Any observed-forced-flush test must run in the
window between org-due passes.

---

## 6. Inviting members

**State: was RENDER-LEVEL ONLY → now DAILY-PROBE (P3).**

**Receipt of the gap.** `e2e/member-invite.spec.ts` has 8 tests and **every one stops at the modal**: button
visible, modal opens, Send disabled on empty email, invalid-email validation, Send enables, Admin role
selectable, Cancel closes, form resets. **No test sends an invitation**, and `/accept-invite`
(`ROUTES.ACCEPT_INVITE`) has **zero e2e coverage**. Live confirmation: `invitations` had **0 rows** on the rig at
Day 0 — the flow had never executed there.

**Wired (P3), executed today:**

| Assertion | Result |
|---|---|
| `invite_member` as ORG_ADMIN writes an `invitations` row (count delta, not a 200) | PASS — http 200, 0 → 1 |
| `invite_member` refuses to mint an `ORG_ADMIN` (SEC-RECON-8 escalation block) | PASS — http 403 |
| Org B admin cannot invite into Org A | PASS — http 403 |
| `GET /api/invitations/:token` previews the invite (public, token is the credential) | PASS — http 200, `org=Arkova` |

**Deliberately not probed:** `POST /api/send-invitation-email` sends real mail through Resend. Wiring it needs an
operator-chosen sink address, not a default daily probe. `POST /api/invitations/accept` and the separate
recipient-activation flow (`POST /api/recipients` → `GET /api/activation/:token` →
`POST /api/activation/complete`, hardened by `0401`/`0402`) create real auth users; they remain
**DECLARED-UNTESTED** pending an operator decision on disposable accounts.

---

## 7. DocuSign — webhook vs OAuth split

**State: webhook SOAKED-DAY0-PROBE + now DAILY-PROBE (P9) · OAuth DECLARED-UNTESTED (no tenant).**

**Webhook leg — proven.** Day-0 probes #6/#7/#8: forged HMAC → **401 `invalid_signature` with nonce delta 0**
(the zero is the assertion); valid HMAC-SHA256-base64 over the raw body → 202, `docusign_webhook_nonces` +1,
`organization_rule_events` +1 (`ESIGN_COMPLETED`), `job_queue` +1. **Route is `/webhooks/docusign`, not
`/api/v1/webhooks/docusign`** (FD-16 corrects the flag-seed plan). P9a re-proves the rejection leg daily
(today: http 401, nonces 1 → 1). The accept leg is not re-run daily — it would write a nonce row every day for
no added assertion.

**OAuth leg — DECLARED-UNTESTED, and it cannot be turned on.** `ENABLE_DOCUSIGN_OAUTH` is an **env-direct
module-load kill switch read once at boot**, plus production Zod boot guards. Setting it true **crashes the
worker at boot** without `DOCUSIGN_INTEGRATION_KEY` + `DOCUSIGN_CLIENT_SECRET` (`config.ts:678-696`) +
`INTEGRATION_STATE_HMAC_SECRET`. On a live soak that is a clock-voiding restart. Flag matrix rationale: "no
third-party credentials on rig."

**The vendor-fetch leg is structurally unreachable**, and Day-0 said so honestly: probe #8 is **PARTIAL** —
`ENABLE_CONNECTOR_ARTIFACT_ENQUEUE` sits *after* the vendor fetch, which needs a real tenant. The drain was
proven instead by inserting a fixture artifact through the **production RPC** `enqueue_connector_artifact`
(probe #9), which drained to anchor `ARK-DOC-S3DQE5` with a real signet txid. That is an honest stand-in, not a
connector end-to-end.

E2E coverage of the UI is the repo's heaviest: `e2e/integrations-docusign.spec.ts` (14 tests incl. mocked OAuth
happy path, disconnect, callback/worker/Supabase error states, mobile, non-admin, notarization badge) and
`e2e/integrations-docusign-member.spec.ts` (7). All use **mocked** OAuth.

---

## 8. SDK / MCP / API / Webhooks surfaces

**State: mixed — API v1/v2 IN, MCP IN (live-edge, not head-pinned), SDKs IN (from published artifacts), webhooks IN.**

| Surface | State | Receipt |
|---|---|---|
| Public API v1 — 75 modules | IN | §4 S14. Per-module smoke + ≥1 auth-negative per authenticated module; hourly availability + p95. Verified live today: scope enforcement holds (P7c — a `verify`-only key gets 403 on `/api/v1/anchor`). |
| Public API v2 — 12 modules | IN | §4 S14 + the `mcpParity` spec green against the rig. v2 exposes no anchor-creating route. |
| `/api/v1/verify/{id}` | IN | §4 S14; Day-0 #5 (`audit_events(VERIFICATION_QUERIED)` +1). **FD-16:** the route takes `:publicId`, not a fingerprint, and writes `audit_events`, not `verification_events`. |
| `/.well-known/arkova-keys.json` | IN — **currently 404** | §4 S17. `proof-keys.ts` is never imported. Recorded as a reachability FINDING; must never be converted to a pass by softening the assertion. |
| MCP — 16 edge tools | IN (live deployment) | §4 S12/S25. **Honesty note stands:** the edge Worker is a separate `wrangler` target and **nothing in this soak pins it to a head SHA**. Evidence describes the live edge at probe time. |
| SDKs — see the corrected block below | **CORRECTED 2026-08-12** | §4 S13's "installed from the registry" is **not satisfiable for the npm packages: none of the three is published.** Live census + a live-API smoke now run daily — `scripts/staging/fullsoak-sdk-integration.sh`. |
| The "never-published JS SDK" | **RESOLVED — it is all three of them** | §4.3 item 5 said the package "is not identifiable from the repo tree". It is now identified by measurement, not inference: `@carsonarkova/sdk`, `@arkova/mcp-server` and `@arkova/langchain` all return **HTTP 404** from the npm registry, and an npm text search for `arkova` returns **zero packages**. |
| Inbound webhooks ×8 | IN | §4 S15. DocuSign + Drive rejection legs now daily (P9). Middesk is signature-rejection-only (provider inert in prod). ATS / Veremark / Microsoft-Graph are **OFF and un-turn-on-able** (see item 9). |
| Outbound webhook delivery + retries | IN | Day-0 #16: endpoint created via real API, 3 real HMAC-signed deliveries logged (2 failed on a flaky sink + 1 success). Endpoint `e9b82469` left ACTIVE so soak-week lifecycle events accrue. **Registrable event types are anchor/credential lifecycle only** — `compliance.document_expiring` is rejected by the create schema, which is half of FD-2. |
| Rate limiting as prod runs it (Upstash) | DU | §4 S14. The rig's in-memory limiter **is** asserted and is demonstrably live: P10 hit http 429 twice today under ordinary probe load. |

### SDK live-API integration — wired 2026-08-12, and it corrects this row

**Can the SDK test suites be pointed at a base URL + API key? No.** All three TypeScript suites stub the
transport and say so in their own headers — `packages/sdk/src/client.test.ts:13` is literally
`vi.stubGlobal('fetch', mockFetch)` under *"Tests SDK methods with mocked fetch. No real API calls."* There is
no env var, no integration mode and no conditional live path in `packages/sdk`, `sdks/mcp-server` or
`sdks/langchain-ts`. Pointing `npm test` at the rig would exercise the mock and report green whether or not the
rig existed. So the suites were **not** run against the rig; `scripts/staging/fullsoak-sdk-integration.sh`
exercises each SDK's **public surface** against it instead, which is the assertion the suites cannot make.

First run 2026-08-12T17:09Z — **`SDK_INTEGRATION: 22 pass / 7 fail`**. Artifact:
`docs/staging/evidence/fullsoak-2026-08/2026-08-12/sdk-integration.md`.

| Registry census (live) | result |
|---|---|
| `@carsonarkova/sdk` (npm) | **HTTP 404 — not published**, despite `.github/workflows/publish-sdk.yml` existing for it |
| `@arkova/mcp-server` (npm) | **HTTP 404 — not published**, and no publish workflow exists |
| `@arkova/langchain` (npm) | **HTTP 404 — not published**, and no publish workflow exists |
| `arkova` (PyPI) | **200 — published, v2.2.0**, matching `packages/arkova-py` |

**SDK-1 (new, prod-exposed, customer-facing).** `arkova` 2.2.0 — the **only** published Arkova SDK — **cannot
verify a real production record.** Its `VerificationResult` model types `compliance_controls` as a dict; the
live `/api/v1/verify/{id}` returns a **list**. Reproduced against prod, not just the rig: prod record
`ARK-2026-C3A718D0` (`credential_type=LEGAL`) returns `compliance_controls: ['SOC2-CC6.1', 'SOC2-CC6.7',
'GDPR-5.1f', …]` and the published model raises `Input should be a valid dictionary`. `verify()` is the SDK's
headline method. The model *does* set `extra='allow'`, so the newer `proof_availability` /
`proof_availability_note` / `compliance_controls_note` fields are tolerated — the break is a **type** mismatch
on a pre-existing field, which is precisely the compatibility §1.8 promises ("additive nullable fields are
allowed without versioning") being defeated by a client that cannot absorb them. Records whose
`compliance_controls` is null parse fine, which is why this was never noticed.

**SDK-2 (new, and it belongs in the claims register).** **Nessie does not fail closed.**
`GET /api/v1/nessie/query` is mounted **unconditionally** in `services/worker/src/api/v1/router.ts:542` — there
is no `ENABLE_NESSIE_RAG_RECOMMENDATIONS` check on the route, and the flag is not even a row in the rig's
`switchboard_flags`. Through the SDK (`Arkova.query()`) it answers **HTTP 200** with
`{"results":[],"count":0}`; through the MCP tool (`nessie_ask`) it answers with a synthesized
`{"answer":"No relevant verified documents were found for your query.","citations":[],"confidence":0}`.
Item 9 records the founder directive as *"the daily assertion is that it fails closed"* — **it does not**. A
paying integrator cannot distinguish "permanently disabled by directive" from "no matching records", and
`/nessie/query` is a **priced** offer on `/developers` (claims-register rows 2 and 4). This strengthens the
retraction case from "the capability does not function" to "the capability returns a success shape while off".

**Not a defect, but it will cost an integrator an afternoon:** the two SDKs do not share a `base_url` contract.
The TS client takes a bare origin and builds `/api/v1|v2/…` itself; the Python client's `DEFAULT_BASE_URL` is
`https://api.arkova.ai/v2`, its v1 methods rewrite that trailing version segment, and `search` / `get_record` /
`list_orgs` / `get_organization` / `get_fingerprint` / `get_document` send **bare** paths relative to it. Hand
the Python client a bare origin and every v2 read method 404s with the worker's generic *"The requested endpoint
does not exist"*, which reads exactly like a broken SDK. The script pins the correct value per SDK rather than
reporting the mismatch as four false findings.

**What the smoke does not do:** it exercises no SDK write method for effect. `anchor()` appears once per SDK as
a scope-negative assertion (a verify-scoped key must be refused — it is, in both). The BL-2 cohort is untouched.
The API key is the Day-0 `soak-public-api` key from Secret Manager, reused rather than re-minted daily, because
**FD-P7** makes every minted key permanent litter on the rig; `--mint` exists for when a fresh one is wanted.

---

## 9. Feature flags — the 31 OFF rationale

**State: all 66 rows decided; 34 ON, 31 OFF, 1 unset-by-choice. Every OFF row carries a written rationale.**
Source: `docs/staging/fullsoak-2026-08/flag-decision-matrix.csv` (`decision`, `off_rationale`, `call_site`).
Rig `switchboard_flags` = 25 rows (prod 24), hash-pinned daily by `fullsoak-daily-check.sh` **A11**.

**Convertible by the founder — credentials or a decision unlock real coverage (12):**

| Flag | What it needs |
|---|---|
| `ENABLE_DOCUSIGN_OAUTH` | DocuSign **sandbox tenant**: `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_CLIENT_SECRET`, `INTEGRATION_STATE_HMAC_SECRET` |
| `ENABLE_DRIVE_OAUTH` | Google OAuth test app: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `INTEGRATION_STATE_HMAC_SECRET` |
| `ENABLE_GRC_INTEGRATIONS` | Vanta/Drata OAuth + `GCP_KMS_INTEGRATION_TOKEN_KEY` |
| `ENABLE_ATS_WEBHOOK` | ATS vendor secrets (note: the kill switch guards a known multi-secret tenant-isolation finding — fix first) |
| `ENABLE_VEREMARK_WEBHOOK` | `VEREMARK_WEBHOOK_SECRET` |
| `ENABLE_MICROSOFT_GRAPH_WEBHOOK` | `MICROSOFT_GRAPH_CLIENT_STATE` |
| `ENABLE_CE_REGISTRY_DRIFT_CHECK` | Credential Engine registry credentials |
| `ENABLE_CE_KEY_EXPIRY_ALERTS` | `CE_API_KEY_EXPIRES_AT` (a date, not a secret) — trial expires ~2026-09-09 |
| `ARIZE_TRACING_ENABLED` | Arize `ARIZE_API_KEY` + `ARIZE_SPACE_ID` |
| `ENABLE_AI_FALLBACK` | Cloudflare AI credentials |
| `ENABLE_VERTEX_AI` | Vertex SA + quota (S3.3 ruling: the tuned endpoint does not cut 429s — low value) |
| `ENABLE_ALLOCATION_ROLLOVER` | A decision. **Divergent flag:** `config.ts` defaults false but the job reads raw `process.env !== 'false'`, so *unset* means the job is enabled if the route is ever forced. Pinned off explicitly. |

**Cannot convert regardless (11):** `ENABLE_NESSIE_RAG_RECOMMENDATIONS` and `ENABLE_CONSTRAINED_DECODING`
(founder directive 2026-08-01 — Nessie stays off, permanently); `USE_MOCKS` (MockChainClient fabricates txids
matching `^[0-9a-f]{64}$` and seeds `mockBlockHeight=800000` — any leak false-greens the entire chain leg);
`ENABLE_DEMO_INJECTOR` and `ENABLE_SYNTHETIC_DATA` (fabricate soak data; prod Zod guards reject them anyway);
`MAINTENANCE_MODE` (blanks the very flows the soak measures); `ENABLE_COMPLIANCE_ENGINE` and `ENABLE_ZK_PROOFS`
(**dead flags — zero call sites repo-wide**; turning them on would be a false-green, there is nothing to
unblock); `ENABLE_VISUAL_FRAUD_DETECTION` (endpoint returns 410 unconditionally, pending SCRUM-1955);
`ENABLE_MULTIMODAL_EMBEDDINGS` (GEMB2 golden-state constraint); `ENABLE_PROD_NETWORK_ANCHORING` at mainnet
scope (signet by design).

**Judgement calls, neither of the above (8):** `ENABLE_QUEUE_DIGEST`, `ENABLE_CREDENTIAL_VERIFIED_WEBHOOK`,
`ENABLE_CLOUD_LOGGING_SINK`, `ENABLE_ORG_SUSPENSION_GUARD`, `ENABLE_DRIVE_LEGACY_CHANNEL_TOKEN_REJECTION`,
`ENABLE_DOCUSIGN_QUEUE_RECONCILIATION`, `DISABLE_IN_PROCESS_ANCHOR_CRON`,
`ENABLE_PROFESSIONAL_EDUCATION_SCHEMA_READY` — all off for **prod parity**. Turning them on would test behaviour
prod does not run, which is the opposite of what the evidence needs to describe.

**`ENABLE_ADES_SIGNATURES` is the one that looks convertible and is not:** it defaults to `ADES_KMS_PROVIDER=
aws_kms` and **no AWS account exists**, by standing directive (`memory/feedback_no_aws.md`). It ships in two
published npm SDKs, so a false claim needs a corrective release (claims register row 9). Converting it means
reversing the no-AWS directive **or** re-pointing the engine at GCP KMS — an engineering change, not a credential.

**One flag deserves the founder's eye separately:** `ENABLE_ORG_CREDIT_ENFORCEMENT` is ON on the rig and proven
(Day-0 #10: 7 → 14 deductions). Its **production semantics are broken** (#2050 — it gates on balance while
ignoring `anchor_quota`), so enabling it in prod would **402 HakiChain immediately**. §4 S22 correctly marks
prod semantics DU.

---

## 10. DPA features (0403 / 0404 / 0405)

**State: was NOT-IN-TABLE → now DAILY-PROBE (P5). No behavioural probe existed before this audit.**

**Receipt of the gap.** These three migrations do not appear anywhere in §4's coverage table — not as IN, not as
DU. They were silent, which §4's own rule ("zero features in neither state") forbids. No e2e spec touches them:
grep for `field_not_permitted`, `organization_field_policies`, `querying_ip`, `anonymize_user_data` across
`e2e/**` returns nothing. The only 0405 test is **static** — `src/tests/sec-0405-org-field-policy-independence.
test.ts` regex-asserts the `.sql` file text, never a live database.

**What each is:**
- **0403** — rewrites `anonymize_user_data(uuid)`; removes an `UPDATE verification_events` referencing two
  columns that do not exist, which raised 42703 and **aborted the entire GDPR erasure transaction**. Runtime
  path: `DELETE /api/account` (JWT) → `services/worker/src/api/account-delete.ts:54`.
- **0404** — one-shot redaction of raw `querying_ip` out of historical `audit_events` (writers now emit
  `querying_ip_hash` only: `api/v1/verify.ts:584`, `api/v1/credentials-ctdl.ts:83`), plus a corrected column
  comment on the vestigial `verification_events.ip_hash`.
- **0405** — creates `organization_field_policies` (DPA clause 4.6), read by `enforceOrgFieldPolicy` at **8
  worker call sites** (`anchor-submit`, `anchor-bulk`, `anchor-bulk-self-service`, `contracts/anchor-pre-signing`,
  `cle-verify`, `credentials-ctdl-registry-anchor`, `credential-sources`, `version-resolution`), guarded by the CI
  invariant `scripts/ci/check-anchor-field-policy-coverage.ts`. **Inert: 0 rows on rig and prod.**

**Wired (P5), executed today — the strongest probe available without a service-role write:**

| Assertion | Result |
|---|---|
| anon cannot read `organization_field_policies` | PASS — http 401 |
| **ORG_ADMIN cannot INSERT its own field policy** (the regulated party cannot disarm its own control) | PASS — http 403 |
| ORG_ADMIN cannot UPDATE a policy row | PASS — http 403, 0 rows |
| Enforcement armed? (dated row count) | SKIP — **0 rows: inert; the 400 `field_not_permitted` path is NOT exercised** |

The probe's INSERT payload is deliberately doubly inert (`enabled:false`, `disallowed_fields:[]`) so that if the
write-lock were broken — a P0 — the probe still could not arm a DPA control on a live soak rig.

**Remains DECLARED-UNTESTED:** the positive enforcement path (policy row → 400 `field_not_permitted`). There is
**no HTTP surface of any kind** to create a policy row — no `authenticated` grant, no INSERT/UPDATE/DELETE
policy, no admin route, no UI. Arming it is a deliberate service-role INSERT (RTE lever, §Levers).
**0404's read side is also unobservable:** the `querying_ip_hash` rows carry `actor_id = NULL` and
`audit_events_select` is `USING (actor_id = auth.uid())`, so no JWT can read them back. **0403 is exercisable
but destructive** — `DELETE /api/account` is the only runtime path and it deletes an auth user; it needs a
disposable account, so it stays DU by default.

**Inferred, not measured, and worth one query during the window:** `delete_own_account()` is SECURITY DEFINER
granted to `anon` and `authenticated` and calls `anonymize_user_data()`, which guards on `auth.role() !=
'service_role'`. SECURITY DEFINER changes the Postgres role but not the `request.jwt.claims` GUC that
`auth.role()` reads, so a direct `POST /rest/v1/rpc/delete_own_account` from a JWT should raise
`insufficient_privilege`. Nothing in the test suite covers that path.

---

## 11. QR codes

**State: DAILY-E2E (thin) → now DAILY-PROBE for the target path (P6).**

**Receipt.** Generation is **client-side only** — `qrcode.react@4.2.0`, rendered in
`src/components/anchor/ShareSheet.tsx:107-111` and `src/components/anchor/AssetDetailView.tsx:884-887` (gated
`publicId && status === 'SECURED'`, with SVG→canvas PNG download at `:900-911`). **There is no server endpoint
in the QR path at all.**

**The encoded value** is `verifyUrl(publicId)` = `${getAppBaseUrl()}/verify/${publicId}`
(`src/lib/routes.ts:186-194`; `ROUTES.VERIFY = '/verify/:publicId'`). That page's **only** data call is the anon
Supabase RPC `get_public_anchor(p_public_id)` (`src/components/verification/PublicVerification.tsx:170-173`) —
not a worker endpoint.

**Existing e2e is visibility-only:** `e2e/record-detail.spec.ts` asserts the text "Verification QR Code" is
present for SECURED and absent for PENDING. **Nothing decodes the QR or checks its target resolves.**

**Wired (P6), executed today:** the anon scan path resolves — `get_public_anchor('ARK-2026-9476A947')` → http
200 with matching `public_id`, **with no credential of any kind**; and an unknown id returns a *distinct
not-found payload* (`{"error":"Record not found"}`, no `public_id`), never a record and never a 5xx. This is the
assertion `e2e/public-proof-gate.spec.ts` covers in the browser, now proven at the data layer daily.

---

## 12. Drive integration

**State: webhook SOAKED-DAY0-PROBE + now DAILY-PROBE (P9b) · changes-runner PARTIAL · OAuth/vendor-fetch DECLARED-UNTESTED.**

**Receipt.** §4 S7/S8. Day-0 probe #17: forged channel token → **401 `invalid_channel_token`, nonce delta 0**;
valid token → 200, `drive_webhook_nonces` +1. **FD-16 correction:** channel state lives in
`org_integrations.subscription_id` + a token in `account_label` JSON — **there is no `drive_watch_state` table**.
Probe #18 (changes runner) is **PARTIAL by declaration**: the runner entered and gracefully skipped
(`drive runner: integration has no last_page_token — skipping`); the `changes.list` vendor leg needs real Google
OAuth and a page token.

**P9b caught a probe-design error worth recording as method.** The first version addressed a *made-up* channel
id and got http 200 — which reads as "forged token accepted" but is a different code branch entirely (an
unknown channel has nothing to resolve). Rewritten to address the **known** rig channel with a wrong token:
http 401. *An unknown-identifier probe cannot test an identifier-mismatch control.*

**OAuth is un-turn-on-able for the same reason as DocuSign:** `ENABLE_DRIVE_OAUTH` is an env-direct module-load
kill switch; setting it true **crashes boot** without `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`
(`config.ts:625`) + `INTEGRATION_STATE_HMAC_SECRET`.

**Asymmetry to flag:** `e2e/integrations-drive.spec.ts` contains **one test** (org admin completes the mocked
OAuth happy path) against DocuSign's 21. No disconnect, no error states, no mobile, no non-admin case.

---

## 13. Folders (SCRUM-2940 UI + anchor filing)

**State: was ZERO COVERAGE → now DAILY-PROBE (P4).**

**Receipt of the gap.** Zero matches for "folder" anywhere in `e2e/` — the feature is a full CRUD + filter
surface (`src/pages/MyRecordsPage.tsx` importing `useFolders`, `FolderSidebar`, `FolderFormDialog`,
`DeleteFolderDialog`, `MoveToFolderDialog`) with **no e2e spec at all**. Live confirmation: `folders` had **0
rows** on the rig at Day 0. Not in §4's table either.

**Shape.** Migrations `0365` (table + `anchors.folder_id` FK `ON DELETE SET NULL` + `enforce_anchor_folder_
owner_scope` trigger), `0366` (index), `0393` (`anchors_update_org_admin` + `trg_restrict_org_admin_folder_
update` — an org admin may change **only** `folder_id` on a teammate's row). **No worker route exists**; the
browser talks to PostgREST directly via `src/hooks/useFolders.ts`.

**Wired (P4), executed today — all PASS:**

| Assertion | Result |
|---|---|
| ORG_ADMIN JWT creates a folder | PASS — http 201 |
| Rename returns the updated row (not a silent 0-row PATCH) | PASS — 1 row |
| **Anchor filed into folder, proven by row count** (`select=id` returning ≥1) | PASS — 1 row |
| Org B JWT cannot re-file an Org A anchor | PASS — 0 rows |
| Folder delete releases filed anchors (`ON DELETE SET NULL`) | PASS — 0 orphans |

The row-count assertion is deliberate and is the founder-priority bug `0393` fixes: an RLS-blocked UPDATE
returns `{error: null}` with **zero rows**, so error-only checking showed a "Record moved" toast while
`folder_id` never changed (`useFolders.ts:143-151`). A status-code assertion here would be a hollow pass.

**Probe-design note:** the first run failed 403 `42501` because `folders_insert_own` requires `created_by =
auth.uid()`. Fixed by decoding the JWT's own `sub` rather than hardcoding a seed uuid — a hardcoded id would
make the probe pass for a user it never authenticated as.

---

## 14. Security features

**State: mixed. RLS + cross-tenant now DAILY-PROBE; trigger guards partial; the 258-RPC deny sweep was PLANNED ONLY and is now WIRED.**

### 14a. The anon-RPC deny sweep — it was **not** wired, and now it is

**Receipt of the gap.** §4 S26 marks the sweep "IN (grouped)" with a "Scripted sweep on the rig … result diffed
against the Day-0 baseline daily." **No such script existed.** Searching `scripts/**` for a deny sweep,
`has_function_privilege`, or an anon-RPC enumerator returns only *per-migration* revoke tests under `src/tests/`
(`sec-0406-…`, `sec-0408-…`, `sec-0388-…`, `sec-recon-unguarded-rpc-family-revokes`) which run in CI against a
local database, not the rig, and not daily. `fullsoak-daily-check.sh` has no assertion in this area.

**Measured live today (both projects, read-only SQL):**

| | Rig `gnkuaywlpmsaezwvlvhk` | Prod `vzwyaatejekddvltxyye` |
|---|---|---|
| `public` functions | 370 | 370 |
| **anon-EXECUTABLE** | **282** | **262** |
| non-internal triggers | 68 | 62 |
| tables / RLS / FORCE RLS | 115 / 115 / 115 | 115 / 115 |

The checklist's "258" is a prior prod measurement; prod is **262** today, and the rig is **282**.

**The finding this produced — a rebuild-provenance gap, not a prod exposure.** The rig's anon set is a strict
**superset** of prod's: **20 functions are anon-EXECUTABLE on the rig and REVOKED in prod**, and **zero** go the
other way (verified per-function). All 20 are `SECURITY DEFINER`:

```
admin_change_user_role  admin_set_platform_admin  admin_set_user_org  anonymize_user_data
can_export_user_data  cleanup_expired_data  get_agents_for_user  get_anchor_lineage
get_pipeline_stats  get_user_monthly_anchor_count  refresh_cache_anchor_status_counts
refresh_cache_anchor_type_counts  refresh_cache_by_source  refresh_cache_pipeline_stats
refresh_cache_record_types  refresh_pipeline_dashboard_cache  release_advisory_lock
set_webhook_delivery_log_public_id  set_webhook_endpoint_public_id  try_advisory_lock
```

**Root cause.** The squashed baseline `00000000000000_baseline_at_main_HEAD.sql` emits only
`REVOKE ALL … FROM PUBLIC` for these functions. The explicit `REVOKE … FROM anon, authenticated` statements live
in `docs/migrations-archive/` (`0062`, `0061`, `0160`, `0170`, `0179`) — **archived, therefore never replayed
into a fresh environment.** Because Supabase grants `anon`/`authenticated` directly at CREATE, revoking PUBLIC
does not revoke them. **Prod is clean. Any environment rebuilt from `supabase/migrations/` is not** — a new
staging rig, a local dev stack, or a disaster-recovery restore comes up with `admin_set_platform_admin`
anon-callable. That is a CC6.1 / DR finding in its own right, and it means **a deny sweep run on the rig cannot
certify prod's deny posture.** The census leg is the only leg that can speak about prod, because prod is
change-frozen and must not be probed with traffic.

**Wired (P8), executed today — all PASS:**

| Assertion | Result |
|---|---|
| Rig anon-executable count has not grown | PASS — 282 ≤ 282 |
| **Prod** anon-executable count has not grown (change freeze) | PASS — 262 ≤ 262 |
| Rig-only anon grants (prod-revoked) have not grown | PASS — 20 ≤ 20, set captured to artifact |
| No function is anon-executable in prod but not on the rig (sweep blind spot) | PASS — 0 |
| Live anon invocation sweep | PASS — swept 26, denied 4, grant-reachable 22, **executed-to-success 0** |

**Safety design, stated plainly.** The sweep never invokes a zero-argument or known-mutating function — those
are census-only, listed in `NEVER_INVOKE`. Argument-taking functions are called with a **type-invalid argument**,
so the cast fails before the function body runs: `permission denied` proves the deny, `invalid input syntax`
proves the grant is live and reachable, and **any 2xx is an immediate FAIL**. Running `admin_set_platform_admin`
for real to "prove" it is callable would be the exact fabrication the soak exists to prevent.
Per-run artifacts: `anon-rpc-rig-only-<stamp>.txt`, `anon-rpc-prod-only-<stamp>.txt`.

### 14b. The rest of the security surface

| Control | State | Receipt |
|---|---|---|
| RLS + FORCE RLS on every table | SOAKING-CONTINUOUS | 115/115/115 measured today on both projects |
| Cross-tenant isolation, 4 planes | **DAILY-PROBE (P2)** — the §4 "daily" promise now has an instrument | Org B positive access proven first (5 own rows), then 0 rows on Org A anchors, folders, and API keys. Plus P3c and P4d as write-side isolation |
| API-key HMAC-SHA256 + scopes | SOAKING-CONTINUOUS + DAILY-PROBE | §1.4; P7c today (verify-only key → 403 on `/api/v1/anchor`) |
| Webhook HMAC | DAILY-PROBE (P9) | DocuSign forged → 401 + nonce delta 0; Drive forged token on a known channel → 401 |
| Security-critical DB triggers (~10) | IN | §4 S26 negative-test fixtures |
| Remaining ~58 of 68 triggers | DU | §4 S26 — exercised incidentally, no per-trigger assertion. **Note the count: 68 on the rig, 62 in prod** (the +6 are the Gate-0 anti-reseed triggers); §4's "76" is stale |
| Storage RLS — read plane | IN (read-only) | §4 S26 anon-deny probes against prod |
| Storage RLS — write plane, buckets | DU | Prod-only; prod is change-frozen. Bucket inventory unrecoverable from the repo (§4.3) |
| Prod service-account privilege (SCRUM-3023) | **GAP — no evidence** | §9 CC6.1. Prod runs with **Owner** on the whole GCP project; 3 non-expiring downloadable keys; the same identity can impersonate one that reads the treasury WIF. **The §0.1 zombie teardown was performed by that identity.** Founder authorisation required; the soak cannot close it |

---

## 15. Dashboards — render-level vs data-level

**State: render-level DAILY-E2E (unscheduled) · data-level now DAILY-PROBE (P10).**

**Render-level** (§4 S5): `e2e/dashboard.spec.ts`, `e2e/mobile-viewport.spec.ts` (375px stacked cards),
`e2e/performance.spec.ts` (<5 s), `e2e/route-screenshot-baseline.spec.ts` (~57 route cases at 1280 + 375),
`e2e/pipeline-admin-errors.spec.ts` (explicit fallback banner when `/api/admin/pipeline-stats` fails —
the honest-failure assertion). Admin dashboards appear **only as screenshots** in the baseline spec.

**Data-level** — 10 dashboards, 9 of them genuinely data-backed:

| Page | Route | Source | Probe |
|---|---|---|---|
| `DashboardPage` | `/dashboard` | Supabase RPC `get_org_anchor_stats` / `get_user_anchor_stats` | e2e |
| `ComplianceDashboardPage` | `/organization/compliance` | hybrid — Supabase + `/api/v1/compliance/{score,gap-analysis,rules}` | e2e |
| `ComplianceTrendPage` | `/organization/compliance-trends` | `/api/v1/signatures/compliance-trends` | e2e |
| `ComplianceScorecardPage` | `/compliance/scorecard` | `/api/v1/compliance/audit` | e2e |
| `PlatformOverviewPage` | `/admin/overview` | `/api/admin/platform-stats` | **P10a** |
| `PipelineAdminPage` | `/admin/pipeline` | `/api/admin/pipeline-stats` + Supabase | **P10b** |
| `TreasuryAdminPage` | `/admin/treasury` | `/api/treasury/{status,health,x402-stats}` | **P10c** |
| `OpsSloDashboardPage` | `/admin/ops-slo` | `/api/admin/ops-slo-stats` | **P10d** |
| `SystemHealthPage` | `/admin/health` | `/api/admin/system-health`, `/jobs/smoke-test` | e2e only |
| `PaymentAnalyticsPage` | `/admin/payments` | Supabase `x402_payments` | e2e only |

**Purely render-level / derived (no fetch of their own):** the endpoint-breakdown panel in
`PaymentAnalyticsPage.tsx:87-90` (labels derived from `verification_request_id` prefixes — *not* API calls, easy
to misread as coverage), the `OpsSloDashboardPage` body, and the StatCard / gauge / badge components.

**P10 today:** payloads asserted by **key set**, never by status code — `platform-stats` → SKIP (429),
`pipeline-stats` → `[anchorLinkedRecords, anchoredRecords, broadcastingRecords, bySource, cacheUpdatedAt]`,
`treasury/status` → `[fees, network, recentAnchors, wallet]`, `ops-slo-stats` → `[anchorSecuredRate, apiErrors,
checkedAt, connectorQueue, creditConservation]`, anon → **401**. A 429 is recorded as **SKIP with the 429
named**, never as a pass — a rate-limited request is evidence about the limiter, not about the dashboard or
about authorization. The probe's first draft asserted guessed field names (`totalAnchors`, `balance`) and
produced two false FAILs; asserting on the returned key set tests the API, not the probe author's memory.

**Observation:** `/api/admin/ops-slo-stats` 429s persistently under light probe load (3 retries × 20 s) — a
tighter per-route limit than its siblings. Worth confirming it is intentional.

---

## 16. The DB itself

**State: SOAKING-CONTINUOUS, with parity measured daily — but parity is **ledger-level**, not schema-level.**

**Measured live today:**

| Dimension | Rig | Prod | Verdict |
|---|---|---|---|
| Migration ledger head / rows | 0409 / 111 | 0409 / 111 | **parity** (A15) |
| `public` tables | 115 | 115 | parity |
| Tables with RLS / FORCE RLS | 115 / 115 | 115 / 115 | parity |
| `public` functions | 370 | 370 | parity |
| **anon-executable functions** | **282** | **262** | **+20 divergence — item 14a** |
| Non-internal triggers | **68** | **62** | +6 (Gate-0 anti-reseed) |
| Orgs / API keys / flag rows | 2 / 11 / 25 | 10 / 19 / 24 | fixture vs prod, expected |
| Anchors / SECURED / proofs | 12 / 12 / 12 | 3.48M / 3.48M / 508k | fixture vs prod |

**A15 asserts ledger head parity daily.** `manifest-DAY-0.md` §2.4 states plainly that **no schema diff was run**
— parity is `version` + row count only. The two divergences above (anon grants, trigger count) are exactly the
class a ledger-level check cannot see, and they were found by direct query, not by the gate. **P8** now closes
the grant half of that blind spot daily.

Known cosmetic divergence: **FD-9** — the `0403` ledger `name` carries the numeric prefix on the rig and not in
prod. `version` and row counts are identical and every parity gate reads `version`. Informational.

Preflight: `environment_type = clean_mirror` captured once at Day 0 and hashed into the manifest. Per the
**DEG-6 rule**, Check 5 (`submitted_anchors > 0`) failing *after* the clock starts because anchors are confirming
is **expected healthy behaviour, not contamination**, and must never be "repaired" by hand-inserting a SUBMITTED
row. Known preflight false positive: `duplicate_names` flags `validate_api_key_rpc_hardening` because `0302_`
and `0303_` legitimately share a descriptive name (dedup by `name` instead of `version`).

---

## 17. API keys provisioned

**State: sufficient for the week in count and scope — but the CC6.8 *revocation* control is UNREACHABLE. New FAIL.**

**Live inventory (rig, today): 11 keys across 2 orgs.**

| Prefix | Name | Org | Scopes | Tier | Expires |
|---|---|---|---|---|---|
| `ak_live_a7f3` | soak-public-api | Acme Corp | verify, verify:batch, read:records, read:orgs, read:search, usage:read | paid | — |
| `ak_live_2a54` | soak-mcp | Acme Corp | read:records, read:orgs, read:search, verify, agents:manage | paid | — |
| `ak_live_4be8` | soak-sdk-write | Acme Corp | write:anchors, anchor:write, anchor:read, attestations:write, attestations:read, webhooks:manage, read:search | paid | — |
| `ak_live_RLCh` | soak-orgb-crosstenant | **Arkova** | verify, read:records, read:orgs, read:search, usage:read, write:anchors, anchor:write, anchor:read | paid | 2026-09-10 |
| `ak_live_3b66` / `4847` | fullsoak-day0-probe ×2 | Arkova / Acme | verify, verify:batch, anchor:write, anchor:read, usage:read, keys:manage | free | — |
| `ak_live_eb1f` | fullsoak-day0-webhooks-probe | Acme Corp | webhooks:manage | free | — |
| 4 × `soak-daily-revocation-probe-*` | this audit | Arkova | verify | free | — |

**Enough for the week?** Yes for coverage — public-API, MCP, SDK-write, cross-tenant, webhooks-manage and
keys-manage are all represented across both orgs, and both rate-limit tiers are exercised.
**FD-12 stands:** the CC6.8 designation table (`docs/staging/evidence/CC6.8/api-key-designation.csv`) is **not
yet written** and must reconcile against the live count, not a remembered one. Three keys have **no expiry**,
which §11 says is itself a finding to flag.

**Naming trap:** `soak-orgb-crosstenant` belongs to org **Arkova** (org A), not Org B. Cross-tenant evidence must
cite the key's `org_id`, never its name.

### New finding — **FD-P7: API-key revocation and deletion are unreachable from any client**

**Severity: prod-exposed. This defeats a control asserted to the SOC 2 auditor under CC6.8.**

`toPublicKey()` (`services/worker/src/api/v1/keys.ts:36`) deletes `id` from **both** the create response
(`:163`, per SCRUM-1271-D "omit internal id") **and every list row** (`:214`). But the revoke and delete
handlers are addressed by id — `PATCH /api/v1/keys/:keyId` (`:224`, sets `is_active:false` and logs
`api_key.revoked`) and `DELETE /api/v1/keys/:keyId` (`:302`) — and the UI calls them with a `keyId` it has no
way to obtain: `src/hooks/useApiKeys.ts:118,134` take `keyId`, `ApiKeySettingsPage.tsx:89-90` wires
`onRevoke={revokeKey}` / `onDelete={deleteKey}`, and `ApiKeyMasked` **declares `id: string`** (`useApiKeys.ts:17`)
— a type that the server never satisfies.

**Verified live against the rig today:**

```
GET /api/v1/keys  ->  200, 4 keys
FIELDS RETURNED: ['created_at','expires_at','is_active','key_prefix','last_used_at',
                  'name','rate_limit_tier','scopes']
has id field: False
```

**Consequences.** (1) A customer cannot revoke a leaked API key through the product. (2) The runbook's daily
CC6.8 assertion — "assert daily that a **revoked** key is refused" — cannot be satisfied through the customer
path; there is also no revoked key on the rig to assert against. (3) `PATCH` is the only path that sets
`is_active:false`, and it sets **only** that — `revoked_at` and `revocation_reason` stay NULL, so the designation
table's `revoked` column will read false even after a successful product-path revoke. (4) The probe cannot clean
up after itself, which is why 4 probe keys are now on the rig; P7 caps itself at 8 to prevent runaway accretion.

P7 records this as a mechanical **FAIL** each run (`P7f` grant-precondition, `P7d` the control itself) rather
than skipping past it. It is not in §4's table in any form.

---

## Founder levers

### Converts DECLARED-UNTESTED → soaked, if supplied

| Lever | Unlocks | Notes |
|---|---|---|
| **DocuSign sandbox tenant credentials** (`DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_CLIENT_SECRET`, `INTEGRATION_STATE_HMAC_SECRET`) | `ENABLE_DOCUSIGN_OAUTH`; the connector **vendor-fetch → artifact** leg (Day-0 #8's declared-untestable half); 6 unbound `docusign-*` crons; `ENABLE_DOCUSIGN_QUEUE_RECONCILIATION` | **Requires a worker restart, which resets the soak clock.** Supply for the *next* window, or accept a re-pinned clock. |
| **Google Drive OAuth test-app credentials** (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`) | `ENABLE_DRIVE_OAUTH`; the `changes.list` runner leg (Day-0 #18's skip); 2 unbound `drive-*` crons | Same restart caveat. |
| **Stripe test-mode price IDs (#2049)** | Checkout end-to-end (purchase → credits land), §4 S16's DU row, claims-register row 12, Day-4's billing plan | **Every UI-wired plan has `stripe_price_id = NULL`.** Founder-blocked; nothing else in the soak can close it. |
| **npm / PyPI publish account** | A corrective SDK release if the AdES claim probe (A-3.2) fails — claims-register row 9 | Founder-reserved credential. |
| **Fill `[PRIORITY DOCUMENT TYPES]` in the LOI + Pilot Success Criteria** | Item 4's type matrix. Until then the 11-row Kenya candidate list is *candidate packet input only* and must not be presented as agreed scope | Contract edit, not a credential. |
| **CE credentials + `CE_API_KEY_EXPIRES_AT`** | `ENABLE_CE_REGISTRY_DRIFT_CHECK`, `ENABLE_CE_KEY_EXPIRY_ALERTS`, 2 unbound crons | CE trial expires ~2026-09-09 (R-1). |
| **Vanta/Drata OAuth + `GCP_KMS_INTEGRATION_TOKEN_KEY`** | `ENABLE_GRC_INTEGRATIONS` | Restart caveat. |
| **ATS / Veremark (`VEREMARK_WEBHOOK_SECRET`) / Microsoft-Graph (`MICROSOFT_GRAPH_CLIENT_STATE`) secrets** | 3 of the 8 inbound webhook families | The ATS kill switch guards a **known multi-secret tenant-isolation finding** — fix that before enabling. |
| **Arize `ARIZE_API_KEY` + `ARIZE_SPACE_ID`** | `ARIZE_TRACING_ENABLED` | Observability only; no assertion value for this soak. |
| **Authorise SCRUM-3023** (remove Owner from the prod runtime identity **and** close the treasury-WIF impersonation path together) | The CC6.1 least-privilege row, currently **GAP — no evidence** | Highest security risk carried. Removing Owner alone is insufficient. |
| **Decide G8** (backfill the 2,967,774-record proof gap before launch, **or** publish the limitation) | A recorded decision **is** the PASS; silence is the FAIL | Includes HakiChain's own `ARK-2026-8F862179`, which returns 404 `NO_BATCH_PROOF`. |
| **Decide the claims retractions** (priced `/ai/search` and `/nessie/query` on `/developers`; the "Continuous" fraud-detection assertion in the SOC 2 evidence matrix) | Claims-register rows 2, 4, 7 | Two are **priced commercial representations** for capabilities that do not function. |
| **Revoke the outside vendor's write access** to the deployment-config repository | §13 item 4 | |

### RTE / engineering levers (not founder-gated)

- **Arm one `organization_field_policies` row** for a fixture org (a deliberate service-role INSERT, documented
  in the `0405` header) → converts item 10's positive enforcement path from DU to soaked. Only ~10 lines of
  probe change needed; the daily probe already covers the negative side.
- **Bind the 8 credit/billing crons and `reconcile-credit-conservation`** → makes §4 S16's assertion true as
  written and corrects §4.1's "+3 recovered" claim.
- **Schedule the daily E2E run.** Four §4 rows say "daily Playwright E2E" and nothing schedules it; the CI job is
  path-gated and reports green when skipped.
- **Write the DPA / folders / invitations e2e specs** — three of the four features audited here had zero e2e.
- **Fix FD-P7** (return `id` from `GET /api/v1/keys`, or add a `PATCH/DELETE /api/v1/keys/by-prefix/:prefix`) →
  restores the CC6.8 revocation control and lets P7 self-clean. Also set `revoked_at` / `revocation_reason` on
  revoke.
- **Fix FD-4** before launch (the `check-confirmations` lease deadlock — prod-exposed, no self-heal, no alarm,
  HTTP 200 throughout) and **FD-2** (`check-credential-expiry` 500s on every run in prod).
- **Fix SDK-1** — republish `arkova` with `compliance_controls` typed as a list. Until then the only published
  Arkova SDK cannot `verify()` a production record whose credential type maps to controls. Add a contract test
  that validates the published models against a **live** `/api/v1/verify/{id}` payload; the current suites mock
  the transport, so no amount of green in them could have caught this.
- **Decide SDK-2** — either gate `/api/v1/nessie/query` behind `ENABLE_NESSIE_RAG_RECOMMENDATIONS` so it fails
  closed with an explicit disabled response (the route is currently mounted unconditionally at
  `api/v1/router.ts:542`), or retract the priced `/nessie/query` offer on `/developers`. Returning 200 with an
  empty result set while the feature is permanently off is the worst of the three options.
- **Fix FD-C1** — `/jobs/calibration-refit` 500s on a missing `public.calibration_features` view in **both** the
  rig and prod. Either ship the 0222 view or delete the route.
- **Fix FD-C2** — `refresh_cache_anchor_status_counts()` publishes `total=0` from a stale `pg_class.reltuples`
  estimate with no staleness sentinel, so the admin dashboards read 0 anchors on any low-write or freshly
  restored environment. Give the estimate path the same `-1` sentinel the absent-cache path already has, or
  fall back to `count(*)` below a row threshold. Also strengthen probe P10 to assert a *number*, not a shape —
  it currently cannot catch this class at all.
- **Publish or retire the three npm SDKs.** All three are 404 on the registry; two have no publish workflow at
  all. Every claim that they are "installed from the registry" is unsatisfiable until this is resolved.
- **Update §4 S1's GetBlock row from DU to IN** — FD-3's provider flip made it prod-parity-true.

### Cannot convert, regardless of what anyone supplies

| Item | Why |
|---|---|
| **Nessie** — `/nessie/query`, `ENABLE_NESSIE_RAG_RECOMMENDATIONS`, `ENABLE_CONSTRAINED_DECODING`, the `nessie_query` MCP tool | Founder directive 2026-08-01: permanently OFF. The daily assertion is that it **fails closed**. The priced `/nessie/query` offer on `/developers` is a retraction decision, not a coverage gap. |
| **Mainnet signing / broadcast** | By design (BTC9). The rig must never touch mainnet; PR #2140's backfill must not run in the window. **Partially compensated, not converted:** `fullsoak-prod-mainnet-evidence.sh` records prod's own mainnet operation during the window (6,553 SECURED in 24 h; one txid confirmed on two independent explorers at block 962,153) as clearly-labelled SUPPLEMENTARY evidence. The rig's own mainnet path stays DECLARED-UNTESTED and the artifact asserts the rig holds zero mainnet-height anchors. |
| **Upstash rate limiting as prod runs it** | No management credential exists. The rig's in-memory limiter is asserted instead — and is demonstrably live (two 429s today). Open shadow finding F-2. |
| **The prod-environmental fault class** (the 2026-08-11 `PGRST002` schema-cache outage) | The rig runs a different database and PostgREST and is **structurally incapable** of reproducing it (G15). Prod `/health` is monitored throughout instead. |
| **Prod-only pg_cron jobs; Storage write plane + bucket inventory** | Prod is change-frozen for the window, and neither is enumerable from any repo artifact (§4.3 items 2–3). |
| **The 2,967,774-record historical proof gap** | Not closeable by any soak. G8 requires a **recorded decision**, not a fix. |
| **The feature-inventory file** (~1,151 features; the 596 / 400-LIVE corrected ledger) | **Absent from the repository.** Its per-feature rows and the weighting of its 106 unplanned LIVE items are unrecoverable, so §4's denominator is a code-evidence reconstruction and the two cannot be proven equivalent. |
| **The ~19–20-function gap between prod's anon-RPC count and what migrations reconstruct** | Functions live in prod with no surviving migration source (§4.3 item 4). Item 14a measures the *rig-vs-prod grant* gap, which is a different and now-instrumented thing. |
| **`ENABLE_COMPLIANCE_ENGINE`, `ENABLE_ZK_PROOFS`** | Dead flags — zero call sites repo-wide. There is nothing to unblock; enabling either would be a false-green. |
| **`ENABLE_ADES_SIGNATURES` as shipped** | Defaults to `aws_kms` and **no AWS account exists** by standing directive. Converting means reversing the no-AWS directive or re-pointing the engine at GCP KMS — engineering, not credentials. |

---

## Daily vs Day-0-only

**Runs every soak day** (both scripts, in this order):

1. `scripts/staging/fullsoak-daily-check.sh` — A1–A19 parity/integrity (SHA, digest, traffic mode, uptime,
   freeze vars, env hash, flag hash, scheduler census, alert/uptime-check census, ledger head, detailed health,
   RPC node height, both `/health` statuses).
2. `scripts/staging/fullsoak-daily-probes.sh` — P1–P10 behaviour (login, cross-tenant, invitations, folders, DPA
   write-lock, QR target, API-key scope + revocation, anon-RPC deny sweep, webhook HMAC, dashboards).
3. `scripts/staging/fullsoak-cron-exerciser.sh` — the 85 unbound cron routes: policy-gated force-run, per-route
   status/latency/body/row-delta, anchor-cohort integrity before and after. *(new 2026-08-12)*
4. `scripts/staging/fullsoak-sdk-integration.sh` — registry census + live-API smoke over all four SDK artifacts'
   public surfaces. *(new 2026-08-12)*
5. `scripts/staging/fullsoak-prod-mainnet-evidence.sh` — read-only prod mainnet observation + two-explorer
   confirmation. SUPPLEMENTARY; never converts a rig row. *(new 2026-08-12)*
6. Runbook §7 standing items not covered by any script and still **manual**: the 03:00 UTC forced-flush
   observation with queue depth before/after; all 5 Bitcoin safety loops forced with a named observation; alert
   review with the count recorded; the `sha256sum` manifest commit.

**Day-0-only, not repeated:** Gate 0 flag reconciliation; the 28-row behavioural flag probe sweep
(`day0-behavioral-probes.md`); the `clean_mirror` preflight capture (DEG-6 — expected to fail Check 5 from Day 1
onward, by design); BL-2 close-out; the alert fire-tests; the rig↔prod baseline snapshots the daily check diffs
against.

**Scheduled but not yet run in-window:** the 22-format matrix (KPI-2 / F6 evidence artifact); the Day-4 rollback
rehearsal; the Day-5 orphan sweep (S23); the Day-7 offline proof verification of the Day-1 cohort; the CC6.8
designation CSV.

---

_Compiled 2026-08-12 by the coverage-audit session. Every count in items 14 and 16 was read live from
`gnkuaywlpmsaezwvlvhk` and `vzwyaatejekddvltxyye` on that date; every probe result is reproducible from
`docs/staging/evidence/fullsoak-2026-08/2026-08-12/probes-162633Z.json`. No rig env, flag, secret, scheduler
job, revision, or traffic split was modified; the soak clock was not touched._

_Amended 2026-08-12T17:15Z (coverage-gap-closure session): rows 1 (cron), 8 (SDK) and the mainnet rows in item 2
and §Levers rewritten against three new daily instruments — `fullsoak-cron-exerciser.sh`,
`fullsoak-sdk-integration.sh`, `fullsoak-prod-mainnet-evidence.sh` — each executed live before the row was
written. New findings: **FD-C1** (`calibration-refit` 500, missing view in rig AND prod), **FD-C2**
(`refresh_cache_anchor_status_counts` publishes 0 from a stale planner estimate; admin dashboards read 0 anchors),
**SDK-1** (published PyPI `arkova` 2.2.0 cannot `verify()` a prod record — `compliance_controls` typed dict, API
returns list), **SDK-2** (`/api/v1/nessie/query` is mounted ungated and answers 200-with-empty instead of failing
closed). FD-2 independently reproduced. No rig env, flag, secret, scheduler job, revision or traffic split was
modified; the soak clock was not touched; the BL-2 cohort measured 12 anchors / 12 proofs before and after._
