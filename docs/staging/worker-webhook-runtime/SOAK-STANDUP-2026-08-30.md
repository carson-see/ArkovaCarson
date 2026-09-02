# worker-webhook-runtime — T3 soak stand-up (2026-08-30)

Internal engineering note. Canonical status is Jira; canonical documentation is Confluence.

**Bottom line:** the batch was briefed as 10 PRs. The image actually serving the rig contains
**7** of them, and of those 7 only **4** have a changed behavior that can be exercised on this
rig. Four PRs carry real, merge-grade-shaped T3 evidence; six do not, each for a specific and
verified reason. No evidence was written for a PR whose behavior was not actually driven.

---

## 1. Rig (reconstructed — the provisioning session died before recording it)

| Field | Value |
|---|---|
| Supabase project ref | `sawvgrwhgsmxjlwhpsyx` (isolated) |
| Cloud Run service | `arkova-worker-soak-worker-webhook-runtime-staging` (`arkova1`, `us-central1`) |
| URL | `https://arkova-worker-soak-worker-webhook-runtime-staging-kvojbeutfa-uc.a.run.app` |
| Serving revision | `…-00002-krl`, `createTime` **2026-08-30T22:22:53.313337Z** |
| Image digest | `sha256:11d82631860f9a43d2690bd930a5b860ce3f0a3e0a3cf5415ce12ef32d5cc8e2` |
| Cloud Build | `c7c999b7-7ef7-47ee-b093-7e7940aadb84` (SUCCESS, 3m26s) |
| Integration branch | `soak/wwr-2026-08-30b` @ `706dd11c33192b00a53150ba576fca5b32be1e53` |
| `/health` | `healthy`, `git_sha` matches, `network: signet`, db/anchoring/kms all `ok` |
| Soak window | **2026-08-30T22:22:53Z → 2026-09-01T22:22:53Z** (clock = revision uptime) |

Rig env of note: `USE_MOCKS=true`, `ENABLE_PROD_NETWORK_ANCHORING=false`,
`BITCOIN_UTXO_PROVIDER=getblock`, `BITCOIN_NETWORK=signet`. `ENABLE_DOCUSIGN_WEBHOOK` is
**unset** — this turns out to matter (§4).

The service is `--no-allow-unauthenticated`. Because the worker reads its own Supabase JWT from
`Authorization`, IAM must be passed as **`X-Serverless-Authorization`** or every
authenticated app route returns 401. This is not written down anywhere else.

### Preflight — clean, and it genuinely preceded load

`scripts/ci/staging-honesty-preflight.ts` against `sawvgrwhgsmxjlwhpsyx`:

```
environment_type = clean_mirror     timestamp 2026-08-30T22:22:31.815Z     7/7 checks passed
```

That timestamp is **22 seconds before** the serving revision's `createTime`, so it is a true
pre-load preflight, not a retro-fit. Baseline it recorded: 1 org, 1 profile, 3 anchors,
0 rule events, ledger reconciling with repo migrations + canonical baseline.

---

## 2. Coverage reality: 7 of 10 PRs are in the image

`git merge-base --is-ancestor` against `706dd11c3`, cross-checked by reverse-applying each PR's
own `base...head` patch to the soaked tree:

| PR | In image? | Evidence |
|---|---|---|
| #2499 | yes | **PROVEN** |
| #2496 | yes | blocked — pre-existing defect (§4) |
| #2486 | yes | **PROVEN** |
| #2474 | yes (old head) | not soaked — head drift + flag off (§4) |
| #2441 | yes | **PROVEN** |
| #2436 | yes | **PROVEN** |
| #2434 | yes | not soaked — edge runtime, not this rig (§4) |
| #2437 | **NO** | conflicts on `_org-auth.ts`; left out of the integration branch |
| #2485 | **NO** | conflicts with #2474 on `docusign.test.ts` |
| #2489 | **NO** | stacked on `feat/docusign-inbound-recipient-connect`; 6-file conflict |

The three missing PRs were re-merge-tested in a scratch worktree; all three still conflict, so
they were not hand-resolved. A hand-resolved merge is nobody's head, and §1.11A forbids
producing evidence against a tree that matches no PR head.

---

## 3. What was actually proven (4 PRs)

Driver: `scripts/staging/targeted/wwr-batch-driver.mjs` (see §6 — not yet landed).
First full cycle: **16/16 requests OK, 0 failures, 15/15 behavioral assertions PASS.**

### #2499 — declared-hash must not claim "Measured"
Two anchors differing only by `metadata.connector_artifact_id`:

```
wwr-fetched-0001  -> fingerprint_rederivability = "fetch_time_snapshot"
                     fingerprint_rederivability_note = "Measured: …"
wwr-declared-0001 -> BOTH fields absent
```

**Trap worth recording:** `proof_availability_note` legitimately begins `"Measured:"` on *every*
record. A body-substring assertion (`!body.includes('Measured:')`) — which the abandoned draft
driver used — fails 100% of the time for the wrong reason. The assertion must be field-wise.

### #2441 — per-limiter bucket scoping restores §1.10
Same IP, same cycle, two limiters:

```
POST /api/v1/verify/batch      -> 429  Retry-After: 60   X-RateLimit-Limit: 10
GET  /api/v1/verify/{id}       -> 200                    X-RateLimit-Limit: 100
```

