# Drive OAuth (FD-D3) + CE Registry Drift — Closure Evidence

**Date:** 2026-08-13
**Rig:** `connector-sidecar-2026-08` (side-rig)
**Predecessor:** [`connector-sidecar-evidence.md`](./connector-sidecar-evidence.md) §"Phase 4"
**Scope:** close FD-D3, take the Drive chain as far as it goes without a human, and run the CE
Registry drift job against live Credential Engine infrastructure for the first time.

---

## 0. Provenance — read this first

> **Side-rig evidence. No soak-tier authority.** Not an RC-manifest input, not valid in a
> `## Staging Soak Evidence` block, satisfies no T1/T2/T3 requirement.
>
> **The 7-day soak rig was never touched.** Cloud Run
> `arkova-worker-fullsoak-2026-08-staging` was on revision `…-00013-mrw` (Ready=True) at session
> start and remains on `…-00013-mrw` (Ready=True) at session end. Supabase `gnkuaywlpmsaezwvlvhk`
> received no read and no write.
>
> **Production was read-only, with one deliberate exception class: `EXPLAIN` without `ANALYZE`,
> and `SELECT` counts.** `EXPLAIN` does not execute the plan it prints. No prod row was created,
> updated, or deleted; no prod env var, secret, or revision was changed. Prod worker remains
> `arkova-worker-01310-god`.

| | |
|---|---|
| Side-rig Cloud Run | `arkova-worker-connector-sidecar-2026-08-staging`, revision **`00008-jnj`** |
| Image digest | `sha256:8ace89d483484c40ea2022f7f21361effbfd6e0ab4d61ac4707f54e2ed1c1e18` (identical to prod + soak rig) |
| Worker `git_sha` | `f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58` |
| Side-rig Supabase | `ehqqearcitrgloibtjqx` |
| Service URL used | `https://arkova-worker-connector-sidecar-2026-08-staging-270018525501.us-central1.run.app` |

The **`-270018525501`** hostname spelling matters. `buildRedirectUri` derives the OAuth
`redirect_uri` from the inbound `Host` header, and only that spelling is registered on the Google
OAuth client. The `-kvojbeutfa-uc` alias that `gcloud run services describe` prints resolves to the
same service but produces an unregistered `redirect_uri` and a `redirect_uri_mismatch`.

> **Concurrency disclosure.** A second session was operating on this same side-rig during this
> work: `switchboard_flags` gained `ENABLE_PUBLIC_RECORDS_INGESTION` / `ENABLE_PUBLIC_RECORD_EMBEDDINGS`
> at 15:54:55Z, and the worker logs are dominated by its public-records crons (CourtListener,
> OpenAlex, DAPIP, ACNC, Open States). Nothing it did collides with the tables used here, but it is
> background load, and it is why timing figures below are measured directly against the registry
> rather than inferred from job wall-clock alone.

---

## 1. FD-D3 — ROOT CAUSE ESTABLISHED

### 1.1 Verdict

**FD-D3 was not an authorization bug. `isCallerOrgAdminResult` worked correctly the entire time.**

The `403 not_authorized` came from a completely different branch than the one under suspicion. The
probe called `POST /oauth/start` **without `org_id` in the body**, which routes to
`resolveIndividualPath`, not `resolveOrgPath`. That function has its own guard
(`drive-connect-eligibility.ts:128-132`): *the caller belongs to an org but called the personal
path*. Until this session that guard returned **`not_admin`** — the same reason
`resolveOrgPath` returns for a genuine non-admin, mapped through `DENY_HTTP` to the same
HTTP 403 `not_authorized`.

So the sequence that produced FD-D3 was:

1. Original probe (pre-FD-D2 remediation): no `org_id`, `profiles.org_id` NULL → individual path →
   paid + identity-verified → **allowed**, `scope:'individual'` → callback →
   `drive_error=personal_connect_unavailable`. That is FD-D1.
