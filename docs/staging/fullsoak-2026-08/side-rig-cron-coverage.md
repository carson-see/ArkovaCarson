# Side-rig cron coverage — closing the 51 DENIED routes

> Run `2026-08-13T15:56Z → 16:35Z` · target **`arkova-worker-connector-sidecar-2026-08-staging`**
> (rev `00006-jzj` → `00009-6sw`, image digest `sha256:8ace89d4…`, identical to prod)
> Supabase **`ehqqearcitrgloibtjqx`** · worker `git_sha` `f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58`
> Companion to `docs/staging/evidence/fullsoak-2026-08/2026-08-12/cron-exerciser.md`.

## Why this exists

The 2026-08-12 cron exerciser reached 59 of 110 declared cron routes and **DENIED 51** — the
largest single coverage gap in the soak. 42 of those 51 (code **D1**) were denied for exactly one
reason: `/jobs/anchor-public-records` is Scheduler-bound `*/10` on the frozen soak rig, so ingesting
even one page of `public_records` would convert into PENDING anchors and contaminate BL-2's measured
12-anchor / 12-proof cohort.

**That objection does not exist on the connector side-rig.** It runs the same image digest but
**zero Cloud Scheduler jobs bind it** (verified: `gcloud scheduler jobs list | grep connector-sidecar`
returns nothing, against 26 jobs on the soak rig). So the cascade that motivates D1 cannot happen.

## Headline

| | |
|---|---|
| Routes force-run on the side-rig | **49** of the 51 denied |
| Still denied everywhere (D3 mainnet, D4 real-BTC spend) | **2** — never invoked on any rig |
| **New combined cron coverage** | **108 / 110 = 98.2%** (was 59/110 = 53.6%) |
| Rows ingested | **26,100** `public_records` across **15** live registries |
| Embeddings generated | **1,000** `public_record_embeddings` (Gemini, real API) |
| `anchor_proofs` written by the armed D5 run | **9** (0 → 9) |
| Frozen soak rig | **UNTOUCHED** — see the attestation at the bottom |

**Defects found: 13 real, 3 credential gaps, 3 environment-blocked, 7 timeouts.** Detail below.

---

## THE FINDING THAT MATTERS MOST: the family is gated dark, and fails silently

Two independent discoveries, either of which alone would invalidate a naive "I ran them all, they
returned 200" claim.

### FD-S1 — a blind run would have produced 100% false coverage

Every D1 fetcher begins with a `get_flag('ENABLE_PUBLIC_RECORDS_INGESTION')` switchboard check. The
side-rig's `switchboard_flags` table contained **exactly one row** (`ENABLE_ORG_CREDIT_ENFORCEMENT`),
so the flag read returned null and **every fetcher no-opped while returning HTTP 200**:

```
FLAG OFF (baseline, recorded before arming):
  /fetch-ipeds          200  {"inserted":0,"skipped":0,"errors":0,"total":0}
  /fetch-edgar          200  {"inserted":0,"skipped":0,"errors":0}
  /fetch-courtlistener  200  {"inserted":0,"skipped":0,"errors":0,"pagesProcessed":0}
```

Indistinguishable from a healthy run. The flags were then inserted (`ENABLE_PUBLIC_RECORDS_INGESTION`,
`ENABLE_PUBLIC_RECORD_EMBEDDINGS` = true) and the real run began. **Any future exerciser that reports
"D1 all green" without asserting the flag state is reporting nothing.**

### FD-S2 — the entire ingestion family reports failure as HTTP 200

This is the systemic defect, and it is why 30 of the 42 routes look healthy to any HTTP-status monitor
while ingesting nothing. Each fetcher catches its own transport/API failure, increments an internal
`errors` counter, and returns **200** with the count buried in the body:

```
/fetch-uspto     200  {"status":"download_failed","inserted":0,"errors":0}   ← not even counted as an error
/fetch-ipeds     200  {"inserted":0,"errors":30}
/fetch-fcc       200  {"inserted":0,"errors":26}
/fetch-sec-iapd  200  {"inserted":0,"errors":26}
```

