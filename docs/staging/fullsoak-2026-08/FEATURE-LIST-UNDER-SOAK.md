# Every feature under soak — fullsoak-2026-08

**Window:** 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z · **Rig:** `arkova-worker-fullsoak-2026-08-staging-00013-mrw`
(prod's exact image digest `sha256:8ace89d4…`, prod's git_sha `f5d1070fc…`, prod's ledger 0409).

Derived from `founder-coverage-checklist.md` (17 domains) and runbook §4. **Coverage: 298 of 401 LIVE
features (74.3%) in scope with a named assertion.** Every item not in scope is named below with its reason —
per exit criterion G13, a report implying 100% is an automatic NO-GO.

---

## A. SOAKING-CONTINUOUS — running 24/7 on the rig, unattended

These are exercised by the rig's own bound schedulers and real traffic, not by any external instrument.

| # | Feature | How it is proven |
|---|---|---|
| A1 | **Bitcoin anchoring, full lifecycle** — create → batch → dynamic-fee broadcast → 2-explorer confirm → SECURED → proof materialisation | 12/12 SECURED, 12/12 `anchor_proofs.block_header` at **80 raw bytes**, verified against an independent RPC node + mempool.space + blockstream.info |
| A2 | **All 5 Bitcoin safety loops** — `detect-reorgs`, `monitor-stuck-txs`, `rebroadcast-txs`, `consolidate-utxos`, `monitor-fees` | All Scheduler-bound and firing. **First operating-effectiveness evidence these controls have ever had** — 52 of 105 prod routes still have no prod schedule, including all five |
| A3 | **25 cron routes at prod-parity cadence** | DEG-1 re-pointed `batch-anchors`, `check-confirmations`, `process-anchors` to `*/30` and the flush to `0 3 * * *` to match prod exactly |
| A4 | **Queue subsystem** — org-queue scheduler, `job_queue`, batch drain, daily 03:00 forced flush | Flush observed end-to-end (PENDING 2→0 in ~1.4s); org-queue writes real run rows after the DEG-5 fix |
| A5 | **Database** — 115 tables, RLS forced, guard triggers, migration ledger | Ledger 0409/111 rows == prod; RLS + trigger guards demonstrated live (they blocked privileged writes twice during fixture setup) |
| A6 | **Worker `/api/v1` public API** | Real JWT + API-key traffic every probe cycle |
| A7 | **Outbound webhooks + HMAC verification** | Signed/forged pair-test: forged rejected, signed accepted, replay rejected |
| A8 | **Auth / login** (server-side session minting) | Both orgs mint real JWTs each cycle; wrong password refused |
| A9 | **Credit enforcement + deductions ledger** | `org_credit_deductions` deltas per anchoring charge |
| A10 | **AI extraction + AI reports** | `ai_usage_events` / `ai_reports` row deltas |
| A11 | **Connector artifact drain** | Fixture → `anchored` → anchor +1 → deduction +1 |
| A12 | **Public-record anchoring** (`anchor-public-records`, bound `*/10`) | Live in prod too — prod's 6,553 anchors/24h come from this family |
| A13 | **Chain dependency: signet bitcoind node** | GCE VM RUNNING, txindex at tip, serving the GetBlock-hybrid provider (**prod's exact chain architecture**) |

## B. DAILY-EXERCISED — 31 additional cron routes

Force-run each day by `fullsoak-cron-exerciser.sh` with a per-route policy table.
**Cron reach: 25 bound + 31 exercised = 56 of 110 (50.9%).**
Found 3 defects on first run: FD-2 (`check-credential-expiry` 500), FD-C1 (`calibration-refit` 500),
FD-C2 (`smoke-test` 503 → dashboards can publish a hard 0).

## C. PROVEN DAY-0 + sampled by daily probes (39 assertions)

| Feature | Status |
|---|---|
| **DocuSign webhook → enqueue → drain → anchor** | PASS end-to-end to SECURED |
| **DocuSign OAuth → fetch → server-side fingerprint → anchor** | PASS on side-rig — `ARK-DOC-GEF7SP`, §1.6A byte-hygiene clean incl. forced-failure test |
| **Cross-tenant isolation** (UI + direct PostgREST + public API) | Daily, via the hardened spec that can no longer pass on a login redirect |
| **Anon-RPC deny sweep** | 282 functions probed with type-invalid args; any 2xx is an immediate FAIL |
| **Drive webhook + changes-runner** | Synthetic push, claim transition |
| **Semantic search** | Embed producer found and enabled; `credential_embeddings` materialising |
| **QR code verification target** | `verification_events` delta |
| **Folders, invites, DPA field policies (0403/0404/0405)** | Newly wired daily probes — all three had **zero** coverage before Day 0 |
| **4 admin dashboards** | Data-level assertions, not just render |
| **Attestation anchoring** | Real signet tx `0cf45652…` |
| **API keys** | 11 active across both orgs, minted through the real product flow |

## D. DECLARED-UNTESTED — named, with the reason

**Blocked on a code defect (found by this soak):**
- **Drive OAuth connect** — FD-D1 personal scope passes eligibility then cannot persist; FD-D2 three sources of truth for org membership; FD-D3 org owner still denied. Founder consented live; the flow got to the callback and failed there.
- **Partner provisioning / HakiChain onboarding** — router now built (#2219) but it is **step 1 of 5**: no org creation, no API key issuance, no entitlement grant, no user invite, no flag seed. Claim **RETRACTED**.

**Blocked on credentials or data:**
- **Stripe checkout** — all three `sk_test_` secrets are 39–40 char placeholders (a real key is 107) and 401-invalid; every UI plan still has `stripe_price_id = NULL` (#2049).
- **Published SDKs** — all three npm packages 404. PyPI `arkova` 2.2.0 *is* published and **cannot verify a prod record** (SDK-1).
- **CE Registry drift check** — prod has **zero** anchors carrying `ce_registry_ctid`, so the consumer has nothing to read. Producer has never run in prod.

**Prod-only by design:**
- **Mainnet anchoring + GetBlock.io SaaS** — supplementary read-only prod evidence captured instead (6,553 anchors created *and* SECURED in 24h; latest tx at block 962,153 on two explorers).
- **Upstash distributed rate limiting** — credentials exist; proving it found the **P0**: the limiter shares no state, so prod's 5/min auth limiter is effectively ~50/min at maxScale=10.
- **Prod PostgREST fault class** (PGRST002) — the rig runs a different database and is structurally incapable of reproducing it.

**Deliberately off:**
- **Nessie** — permanent founder directive. Found **not failing closed**: returns HTTP 200 success shape for a *priced* offer.
- **AdES signatures** — `aws_kms` default, no AWS account exists.
- **Compliance engine** — dead code, zero consumers repo-wide.
- **51 cron routes** — each denied under a written policy code (D1 external-registry ingestion ×42, D2 retention purge, D3 mainnet, D4 real-BTC spend, D5 writes `anchor_proofs`, D6 advances a durable checkpoint, D7 unbounded export, D8 rotates a probe dependency). A route absent from the policy table is denied as `unclassified` — adding a route can never cause an unreviewed invocation.

## E. Historical limitation (not a soak gap)

**2,967,774 prod SECURED anchors (85.4%) have no per-document proof.** Anchoring is genuinely healthy — zero
false-SECUREDs. What is missing is proof *materialisation*, and the path is proven for everything issued from
launch onward. CTO ruling R-4: publish the limitation, backfill post-launch, never during the window.