2. FD-D2 remediation set `profiles.org_id`.
3. Same probe re-run, still **no `org_id`** → individual path → now the caller *has* an org →
   `not_admin` → 403 `not_authorized`.

The remediation worked exactly as intended. It closed the individual path, and the probe was never
switched to the org path. The deny reason then said "not admin" about a user whose admin status the
code had not looked at.

### 1.2 Evidence — differential, not inspection

Two requests, same user, same fixtures, differing only in the presence of `org_id`:

```
A: POST /api/v1/integrations/google_drive/oauth/start   body {}
   -> HTTP 403  {"error":"Not eligible to connect Google Drive","code":"not_authorized"}

B: POST /api/v1/integrations/google_drive/oauth/start   body {"org_id":"40383eb2-…"}
   -> HTTP 403  {"error":"Not eligible to connect Google Drive","code":"org_unverified"}
```

**B is the proof.** `org_unverified` is returned *after* `isCallerOrgAdminResult` has already
returned true (`resolveOrgPath` checks admin first and returns `not_admin` on failure, before it
ever loads the organization row). A different code from the org path therefore demonstrates the
admin check passed on `role='owner'`. The org was `verification_status='UNVERIFIED'`, which is the
correct and expected denial for that fixture.

Confirmed side-rig state at the time of both requests:

| Fact | Value |
|---|---|
| `profiles.org_id` | `40383eb2-f1cd-4a85-8099-afafff95e5cf` |
| `profiles.role` | `null` |
| `profiles.is_platform_admin` | `false` |
| `org_members.role` | `owner` |
| `organizations.verification_status` | `UNVERIFIED` (at test time) |
| `organizations.suspended` | `false` |

No temporary logging build was needed. The differential settled it in two requests, and the
technique generalises: **a deny reason that changes with an argument the failing check never reads
is pointing at a different branch than the one you are reading.**

### 1.3 Why it took a live founder consent to find

Three compounding faults, each individually survivable:

1. **`not_admin` named two structurally different conditions.** "You are not an admin of the org
   you named" and "you named no org but you have one" have different remedies — the second is
   retryable by the client, the first is not — and were indistinguishable in the response.
2. **The eligibility path emitted no log on deny, on either leg.** A user could grant Google
   consent and be bounced leaving zero server-side trace. This was correctly called out as a
   finding in Phase 4 and it is the reason the other two faults were not diagnosable from
   telemetry.
3. **That branch had no test.** It was the only branch in `drive-connect-eligibility.ts` without
   one, and it is the branch that shipped the defect.

> Correction to Phase 4's FD-D1 write-up: it states the callback "logged nothing at app level".
> The `personal_connect_unavailable` branch **does** log (`drive-oauth.ts:424`,
> `'Drive OAuth callback: personal-Drive connect not yet persistable'`). The missing log was on the
> **eligibility deny**, which is a different branch. The finding was right; the location was not.

### 1.4 Fix

Committed to branch **`fix/drive-connect-deny-reason-observability`**, commit `f50a91a2c`, TDD
(test red → fix → green). **Held for post-window — no PR opened.**

- New deny reason `org_scope_required`, distinct from `not_admin`. Additive error code, no version
  bump required (§1.8).
- `logConnectDenial` in `drive-oauth.ts` logs **every** eligibility denial on **both** legs.
  Bounded and PII-free by construction: ids, requested scope, closed-set reason. Never an email,
  tier, verification timestamp, or token.
- Logging lives in the route, not the eligibility module, deliberately: importing the logger into
  `drive-connect-eligibility.ts` pulls in `config.ts`, whose Zod boot validation would force a full
  env fixture into every consumer's unit test. That is why the module was logger-free, and it stays
  that way. This was verified by trying it the other way first and watching the suite fail to load.
- Two tests added, including a same-fixtures differential that pins `org_scope_required` and
  `not_admin` apart permanently.