`/fetch-uspto` is the worst case: a hard dependency failure reported with `errors: 0`. A Cloud
Scheduler job on any of these is green forever. This is the same class as FD-2 — invisible until the
route is actually invoked — but broader, because FD-2 at least 500s.

---

## Per-route results — D1 (42 routes)

`http` is the **authoritative Cloud Run request-log status**, not the client's. (The client capped at
~60s on long routes and recorded `000`; the server-side log is the truth. E.g. `/fetch-edgar` client
`000` vs server `200 @71.2s`.) `rows` is attributed by the `public_records.source` literal, which is
immune to the background-continuation contamination that plain before/after deltas suffer.

| route | http | ms | rows (`source`) | verdict | root cause |
|---|---|---|---|---|---|
| `/fetch-edgar` | 200 | 71,192 | 2,826 `edgar` ¹ | **PASS** | Real ingestion. One `404` on a single CIK submissions doc — benign. |
| `/edgar-backfill` | 200 | 248,972 | ¹ | **PASS** | Real ingestion, bounded `batch=0`. |
| `/edgar-bulk` | 200 | 1,697 | ¹ | **PASS** | `{"inserted":100,"queriesRun":1,"formTypes":["10-K"]}` — bounded, correct. |
| `/fetch-federal-register` | 200 | 126,094 | 1,000 `federal_register` | **PASS** | Real ingestion. |
| `/fetch-openalex` | **504** | 300,000 | 8,411 `openalex` ² | **TIMEOUT** | Exceeded the side-rig's 300s request cap while ingesting. Work continued server-side. |
| `/openalex-bulk` | 200 | 3,229 | ² | **PASS** | `{"inserted":197,"pagesProcessed":1}` — bounded, correct. |
| `/fetch-dapip` | **504** | 299,975 | 900 `dapip` | **TIMEOUT** | Same 300s cap; ingested throughout. |
| `/fetch-acnc` | **504** | 300,001 | 4,920 `acnc` | **TIMEOUT** | Same. |
| `/fetch-calbar` | **504** | 299,974 | 706 `calbar` | **TIMEOUT** | Same. |
| `/fetch-finra` | **504** | 299,975 | 4,686 `finra` | **TIMEOUT** | Same. |
| `/fetch-acra-sg` | **504** | 299,975 | 2,380 `acra_sg` | **TIMEOUT** | Same. One `UND_ERR_SOCKET` mid-run; partial success. |
| `/fetch-licensing-board` | **504** | 299,975 | 0 | **TIMEOUT** | 300s cap with **zero** rows — the only 504 that produced nothing. |
| `/fetch-insurance-licenses` | 200 | 168,791 | 0 | **DEFECT** | Ran 169s, inserted nothing, reported no error. |
| `/fetch-npi` | 200 | 19,472 | 153 `npi` | **PASS** | Real ingestion, bounded `maxPerRun=10`/CA. |
| `/fetch-cnpj-br` | 200 | 12,046 | 20 `cnpj_br` | **PASS** | Real ingestion. |
| `/fetch-kenya` | 200 | 2,519 | 25 `kenya_law` | **PARTIAL** | Statutes OK; case-law search `403` ×5 (see ENV-BLOCK). |
| `/fetch-australia` | 200 | 552 | 38 `australia_law` | **PARTIAL** | Statutes OK; case-law search `403` ×5. |
| `/fetch-brazil-compliance` | 200 | 179 | 12 `brazil_law` | **PASS** | Static statute set; correct. |
| `/fetch-singapore-compliance` | 200 | 186 | 12 `singapore_law` | **PASS** | Static statute set; correct. |
| `/fetch-mexico-compliance` | 200 | 182 | 8 `mexico_law` | **PASS** | Static statute set; correct. |
| `/embed-public-records` | 200 | 27,803 | **1,000 embeddings** | **PASS** | Real Gemini calls: `{"total":1000,"succeeded":1000,"failed":0}`. |
| `/fetch-uspto` | 200 | 457 | 0 | **DEFECT** | Hardcoded PatentsView S3 URL returns **403 AccessDenied**; masked as `errors:0`. |
| `/fetch-state-bills` | 200 | 637 | 0 | **DEFECT** | OpenStates **422** — comma-joined `include`. Credential is VALID. |
| `/fetch-all-state-bills` | 200 | 4,186 | 0 | **DEFECT** | Same 422, per state. |
| `/fetch-sec-iapd` | 200 | 3,030 | 0 | **DEFECT** | `403` ×26 from `api.adviserinfo.sec.gov` — 403 from non-cloud IP too. |
| `/fetch-fcc` | 200 | 2,150 | 0 | **DEFECT** | `403` ×26 from `fcc.gov/api/license-view` — 403 from non-cloud IP too. |
| `/fetch-cms-physicians` | 200 | 1,426 | 0 | **DEFECT** | CMS API **400**; the dataset returns 200 for a well-formed query. Request shape is wrong. |
| `/fetch-medical-boards` | 200 | 302 | 0 | **DEFECT** | `data.ca.gov` **404** — `resource_id=physicians` is a placeholder, not a real resource id. |
| `/fetch-sos` | 200 | 223 | 0 | **DEFECT** | CA SOS returns **HTML**, parsed as JSON → `SyntaxError: Unexpected token '<'`. |
| `/fetch-moh-sg` | 200 | 1,137 | 0 | **DEFECT** | `data.gov.sg` datastore **404** — resource gone (404 from non-cloud IP too). |
| `/fetch-continuing-education` | 200 | 2,617 | 0 | **DEFECT** | NASBA **404** (gone); ACCME **404** on Cloud Run but **301** locally — redirect not followed. |
| `/fetch-cle` | 200 | 330 | 0 | **DEFECT** | NY CLE **403** on Cloud Run, **302** locally — redirect not followed. |
| `/fetch-edgar-form-adv` | 200 | 377 | 0 | **DEFECT** | `{"inserted":0,"errors":0,"pagesProcessed":0}` — silent no-op, zero diagnostics. |
| `/fetch-certifications` | 200 | 105 | 0 | **DEFECT** | `{"source":"CFA Institute","inserted":0,"errors":0}` in 105ms — stub, no request made. |
| `/fetch-enforcement` | 200 | 379 | 0 | **DEFECT** | `{"hipaaBreaches":0,"errors":0}` — silent no-op. |
| `/fetch-ipeds` | 200 | 1,496 | 0 | **ENV-BLOCK** | `403` ×30 from Cloud Run; **200 from a residential IP**. Egress IP blocked. |
| `/fetch-ecfr` | 200 | 1,033 | 0 | **ENV-BLOCK** | `403` ×15 from Cloud Run; **200 from a residential IP**. |
| `/fetch-courtlistener` | 200 | 30,731 | 0 | **CREDENTIAL** | `429` — token over quota. Backed off 30s, reported `errors:0`. |
| `/fetch-state-courts` | 200 | 90,784 | 0 | **CREDENTIAL** | Same CourtListener token/quota. |
| `/fetch-sam-entities` | 200 | 325 | 0 | **CREDENTIAL** | SAM.gov **401** — key rejected. |
| `/fetch-sam-exclusions` | 200 | 340 | 0 | **CREDENTIAL** | SAM.gov **401** — same key. |
| `/regulatory-change-scan` | 200 | 68 | 0 | **PASS** | `{"scanned":0,"alerts_created":0}` — `jurisdiction_rules` empty; correct no-op. |