Two different caps from two different buckets is the whole fix — pre-fix they shared one
bare-per-IP `Map` entry. A dedicated burst probe put the public-verify first-429 at **request
#99 of 100** in a 15.4s window (`Retry-After: 12`); pre-fix this surface first-429'd at ~#31.
Worker log confirms the scoped key `v1-verify-anon:<ip>` with `maxRequests: 100`.

### #2436 — GetBlock token must not reach the logs
`/jobs/refresh-treasury-cache` does **not** exercise this: `treasury-cache.ts` hardcodes
`type:'mempool'`. `confirmation-proof-backfill` always returns `{skipped:true}` under
`USE_MOCKS`. The GetBlock branch is reached only via `GET /api/treasury/status`. Once driven:

```json
{"msg":"Creating GetBlock hybrid UTXO provider","provider":"getblock",
 "rpcOrigin":"https://go.getblock.io","mempoolBaseUrl":"https://mempool.space/signet/api"}
```

Sweep of the service's full log history: the 33-char GetBlock access token appears **0 times**,
`"rpcUrl"` keys **0 times**, `"rpcOrigin"` present. A real signet RPC error line
(`RPC listunspent failed: HTTP 404`) also carries no token, which additionally exercises
`sanitizeRpcUrlForError` on the error path. Re-swept every 30 minutes to soak close
(`evidence/log-sweep.jsonl`).

### #2486 — declared-hash anchors get `fingerprint_source = NULL`
Seed one `organization_rule_executions` row → `POST /jobs/rule-action-dispatcher` →

```
dispatcher: {"dispatched":1,"succeeded":1,"failed":0}
execution : SUCCEEDED, outcome=queued_for_anchor, routed_to=anchor_queue
anchor    : ARK-DOC-AE75WA
            fingerprint_source            = null          <- typed column
            metadata.fingerprint_source   = "payload.document_sha256"  <- free-text label
```

The two same-named fields staying distinct is exactly the PR's point.
**Trap:** `vendor` must NOT be `docusign` — that defers to the connector pipeline and
materializes no anchor at all, while still reporting `SUCCEEDED`.

---

## 4. What could NOT be proven, and why

### #2496 — blocked by a pre-existing defect on `main`
Driving a real HMAC-signed max-cardinality Adobe Sign webhook (100 documents × 500-char ids,
**53,662-byte body** — exactly the ~50KB case this PR fixes) got past HMAC verification and then:

```
42703  column org_integrations.webhook_id does not exist
   -> integration_lookup_failed -> webhook_dlq row -> HTTP 500
   -> 0 organization_rule_events rows written
```

`services/worker/src/api/v1/webhooks/adobe-sign.ts` selects and filters
`org_integrations.webhook_id`, **a column no migration in this repo creates** — absent from the
canonical baseline and from every `NNNN_*.sql`. The same code is on `origin/main`.

**This means the Adobe Sign webhook is non-functional on any environment whose
`org_integrations` matches the repo migrations.** It is not caused by #2496; #2496's fix simply
sits downstream of the break, so its 16KB CHECK path is unreachable end-to-end. Needs its own
bug ticket and a migration.

### #2474 — head drift + flag off
Soaked image contains `877a553dbcd4…`; the PR now points at `d570e1edeeaf…`. Independently,
`POST /webhooks/docusign` returns `503 integration_disabled` because `ENABLE_DOCUSIGN_WEBHOOK`
is unset on this rig, so `extractSigners` never runs. The job-side path is also unreachable —
`/jobs/docusign-envelope-completed` drains cleanly but the rig has no DocuSign OAuth `base_uri`
or refresh-token secret, so `reValidateSigners` is never reached. Turning the flag on requires a
new revision, which would restart the batch's T3 clock.

### #2434 — wrong runtime
`services/edge/` only. That is the Cloudflare Worker (`edge.arkova.ai`, deployed via
`wrangler`); this Cloud Run rig does not run it. Nothing in this window touches the
`oracle_batch_verify` change. Needs edge-runtime evidence of its own.

### #2437 / #2485 / #2489 — not in the image
See §2.

---

## 5. Open decisions for the CTO

1. **Restart the clock to pick up more PRs?** Enabling `ENABLE_DOCUSIGN_WEBHOOK` and/or
   re-cutting the integration head to include #2437/#2485/#2489 both require a new revision,
   which restarts the 48h window (currently ~2h in). Not done unilaterally.
2. **`org_integrations.webhook_id` is missing on `main`** — needs a migration and a bug-tracker
   row before #2496 (or the Adobe Sign path at all) can be soaked.
3. **#2489 is stacked on a non-`main` base.** It cannot join a main-based batch head until its
   base lands.

## 6. Artifacts and the driver

Evidence lives outside the repo in the soak session's scratchpad:
`wwr/evidence/wwr-soak-evidence.json` (per-cycle counts + assertions, flushed every cycle) and
`wwr/evidence/log-sweep.jsonl` (30-minute GetBlock token sweeps).

`wwr-batch-driver.mjs` is deliberately **not** included in this PR: the
`scripts/staging/targeted/` folder contract requires a matching `*-driver.test.ts` for every
driver, and this one is `.mjs` with no test. It should be ported to `.ts` with a red-first test
before it lands, rather than being smuggled in with a docs change.

_Last refreshed: 2026-08-31 by carson — rig facts verified against gcloud/PostgREST/Cloud Logging output in-session._