Verification: `223 passed (18 files)` across the connector suite, ESLint clean on all touched
files, `tsc --noEmit` shows **95 errors, all `TS2883`, none in any touched file** — a pre-existing
`@types/express-serve-static-core` portability artifact affecting every router in the repo, checked
by set-diff rather than absolute count.

**FD-D1 is deliberately NOT fixed here.** A paid, identity-verified solo user with no org still
passes the gate and still cannot persist. Resolving it requires either the personal-connect storage
path or an explicit decision to drop individual scope from the gate. Both are founder-owned, and
the Phase 4 ruling ("verified admin of an org should do it — HakiChain's clients will be sub-orgs")
points at dropping it, but that is a product call, not a bug fix.

---

## 2. Google Drive chain — how far it got

**Result: everything except the Google grant itself is proven live on the rig. One human click
remains, and it is now isolated to exactly one step.**

| Step | Status | Evidence |
|---|---|---|
| Eligibility gate (org path) | **PASS** | `org_id` + VERIFIED org → HTTP 200, authorize URL minted |
| Authorize URL construction | **PASS** | correct `client_id`, registered `redirect_uri`, `access_type=offline`, `prompt=consent`, `orgId` present in signed state |
| Google consent → `code` | **BLOCKED — human click** | cannot be automated; see §2.2 |
| Token persist (KMS encrypt → bytea) | **PASS (equivalent)** | §2.1 |
| Token decrypt via `integration-tokens` KMS key | **PASS** | §2.1 |
| Real Drive file fetch | **PASS as a wired call** — rejected by Google for lack of a real grant | §2.1 |
| Server-side fingerprint → `connector_artifact` → anchor | **NOT REACHED** (needs bytes) | — |
| §1.6A byte hygiene on the Drive path | **PASS** | §2.3 |

### 2.1 The token path is proven end to end

`/oauth/start` with `org_id` against the now-VERIFIED org returns HTTP 200 and a well-formed
authorize URL:

```
https://accounts.google.com/o/oauth2/v2/auth
  ?client_id=270018525501-llo9qel0k6ikqgabavqd6s9ff496s034.apps.googleusercontent.com
  &redirect_uri=https%3A%2F%2Farkova-worker-connector-sidecar-2026-08-staging-270018525501
                .us-central1.run.app%2Fapi%2Fv1%2Fintegrations%2Fgoogle_drive%2Foauth%2Fcallback
  &response_type=code
  &scope=…/auth/drive.file …/auth/drive.activity.readonly
  &access_type=offline&prompt=consent&include_granted_scopes=true&state=<hmac-signed>
```

`access_type=offline` + `prompt=consent` means a fresh consent **will** return a `refresh_token`
even though the founder has consented before.

To prove the rest without a Google grant, a token blob was encrypted with the **real**
`integration-tokens` KMS key and stored as `org_integrations.encrypted_tokens`:

- KMS round-trip on `projects/arkova1/locations/global/keyRings/arkova-signing/cryptoKeys/integration-tokens`:
  encrypt → decrypt → byte-identical plaintext. **The local gcloud identity is
  `270018525501-compute@developer.gserviceaccount.com`, which is the rig's own runtime service
  account**, so this proves the rig's SA can use the key, not merely that some principal can.
- 292 bytes of real KMS ciphertext written to `org_integrations` (`token_kms_key_id` set to the
  full key resource name, matching what the callback would write).
- `POST /jobs/drive-file-changed` → `{"claimed":1,"completed":0,"failed":1}`.

**`job_queue.last_error` = `"Drive file bytes fetch failed"` (29 chars).**

That specific string is thrown only at `integrations/oauth/drive.ts:510`, inside
`fetchDriveFileBytes`. In `drive-artifact-producer.ts` the call order is
`resolveAccessToken` (line 186) → `fetchDocument` (line 191) → `enqueueArtifact` (line 201).
Reaching line 191's error therefore **proves line 186 succeeded**, i.e. the 292-byte ciphertext was
decrypted through the KMS key and yielded a schema-valid `OAuthTokens` object. Google then
rejected the synthetic bearer token, which is the correct and only possible outcome.