¹ `edgar` = 2,826 rows, the combined product of `/fetch-edgar` + `/edgar-backfill` + `/edgar-bulk`.
² `openalex` = 8,411 rows, combined `/fetch-openalex` + `/openalex-bulk`.

## Per-route results — the other deny codes (7 routes)

| route | code | http | ms | delta | verdict | note |
|---|---|---|---|---|---|---|
| `/materialize-proof-backcatalog` | D5 | 400 | 161 | — | **GUARD OK** | `batch_size:10` rejected: "expected number to be >=50". Input validation works. |
| `/materialize-proof-backcatalog` | D5 | 200 | 661 | `anchor_proofs` 0 → 0 | **PASS** | Dry-run: `rowsScanned:9`, `plannedToInsert:9`, `inserted:0`. |
| `/materialize-proof-backcatalog` | D5 | 200 | 1,608 | **`anchor_proofs` 0 → 9** | **PASS (ARMED)** | `mode:"write"`, `inserted:9`, `conflictSkipped:0`. Full INSERT path proven. |
| `/classify-proof-backcatalog` | D6 | 200 | 1,308 | `job_queue` 6 → 7 | **PASS** | `plan:{direct_anchored:9, ambiguous:0}`, `writesApplied:0`. **D6's premise confirmed empirically**: the checkpoint persists in dry-run. |
| `/bq-export-backfill?table=audit_events` | D7 | 200 | 1,472 | 23 rows → BigQuery | **PASS** | Bounded by explicit `?table=`. `finalWatermark` set. Unbounded call correctly 400s. |
| `/drive-subscription-renewal` | D8 | 200 | 687 | none | **PASS (inert)** | `{"scanned":1,"renewed":0,"failed":1}` — no `google_drive` row on this rig, so nothing rotated. The seeded row P9b depends on lives on the frozen rig and was never reached. |
| `/queue-reminders` | G4 | 200 | 666 | none | **PASS** | `{"rules_evaluated":0}` — guard precondition passes here (0 enabled rules) where it failed on the soak rig. |
| `/report-metered-usage` | G2 | 200 | 279 | none | **PASS (no billing effect)** | `{"error":"sandbox_excluded"}` — the sandbox guard suppressed the Stripe meter event. Verified `sk_test_` key beforehand. |
| `/cleanup-retention` | D2 | 200 | 267 | see below | **PASS** | Run **last**, deliberately. |