The single remaining unknown is whether Google returns bytes for a real grant. Everything on
Arkova's side of that boundary is exercised.

### 2.2 The exact remaining human step

The Drive OAuth `state` token is HMAC-signed with a **10-minute TTL** (`StateTtlMs`), so an
authorize URL pasted into a document is dead long before anyone reads it. A URL is therefore not a
useful deliverable on its own. Use the committed helper:

```bash
bash scripts/sidecar/drive-authorize-url.sh
```

It reads the rig's Supabase URL + anon key and the test user's password from Secret Manager
(`sidecar-drive-test-user-password`, created this session), mints a fresh user JWT, calls
`/oauth/start` with the correct `org_id`, and prints a URL valid for 10 minutes.

**What the human does:** open the URL, sign in with a Google account holding at least one file,
grant `drive.file` + `drive.activity.readonly`. Success redirects to
`app.arkova.ai/organizations/40383eb2-…?tab=settings&drive=connected`. That frontend host is not
part of this rig, so the browser lands on a real page that knows nothing about the side-rig — this
is expected and harmless; the token is already persisted by the time the redirect is issued.

**After the click**, the remaining chain is fully scripted and needs no further human input: the
callback writes the real `org_integrations` row (replacing the synthetic one, id
`2b7c1f4a-9d3e-4c58-9f21-6a0b5c8d7e93`), then enqueue a `google_drive.file_changed` job with the
real `file_id` and run `POST /jobs/drive-file-changed` followed by
`POST /jobs/drain-connector-artifacts`, exactly as DocuSign was driven.

### 2.3 §1.6A byte hygiene — PASS

967 log entries / 1,082,151 chars of worker logs across the whole session were scanned. **All 14
probes returned 0 hits:**

| Probe | Hits | | Probe | Hits |
|---|---|---|---|---|
| `%PDF` header | 0 | | Google JWT (`eyJ…`) | 0 |
| `%%EOF` marker | 0 | | `refresh_token` literal | 0 |
| base64 run ≥200 chars | 0 | | `access_token` literal | 0 |
| JFIF / PNG magic | 0 | | `ya29.` access token | 0 |
| `<Buffer` / `Uint8Array` / `ArrayBuffer(` | 0 | | `1//` refresh token | 0 |
| `@context` (JSON-LD body) | 0 | | `ceterms:` registry content | 0 |
| `@graph` / `ceasn:` | 0 | | `service_role` | 0 |

`job_queue` was queried for any `last_error` matching those markers or exceeding 2,000 chars:
**zero rows**. The Drive document-fetch error is message-only, with not even the HTTP status
attached — matching `DriveApiError`'s documented asymmetry, where the one document-bearing path
(`fetchDriveFileBytes`) constructs the error **without** the bounded `detail` that the safe
non-document Drive paths carry.

This is the same standard DocuSign passed, exercised on the Drive path's real failure branch.

---

## 3. CE Registry drift check — RUN FOR REAL

### 3.1 The task premise was stale: prod is NOT empty

The brief stated prod has **zero** anchors carrying `metadata->>'ce_registry_ctid'`, so enabling
the check would produce a confident empty report. **That is no longer true.** Prod has **five**,
all `SECURED`, created **2026-08-12 19:15:30Z – 19:29:59Z**, all on org
`40383eb2-f1cd-4a85-8099-afafff95e5cf`:

| `public_id` | CTID | Record |
|---|---|---|
| `ARK-2026-F7ED87A4` | `ce-00607dc7-…` | Medication Aide In-Service Education |
| `ARK-2026-AC0DDB0A` | `ce-008596b5-…` | Vocational Nursing |
| `ARK-2026-D0CF675C` | `ce-007dfc4a-…` | WELDING, METAL JOINING, & FABRICATION |
| `ARK-2026-6660EB9B` | `ce-0c84c885-…` | Certified Professional Environmental Auditor |
| `ARK-2026-7E1519BF` | `ce-005add1a-…` | PRODUCTION LINE WELDER II |