### D2 — exactly what the retention purge deleted

```
BEFORE  webhook_delivery_logs=0  verification_events=18  ai_usage_events=0  audit_events=25
RESULT  {"success":true,"webhook_delivery_logs_deleted":0,"verification_events_deleted":0,
         "ai_usage_events_deleted":0,"audit_events_deleted":0}
AFTER   webhook_delivery_logs=0  verification_events=18  ai_usage_events=0  audit_events=26
```

**Deleted nothing.** The side-rig was created 2026-08-11, so no row is past the retention thresholds
(90 days / 1 year / 1 year / 2 years). The single `audit_events` increment is the function's own
`DATA_RETENTION_CLEANUP` record. The purge path is now exercised, and its accounting matches its
definition exactly.

> **Incidental hazard, worth a ticket:** `cleanup_expired_data()` performs
> `DROP TRIGGER reject_audit_delete` → `DELETE` → `CREATE TRIGGER` on `audit_events` with **no
> `SET LOCAL lock_timeout`**. That is the CLAUDE.md §1.2 pattern that caused the 2026-08-11 P0
> (11m39s of `service_unavailable` from one unbounded `ALTER TABLE`). It is inside a
> `SECURITY DEFINER` function, so the CI migration lint never sees it. On prod's `audit_events` this
> is a live lock-queue barrier risk.

## Never run — and still correct

| route | code | why it stays denied everywhere |
|---|---|---|
| `/mainnet-migration` | D3 | Mainnet. Never invoked on any rig, at any point. |
| `/supplementary-proof-anchor` | D4 | The only job that spends real mainnet BTC across the 2.97M backlog. Never invoked. |

---

## Credential gaps, named precisely