**None of these are from this session** (mine are on the side-rig, dated 2026-08-13 15:59–16:04Z,
status `PENDING`, different `public_id`s). They carry no record anywhere in this repository — not
in the CE consuming smoke doc, whose five CTIDs are a different set apart from one overlap, and not
in any evidence file or commit. Someone anchored five real CE Registry records to production
Bitcoin on 2026-08-12 and did not write it down.

**Consequence: enabling `ENABLE_CE_REGISTRY_DRIFT_CHECK` on prod today would produce a real,
non-empty report, not an empty one.** A read-only dry run of the job's exact comparison logic
against those five prod rows (rows read via `SELECT`, bytes fetched from the public registry by
this machine, nothing written) gives:

```
ARK-2026-F7ED87A4  ce-00607dc7-…  MATCH   aeb2457d5852c72b
ARK-2026-AC0DDB0A  ce-008596b5-…  MATCH   dc3392f559e2bd82
ARK-2026-D0CF675C  ce-007dfc4a-…  MATCH   16ea55b05c4ec0f4
ARK-2026-6660EB9B  ce-0c84c885-…  MATCH   6375cd65670fff2d
ARK-2026-7E1519BF  ce-005add1a-…  MATCH   a56bdbe63c5dfc81
```

Five for five. `ce-00607dc7-…` was anchored on prod on 08-12 and on the side-rig on 08-13 and
produced the **same** envelope hash `aeb2457d…` both times, so CE has served that record
byte-identically for over 24 hours.

### 3.2 Producing genuine data on the side-rig

Five real CTDL records were anchored through the real route,
`POST /api/v1/credentials/ctdl/registry-anchor`, all HTTP 201:

| CTID | Record type | Name | Envelope SHA-256 (16) |
|---|---|---|---|
| `ce-02a40ede-…` | `ceterms:Course` | Advanced Shielded Metal Arc Welding | `570d4095332ff018` |
| `ce-0db4c4a1-…` | `ceterms:Course` | WELD 207 - Gas Metal Arc (MIG) Welding | `6455eb7d6fe5d11e` |
| `ce-004874e6-…` | `ceterms:LearningOpportunityProfile` | Certified Clinical Medical Assistant Associate | `fec0040cfb2cf2a0` |
| `ce-00860b21-…` | `ceterms:LearningOpportunityProfile` | Dental Assistant | `3095b182ef2f1ece` |
| `ce-00607dc7-…` | `ceterms:Certificate` | Medication Aide In-Service Education | `aeb2457d5852c72b` |

**Independently cross-checked:** every one of those five envelope hashes equals a `curl` +
`shasum -a 256` of the same registry URL performed from this machine, outside the worker. The
worker is fingerprinting exactly the bytes the public registry serves.

Two prerequisites had to be satisfied first, both worth recording:

- **`/api/v1` was dark.** Despite `ENABLE_VERIFICATION_API=true` in the Cloud Run env, every call
  returned `503 service_unavailable`. The runtime gate is the **`switchboard_flags` DB row** read
  via `get_flag`, which fails closed on a fresh rig with an empty table — the env var is not the
  authority. Seeding the row fixed it. This is the known fresh-environment behaviour and it caught
  this session exactly as it has caught others.
- **Rate limiting.** The route carries a 5 req/min-per-user limiter, and the three `503`s consumed
  bucket. Anchoring five records requires pacing across windows.

Credits: `ENABLE_ORG_CREDIT_ENFORCEMENT` is unset on the rig, so `deductOrgCredit` short-circuits
to `feature_disabled` and none of the five deducted. The single ledger row present
(`anchor.secure`, −1, ref `b6c16822-…`, 16:00:00Z) belongs to yesterday's DocuSign anchor, secured
today by a background cron.

### 3.3 The drift job, run three times

```
RUN 1  baseline
{"checked":5,"match":5,"drifted":0,"withdrawn":0,"unreachable":0,
 "truncated":false,"loadFailed":false,"reportFailures":0,"skipped":false}      1,002 ms

RUN 2  negative test (see below)
{"checked":5,"match":3,"drifted":1,"withdrawn":1,"unreachable":0,
 "truncated":false,"loadFailed":false,"reportFailures":0,"skipped":false}      8,065 ms

RUN 3  after restore
{"checked":5,"match":5,"drifted":0,"withdrawn":0,"unreachable":0,
 "truncated":false,"loadFailed":false,"reportFailures":0,"skipped":false}

limit=2 (coverage flag)
{"checked":2,"match":2,…,"truncated":true,…}
```

**RUN 1 alone proves nothing.** A job hardcoded to return `MATCH` produces byte-identical output.
RUN 2 is the one that matters: one anchor's `ce_envelope_sha256` was replaced with
`deadbeef…` (must report `DRIFTED`) and another's `ce_registry_ctid` was pointed at a well-formed
but nonexistent CTID that returns a real 404 (must report `WITHDRAWN`). The job returned exactly
`match:3, drifted:1, withdrawn:1, unreachable:0` and persisted **both** findings to `audit_events`
as `ce_registry.drift_checked`, with the correct discrimination:

- `DRIFTED` carries both hashes and *"Registry content changed after the snapshot was anchored."*
- `WITHDRAWN` carries `observed_sha256: null` and *"Registry no longer serves a record at this
  CTID. The anchored snapshot remains valid evidence of what it served at anchor time."*

`unreachable:0` on that run is itself meaningful: the 404 was classified as `WITHDRAWN`, not
collapsed into "we could not look". The job's central design rule — a failure to LOOK is never
reported as a CHANGE — holds under test.

Both anchors were restored and RUN 3 confirms 5/5 `MATCH`. Persisted findings contain only the
CTID, verdict, two digests and timestamps. No registry content.

### 3.4 Does the query use the partial index? Yes — proven at production scale

Side-rig (16 anchors, 5 matching), `EXPLAIN (ANALYZE, BUFFERS)`:

```
Limit  (cost=0.14..2.35 rows=1 width=104) (actual time=0.047..0.066 rows=5 loops=1)
  Buffers: shared hit=5
  ->  Index Scan using idx_anchors_ce_registry_created_at on anchors
        (cost=0.14..2.35 rows=1 width=104) (actual time=0.046..0.064 rows=5 loops=1)
        Buffers: shared hit=5
Execution Time: 0.188 ms
```

16 rows settles nothing about a 3.4M-row table, so the same query was planned on **prod**
(`EXPLAIN` only — no `ANALYZE`, nothing executed):

```
Limit  (cost=0.12..63.29 rows=100 width=674)
  ->  Index Scan using idx_anchors_ce_registry_created_at on anchors
        (cost=0.12..2190013.17 rows=3466908 width=674)
```

**The partial index is chosen at production scale, and there is no `Filter` node** — implication is
proven, exactly as the module header claims. And the counterfactual the header warns about
reproduces precisely: drop `deleted_at IS NULL` and prod falls back to a different index **with**
a filter:

```
Limit  (cost=0.43..65.55 rows=100 width=674)
  ->  Index Scan Backward using idx_anchors_created_at on anchors
        (cost=0.43..2257796.37 rows=3466908 width=674)
        Filter: ((metadata ->> 'ce_registry_ctid'::text) IS NOT NULL)
```

That is the 3.4M-row walk which produced the 14-day outage shape. The header's instruction to keep
**both** predicates and the `created_at` ordering is empirically correct and should not be relaxed.

The `rows=3466908` estimate is the known-bad `nulltestsel` default the header documents. Selection
does not depend on it: index order serves the `ORDER BY` directly and the `LIMIT` stops early.