Five credentials were bound to the side-rig from Secret Manager (`EDGAR_USER_AGENT`,
`COURTLISTENER_API_TOKEN`, `OPENSTATES_API_KEY`, `SAM_GOV_API_KEY`, `GEMINI_API_KEY`).

| credential | state | evidence | consequence |
|---|---|---|---|
| `edgar-user-agent` | **VALID** | EDGAR ingested 2,826 rows | — |
| `gemini-api-key` | **VALID** | 1,000/1,000 embeddings succeeded | — |
| `openstates-api-key` | **VALID** | Direct probe `HTTP 200` | Routes still fail — the defect is ours, not the key's |
| `sam-gov-api-key` | **INVALID** | Direct probe `HTTP 401` | `/fetch-sam-entities`, `/fetch-sam-exclusions` fail on auth, not logic |
| `courtlistener-api-token` | **OVER QUOTA** | With token → `429`; **without token → `200`** | The bound token is *worse than no credential*. Affects 2 routes. |
| *(none exists)* | **ABSENT** | — | No credential exists for FCC / SEC IAPD / IPEDS / eCFR / CMS / NY-CLE / NASBA / ACCME / MOH-SG / CA-SOS. Those routes are unauthenticated scrapers, and that is why they are the ones breaking. |

## Cloud-egress vs. genuinely broken — the decisive test

Every `403` was re-probed from a non-cloud (residential) IP with the same User-Agent. This separates
"Cloud Run is blocked" from "the endpoint contract changed":

| endpoint | from Cloud Run | from residential IP | verdict |
|---|---|---|---|
| IPEDS (`educationdata.urban.org`) | 403 | **200** | Cloud egress blocked |
| eCFR (`ecfr.gov`) | 403 | **200** | Cloud egress blocked |
| NY CLE (`ww2.nycourts.gov`) | 403 | **302** | Cloud egress blocked + redirect not followed |
| ACCME | 404 | **301** | Redirect not followed |
| CMS (`data.cms.gov`) | 400 | **200** | Our request shape is wrong |
| CA SOS (`bizfileonline`) | HTML | **200** | Our request shape is wrong |
| FCC (`fcc.gov/api`) | 403 | **403** | Genuinely rejected |
| SEC IAPD (`adviserinfo.sec.gov`) | 403 | **403** | Genuinely rejected |
| USPTO (`s3.../patentsview`) | 403 | **403** | Bucket access revoked |
| NASBA / MOH-SG | 404 | **404** | Endpoint gone |

**Prod runs on Cloud Run too**, so the egress-blocked cases would fail identically in prod. They have
gone unnoticed because prod's feeder crons are PAUSED.

## Two defects with an exact, actionable fix

**1. OpenStates `include` is comma-joined; the v3 API requires repeated params.**
`services/worker/src/jobs/openStatesFetcher.ts:148`

```
include: 'abstracts,sponsorships'      →  HTTP 422
&include=abstracts&include=sponsorships →  HTTP 200   (verified both directions)
```

The API's own 422 body names it: `"value is not a valid enumeration member; permitted: 'sponsorships',
'abstracts', …"`. The key is valid; the request is malformed. This breaks `/fetch-state-bills` and
`/fetch-all-state-bills` **100% of the time**, and both still return HTTP 200.

**2. USPTO's bulk source is a hardcoded S3 URL that now returns 403.**
`services/worker/src/jobs/usptoFetcher.ts:26` —
`https://s3.amazonaws.com/data.patentsview.org/download/g_patent.tsv.zip` →
`<Error><Code>AccessDenied</Code></Error>`. Reported as `status:"download_failed"` with **`errors: 0`**.

## Timeout observation (rig-config, not a product defect — stated plainly)

Seven routes hit **504 at exactly 300s**. The side-rig's `timeoutSeconds` is **300**; prod's
`arkova-worker` is **3600**. So these are *not* prod-breaking as observed. What they do establish:
this ingestion family has **no internal time budget** and will run until the platform kills it. Six of
the seven were still inserting rows when cut. `/fetch-licensing-board` burned the full 300s and
inserted nothing.