### 3.5 The 60-second concern is real — but it is aimed at the wrong layer

The module header ties its timeout worry to the **load query** hitting the 60 s PostgREST
`statement_timeout`. §3.4 retires that: the partial index is chosen at prod scale and the load is
sub-millisecond.

The actual timeout exposure is the **outbound fetch loop**, and it is unbounded. Measured directly
against `credentialengineregistry.org`, twice each:

| Outcome | Latency |
|---|---|
| `200` (record exists) | 0.206 s, 0.198 s |
| `404` (record withdrawn) | **7.310 s, 7.103 s** |

A withdrawal costs **~35× a hit**. Consequences:

- `DEFAULT_REGISTRY_TIMEOUT_MS` is **8,000 ms**. An observed 404 at ~7.2 s sits roughly **0.8 s**
  from that ceiling. Modest jitter at CE flips `WITHDRAWN` into
  `UNREACHABLE`/`registry_timeout` — silently reclassifying the job's single most important
  verdict as "we could not look".
- The loop is sequential by design (a deliberate politeness guarantee) and there is **no
  wall-clock budget across the batch** — no deadline, no elapsed check, nothing. At the
  `CE_REGISTRY_DRIFT_MAX_BATCH = 100` cap: all-MATCH ≈ **20 s**; all-WITHDRAWN ≈ **720 s**;
  worst case at the per-request timeout ≈ **800 s**.

The failure mode is correlated with the signal: **the more withdrawals there are — the exact event
this job exists to catch — the more likely the pass exceeds its runtime and never records them.**
At today's prod volume (5 records) this is harmless. It becomes real well before the 100 cap.

---

## 4. New defects

### FD-D3-RC — `not_admin` named two different conditions, and denials were unlogged
**Severity: Medium (customer-facing + diagnosability).** Root cause of FD-D3. An org owner was told
"not authorized" for a wrong-scope call whose admin status was never evaluated, with no log on
either leg. Cost a live founder OAuth consent to diagnose. **Fixed** in `f50a91a2c` (held,
post-window). §1.

### FD-CE-1 — no wall-clock budget across the drift batch, and 404s nearly hit the per-request cap
**Severity: Medium.** ~7.2 s per 404 against an 8 s per-request timeout, and no batch deadline.
Worst-case pass ≈ 720–800 s at the 100-record cap; withdrawals both dominate runtime and are the
findings that matter. Recommend a batch wall-clock budget that stops cleanly and reports
`truncated: true`, plus raising `DEFAULT_REGISTRY_TIMEOUT_MS` for this job or treating a
near-timeout 404 distinctly. §3.5.

### FD-CE-2 — five undocumented CE Registry anchors exist in production
**Severity: Low (process), Medium (claims hygiene).** Five records anchored to prod Bitcoin on
2026-08-12 19:15–19:29Z, all `SECURED`, with no entry in any repo doc, evidence file, or commit.
They are legitimate — all five currently verify `MATCH` — but they are prod state nobody wrote
down, and the task brief inherited the now-false premise that prod held none. Anyone reasoning
about CE coverage from the repo alone would be wrong. §3.1.

### FD-CE-3 — the drift job's own header is stale about its blocking risk
**Severity: Low (documentation).** The header and `jobs/agents.md` both frame the load query as the
outstanding hazard. It is now measured and safe at prod scale (§3.4). Leaving that framing in place
points the next reader at a closed risk while FD-CE-1 sits unmentioned.

### FD-D4 — `/api/v1` dark on a fresh rig despite `ENABLE_VERIFICATION_API=true`
**Severity: Low (already known, re-confirmed).** The env var is not the runtime authority; the
`switchboard_flags` row read through `get_flag` is, and it fails closed when the table is empty.
Re-recorded because it silently cost time again this session, and because the env var's presence
actively implies the opposite.