## Incidental findings (outside the 51, surfaced by the run)

- **`ENABLE_SEMANTIC_SEARCH` flag read fails closed** with `PGRST116 "The result contains 0 rows"` and
  falls back to `false`. Same empty-`switchboard_flags` dark-API class as FD-S1.
- **`Stuck anchor monitor: count context unavailable`** — same `PGRST116` shape on a `SUBMITTED` count.
- **FD-2 root cause re-confirmed on this schema**: `anchors` has neither `not_after` nor
  `document_title` (`information_schema` count = 0 of 2).
- **Concurrent probe traffic** from `216.183.125.66` generated 89 × `Rate limit exceeded` against the
  side-rig during the window, and created 5 PENDING anchors. Not this exercise; noted so the anchor
  movement below is not misattributed.

---

## Attestation — the frozen soak rig was not touched

No command in this exercise targeted `arkova-worker-fullsoak-2026-08-staging`,
`gnkuaywlpmsaezwvlvhk`, `arkova-worker`, or `vzwyaatejekddvltxyye` in any mutating capacity. The only
soak-rig and prod interactions were **read-only** `gcloud run services describe` and `SELECT`s.

Verified mid-exercise:

```
arkova-worker-fullsoak-2026-08-staging → rev 00013-mrw, 100% traffic  (unchanged)
gnkuaywlpmsaezwvlvhk → anchors=12  anchor_proofs=12  public_records=0
```

The BL-2 cohort is intact at **12 anchors / 12 proofs**, and the frozen rig's `public_records` is
still **0** — none of the 26,100 rows ingested here reached it. The soak clock was not disturbed: no
revision, env var, secret, flag, Scheduler job, or traffic split on that service was modified.

**Anchor accounting on the side-rig:** `anchors` moved 1 → 17. **Zero** of that is attributable to
this exercise — `public_records WHERE anchor_id IS NOT NULL` = **0**, i.e. not one ingested row
converted into an anchor. The movement is backdated fixture rows plus 5 PENDING anchors created by
the concurrent probe traffic noted above. This is the empirical confirmation that D1's cascade
genuinely cannot fire without a Scheduler binding.

### Side-rig mutations made (all permitted, all disposable)

1. `switchboard_flags`: inserted `ENABLE_PUBLIC_RECORDS_INGESTION=true`, `ENABLE_PUBLIC_RECORD_EMBEDDINGS=true`.
2. Cloud Run env: bound `EDGAR_USER_AGENT`, `COURTLISTENER_API_TOKEN`, `OPENSTATES_API_KEY`,
   `SAM_GOV_API_KEY`, `GEMINI_API_KEY` (rev `00006-jzj`), then `PROOF_MATERIALIZER_CONFIRM=EXECUTE`
   (rev `00009-6sw`) to arm D5's write path.
3. Data written: 26,100 `public_records`, 1,000 `public_record_embeddings`, 9 `anchor_proofs`,
   3 `job_queue` checkpoint rows, 23 rows exported to BigQuery, 1 `DATA_RETENTION_CLEANUP` audit row.

---

## Coverage math

| | routes |
|---|---|
| Declared in `cron.ts` | 110 |
| Covered by the 2026-08-12 soak-rig run (25 bound + 34 exercised) | 59 |
| **Added by this side-rig run** | **+49** |
| **Total covered** | **108** |
| Permanently denied (D3 mainnet, D4 real-BTC) | 2 |
| **Coverage** | **108 / 110 = 98.2%** |

_No rig env, flag, secret, Scheduler job, revision or traffic split was modified on the frozen soak
rig or on prod. Produced alongside `scripts/staging/fullsoak-cron-exerciser.sh`, whose D1/D2/D5–D8
policy comments now point here._