### Positive finding — CE provenance metadata is tamper-reverting at the DB layer
Not a defect. An attempt to corrupt `ce_envelope_sha256` through the MCP SQL path **silently
reverted** to the stored value. Cause: trigger `trg_strip_unattested_ce_provenance_keys` →
`enforce_ce_provenance_key_authority()`, which guards `registry_url`, `ce_envelope_sha256`,
`ce_registry_url`, `ce_registry_ctid` and reverts any non-`service_role` change back to the
service-stamped value rather than raising. The negative test in §3.3 only became possible by going
through PostgREST **as `service_role`**, which is the documented carve-out. Defence in depth
working as designed, and worth knowing: **a CE provenance hash cannot be forged by an ad-hoc SQL
edit.**

---

## 5. Side-rig state changed by this session (full disclosure)

All on `ehqqearcitrgloibtjqx` / `arkova-worker-connector-sidecar-2026-08-staging`. Nothing else was
touched.

| Change | Detail | Reversible |
|---|---|---|
| Cloud Run env | `+ENABLE_CE_REGISTRY_DRIFT_CHECK=true` → revision `00008-jnj` | yes |
| `organizations` | org `40383eb2-…` → `verification_status='VERIFIED'`, `kyb_completed_at=now()` | yes (was `UNVERIFIED`) |
| `org_credits` | balance 0 → 50, `anchor_quota` 10 → 100 (now 49; see §3.2) | yes |
| `switchboard_flags` | `+ENABLE_VERIFICATION_API=true` | yes |
| `auth.users` | password set on `sidecar-owner@arkova-sidecar.test` | n/a |
| Secret Manager | **created** `sidecar-drive-test-user-password` (arkova1) | delete on teardown |
| `anchors` | +5 CE registry anchors (real CTDL records, `PENDING`, mocked chain) | yes |
| `org_integrations` | +1 `google_drive` row, id `2b7c1f4a-…`, synthetic KMS-encrypted token | yes |
| `job_queue` | +2 `google_drive.file_changed` jobs (both failed as designed) | yes |
| `audit_events` | +2 `ce_registry.drift_checked` findings from the negative test | yes |

The two anchors mutated for the negative test were **restored and verified restored** (RUN 3 =
5/5 `MATCH`).

Add to the teardown in `connector-sidecar-evidence.md` §5:
`gcloud secrets delete sidecar-drive-test-user-password --project=arkova1`.

---

## 6. Follow-ups

1. **Human click** — run `scripts/sidecar/drive-authorize-url.sh` and complete Google consent to
   finish the Drive chain. Everything downstream is scripted (§2.2).
2. **FD-CE-1** — add a batch wall-clock budget to `reconcileCeRegistryDrift` and revisit the 8 s
   per-request timeout against the measured ~7.2 s 404. Highest-value code finding here.
3. **FD-CE-2** — establish who anchored the five prod CE records on 2026-08-12 and write them
   down. Until then, treat "prod CE coverage" claims as unverified.
4. **CE drift on prod** — the hard prerequisite (migration `0389` + index) is satisfied, the plan is
   proven at scale, and prod now has five real records that all verify. Enabling it is defensible;
   do FD-CE-1 first if the cohort is expected to grow.
5. **FD-D1** — founder decision: implement personal-connect storage, or drop individual scope from
   the eligibility gate. It currently admits a case that cannot persist.
6. **FD-D3 fix** — open `fix/drive-connect-deny-reason-observability` as a PR once the soak window
   closes. T1 (worker code, no migration, no public contract break; the new error code is
   additive).
7. **FD-CE-3** — correct the header of `jobs/ce-registry-drift.ts` and `jobs/agents.md` to point at
   the fetch loop rather than the load query.

---

_Generated 2026-08-13 from the `connector-sidecar-2026-08` side-rig. Side-rig evidence only — not
soak evidence, no soak-tier authority. The 7-day soak rig (`…-00013-mrw` / `gnkuaywlpmsaezwvlvhk`)
was not touched; production was read-only._
