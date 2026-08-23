# Gap closure — edge MCP tools, Playwright E2E, Upstash distributed rate limiting

**Run date:** 2026-08-13 · **Soak:** FULLSOAK 2026-08 (7-day SOC2 window, 08-12T15:51:30Z → 08-19)

Three named coverage gaps in the running soak, closed empirically. Every result below
comes from a live run against real infrastructure; nothing is inferred from source.

## Isolation

The 7-day soak rig was **not touched by any mutating operation**. All writes went to a
separate side-rig:

| Role | Resource |
|---|---|
| Soak rig (read-only probes only) | Cloud Run `arkova-worker-fullsoak-2026-08-staging` rev `00013-mrw` · Supabase `gnkuaywlpmsaezwvlvhk` |
| Production (read-only queries only) | Cloud Run `arkova-worker` · Supabase `vzwyaatejekddvltxyye` |
| **Side-rig (all mutations)** | Cloud Run `arkova-worker-connector-sidecar-2026-08-staging` · Supabase `ehqqearcitrgloibtjqx` (migration head `0409`) |

Side-rig changes made for this work, and how to revert them:

* `min-instances` 0 → **2**, `max-instances` 2 (needed to hold two live instances for GAP 3).
  Revert: `gcloud run services update arkova-worker-connector-sidecar-2026-08-staging --region us-central1 --min-instances=0`.
* Seeded `private.api_key_settings.hmac_secret` (set equal to the worker's
  `api-key-hmac-secret-staging` so the edge RPC path and the worker middleware agree),
  one `api_keys` row named `SCRUM-3140 side-rig MCP probe`, one `agents` row
  `scrum3140-probe-agent`, one `switchboard_flags` row `ENABLE_MCP_SERVER=true`.
* The probe key is in Secret Manager as `arkova-sidecar-2026-08-apikey-mcp-probe`.
* `anchor_document` probe rows land in `public_records` tagged `source='soak_probe'`.

Soak rig verified untouched at the end of this work: `arkova-worker-fullsoak-2026-08-staging`
still serves 100% traffic on revision `…-00013-mrw`, created `2026-08-12T15:09:42Z`, last
service modification `2026-08-12T15:10:07Z` — i.e. no revision, no traffic split and no
config change since the soak began.

Result summary:

| Gap | Assertions | Pass | Fail | Defects found |
|---|---|---|---|---|
| **1 — edge MCP (16 tools)** | 28 assertions | 22 | 6 | 6 (one of them a production SOC2 finding) |
| **2 — Playwright E2E (46 specs)** | 346 tests | 334 | 11 (+1 did-not-run) | 3, one of which hollows the G4 / CC6.1 isolation evidence |
| **3 — Upstash rate limiting** | 4 probes | 4 | 0 | 2 (SCRUM-3139 confirmed + a namespacing residual) |

Eleven defects total; **three of them are new and previously unrecorded**
(D-3, D-4, D-6 in GAP 1), plus all three E-series defects in GAP 2 and the namespacing
residual D-8 in GAP 3. Two are severe enough to act on before the soak closes: **D-4**
(the MCP surface has never written an audit row, in production, for two and a half
months) and **E-1** (the browser-level tenant-isolation evidence is both failing and,
where it passes, no longer trustworthy). **D-7 / SCRUM-3139 is confirmed and PR #2223
fixes it** — demonstrated head-to-head, not reviewed.

---

## GAP 1 — the 16 edge MCP tools

**Deliverable:** `scripts/staging/fullsoak-mcp-probe.sh` (new).
**Evidence:** `docs/staging/evidence/fullsoak-2026-08/2026-08-13/mcp-probe-2026-08-13T162000Z.md`.

### 1.0 First finding: the deployed MCP surface cannot be driven with soak credentials

The Day-0 key `arkova-fullsoak-2026-08-apikey-soak-mcp` (prefix `ak_live_2a54…`, 72 chars)
is **rejected** by `edge.arkova.ai`:

```
POST https://edge.arkova.ai/mcp   (X-API-Key: ak_live_2a54…)
HTTP/2 401
www-authenticate: Bearer realm="arkova-mcp", resource_metadata="https://edge.arkova.ai/mcp/.well-known/oauth-protected-resource"
{"error":"Unauthorized","message":"Valid API key (X-API-Key header) or OAuth Bearer token required."}
```

Root cause: the deployed Cloudflare Worker's `SUPABASE_URL` is the **production** project,
and `validateApiKey()` (`services/edge/src/mcp-server.ts:775`) delegates entirely to the
prod `validate_api_key` RPC. The soak key lives in the soak rig's DB. There is therefore
**no way to exercise the deployed MCP surface with soak-grade credentials**, and doing it
with a production key would put `anchor_document` writes into the prod ledger.

So the probe drives the **same edge source** under `wrangler dev`, bound to the side-rig —
identical auth path, identical handlers, writable fixtures. `tools/list` returns exactly
**16** tools there, matching the runbook's S12 list. Against `edge.arkova.ai` the script
still runs the auth-negative and reachability legs (`--remote`) and skips the tool calls.

Confirmed live on `edge.arkova.ai` (unauthenticated / read-only):

| Probe | Result |
|---|---|
| `POST /mcp` no credential | **401** |
| `POST /mcp` invalid `X-API-Key` | **401** |
| `GET /mcp/.well-known/oauth-protected-resource` | 200, well-formed RFC 9728 |
| `scopes_supported` | `["mcp:verify","mcp:search"]` — i.e. `MCP_ENABLE_ANCHOR_DOCUMENT` is **not** `true` in prod, so prod serves 15 of 16 tools |

### 1.1 Per-tool results (side-rig, all 16 driven)

Fixture resolved live from the rig: anchor `ARK-PAT-Z65SKJ`
(`Patent_Application_AI_Method.pdf`, SECURED), org `tc2z6b72takv`, agent
`scrum3140-probe-agent`. No assertion is "HTTP 200" — each names the row it must return
or the row-count delta it must produce.

| id | tool | assertion | result |
|---|---|---|---|
| T-00 | `tools/list` | advertises exactly 16 tools | PASS |
| T-01 | `verify_credential` | returns `verified=true` for that exact `public_id` | PASS |
| T-02 | `search_credentials` | returns `ARK-PAT-Z65SKJ` and labels `search_mode` | PASS |
| T-03 | `search` | `type=record` returns `ARK-PAT-Z65SKJ` | PASS |
| T-04 | `verify` | fingerprint resolves to that `public_id` | PASS |
| T-05 | `list_orgs` | contains the caller's own org `tc2z6b72takv` | PASS |
| T-06 | `get_anchor` | returns a lifecycle status + `anchor_timestamp` | PASS |
| T-07 | `get_organization` | returns that org's `display_name` | PASS |
| T-08 | `get_record` | returns that record | PASS |
| T-09 | `get_fingerprint` | hash resolves to that `public_id` | PASS |
| T-10 | `get_document` | returns that document | PASS |
| T-11 | `nessie_query` (retrieval) | well-formed retrieval envelope | PASS |
| T-12 | `nessie_query` (context) | **fails CLOSED for a disabled capability** | **FAIL — D-2** |
| T-13 | `anchor_document` | `public_records` rows for that exact `content_hash` 0 → 1 | PASS |
| T-14 | `verify_document` | resolves the fingerprint `anchor_document` just accepted | **FAIL — D-3** |
| T-15 | `verify_document` | seeded hash resolves to `ARK-PAT-Z65SKJ` | PASS |
| T-16 | `verify_batch` | 2 results: seeded id verified, bogus id not | PASS |
| T-17 | `oracle_batch_verify` | envelope with an explicit signing state | PASS |
| T-18 | `list_agents` | returns the caller-org agent | PASS |
| N-01..N-05 | auth | metadata well-formed; no-key / bad-key / empty-key / bad-bearer all 401 | PASS ×5 |
| A-3.1b-i | claims | `search_credentials` is not substring matching | **FAIL — D-1** |
| A-3.1b-ii | claims | a semantic paraphrase returns >0 results | **FAIL — D-1** |
| SEC-06 | audit | `audit_events` `MCP_TOOL_CALL` rows increase across the run | **FAIL — D-4** |
| S-17 | reachability | `/.well-known/arkova-keys.json` serves 200 + key material | **FAIL — D-5** |

**22 pass · 6 fail · 0 skip.** All six failures are real defects, not harness problems.

### D-1 — `search_credentials` is literal `ILIKE %query%` while it advertises itself as semantic

CONFIRMED, and root-caused past the code reading.

The semantic path is attempted first (`searchCredentialsWorkerSemantic`, forwarding the
caller's key to the worker). The worker answers:

```
GET {worker}/api/v1/verify/search?q=License&limit=3   (X-API-Key: <probe key>)
HTTP 503
{"error":"service_unavailable","message":"Semantic search is not currently enabled"}
```

so the edge degrades to the lexical path (`wrangler` log:
`[search_credentials] worker semantic proxy HTTP 503; falling back to lexical search`).

Two probes prove the fallback is character matching, not similarity:

* **A-3.1b-i** — the query `aten`, a *non-word internal fragment* of
  `Patent_Application_AI_Method.pdf`, returns that record:
  `{"query":"aten","search_mode":"lexical_substring","total":1,"results":[{"rank":1,"public_id":"ARK-PAT-Z65SKJ",…}]}`.
  No vector engine matches a gibberish fragment. `%aten%` does.
* **A-3.1b-ii** — the English paraphrase *"documents proving professional standing issued
  by an accredited body"* returns `{"total":0,"results":[]}` against a corpus containing a
  CA Bar licence, an AWS certificate and a patent application.

The tool's own `search_mode: "lexical_substring"` label is honest — that part was fixed.
What is **not** honest is everything a caller reads before the response arrives. Four
published surfaces verified in this run:

1. the live `tools/list` description — *"Uses semantic (vector) similarity matching against
   anchored public credentials"*;
2. the MCP `arkova://api/overview` resource the server itself serves
   (`mcp-server.ts:580`) — *"search_credentials — Semantic search across the anchored
   records corpus"*;
3. `docs/api/mcp-tools.md:52` — *"Semantic search across credentials"*;
4. the module header at `services/edge/src/mcp-tools.ts:9` — *"search_credentials:
   Semantic search across credentials"*.

(The runbook's own census at `FULL-SOAK-2026-08-RUNBOOK.md:358` puts the total across the
product at ten surfaces including the priced `/ai/search` developer offer; this run
verified the four above directly.) An MCP client picks a tool from its description, not
from a field in a response it has not yet received.

Underlying cause is not fixable by copy alone: `credential_embeddings` has **0 rows** on
the side-rig and `ENABLE_SEMANTIC_SEARCH` is off, so there is nothing to search
semantically even with the gate open. Turning the flag on does not create embeddings.

### D-2 — `nessie_query` / `nessie_ask` synthesize a confident answer for a disabled capability

CONFIRMED on both surfaces. Nessie is OFF by founder directive (2026-08-01).

Worker, directly:

```
GET {worker}/api/v1/nessie/query?q=SEC+filing+risk+factors&mode=context&limit=3
HTTP 200
{"answer":"No relevant verified documents were found for your query.","citations":[],"confidence":0,"model":"none","query":"SEC filing risk factors"}
```

Edge MCP `nessie_query` mode=context, same shape, `isError` **unset**:

```json
{"query":"What are the disclosed risk factors?","mode":"context",
 "answer":"No relevant verified documents were found for your query.",
 "confidence":0,"citations":[],"total":0}
```

This is a fail-**open**. HTTP 200, no `error`, no `disabled` marker, and a fluent English
sentence that an LLM caller will relay to a user as a substantive finding — "we looked and
there is nothing" — when the truth is "this capability is switched off and nothing was
searched". `confidence: 0` is the only tell, and it is a field most agent frameworks drop.
`model: "none"` is the second tell, equally invisible. The tool description promises
*"returns a synthesized answer with citations linking to anchored documents with proof"*.

Matches the `C2e` FAIL already recorded in
`docs/staging/evidence/fullsoak-2026-08/2026-08-12/sdk-integration.md` for the SDK
`nessie_ask` tool; this run shows the edge MCP tool has the same defect, so it is a
property of the worker endpoint, not of one SDK wrapper.

### D-3 — `anchor_document` returns no `public_id`, and its own stated follow-up fails (NEW)

The write works — exactly one row, asserted on the specific hash:

```
content_hash b9c8560e…70ea5   public_records rows: 0 -> 1
row: {"id":"0cf6bbd4-aafd-4f7b-a166-43e0601fd9e9","source":"soak_probe",
      "record_type":"document","title":"SCRUM-3140 MCP probe artifact",
      "anchor_id":null,"created_at":"2026-08-13T16:08:09.105401+00:00"}
```

But two things are broken:

1. The response carries **no `public_id`**:
   `{"status":"submitted","content_hash":"b9c8…","message":"Document fingerprint submitted for batch anchoring. Check status with verify_document."}`
   `anchorSubmittedResult()` reads `record?.public_id` — and `public_records` **has no
   `public_id` column** (`id, source, source_id, source_url, record_type, title,
   content_hash, anchor_id, metadata, created_at, updated_at, training_exported,
   embedded_at`). The field is `undefined` and `JSON.stringify` drops it. The tool
   description promises *"Returns an anchor receipt with a public identifier for later
   verification"*. It can never do that on this code path.
2. The follow-up the response itself instructs is broken. `verify_document` on the hash
   just accepted:
   `{"verified":false,"status":"UNKNOWN","public_id":null,"message":"No anchored document found with this fingerprint."}`
   `verify_document` reads `anchors`; the row landed in `public_records` with
   `anchor_id = null`. Nothing links them until a feeder job runs — and the feeder crons
   are paused, against a 259k-row unlinked backlog. From an MCP caller's point of view
   `anchor_document` is a write to nowhere with a receipt it cannot use.

### D-4 — the MCP audit log has never written a single row, **including in production** (NEW, SOC2)

Every MCP tool call is supposed to leave an `audit_events` row (MCP-SEC-06,
`services/edge/src/mcp-audit-log.ts`). Every insert is rejected — 61 of 61 across this
session's tool calls:

```
[mcp-audit-log] insert failed (HTTP 400) for tool=search_credentials
```

Reproduced directly against PostgREST:

```
POST /rest/v1/audit_events {"event_type":"MCP_TOOL_CALL","event_category":"security",…}
HTTP 400
{"code":"23514","message":"new row for relation \"audit_events\" violates check constraint \"audit_events_event_category_valid\""}
```

Root cause, exactly: `mcp-audit-log.ts:77` sends `event_category: 'security'` (lowercase).
The constraint is

```sql
CHECK (event_category = ANY (ARRAY['AUTH','ANCHOR','PROFILE','ORG','ADMIN','SYSTEM',
  'ORGANIZATION','WEBHOOK','API','AI','BILLING','VERIFICATION','USER','COMPLIANCE',
  'NOTIFICATION','PLATFORM','SECURITY']))
```

— uppercase `'SECURITY'`. One character class. The insert is fire-and-forget through
`ctx.waitUntil`, so it fails silently: no caller ever sees it, and the only trace is a
`console.error` in the Cloudflare Worker log.

**This is live in production.** Queried read-only against `vzwyaatejekddvltxyye`:

| metric | value |
|---|---|
| `audit_events` total rows | 409,885 |
| newest row | 2026-08-13 16:00:01+00 (table is actively written) |
| rows with `event_type='MCP_TOOL_CALL'` | **0** |
| rows with `event_category='security'` (lowercase) | **0** |
| constraint definition | identical uppercase-only CHECK |

The production audit trail is healthy for every other surface and has **never recorded a
single MCP tool invocation**. `git log -p -- services/edge/src/mcp-audit-log.ts` shows the
literal has been lowercase `'security'` since the module first landed on **2026-05-26**
(merge `8484dcc08`) and was never changed — so the audit gap spans the module's entire
life, roughly two and a half months. `edge.arkova.ai` is an authenticated, API-key-scoped,
write-capable surface with zero audit coverage.

Why it survived: `services/edge/src/mcp-audit-log.ts` has **no test file at all** — nothing
under `services/edge/src/*.test.ts` references `logMcpToolCall` or the module. The fix is
one string literal (`'security'` → `'SECURITY'`), plus a test that asserts the insert's
HTTP status is 2xx rather than merely asserting the call was made, plus a backfill
decision for the audit gap between the MCP surface going live and the fix landing.

### D-5 — `/.well-known/arkova-keys.json` still 404s, now root-caused

Still 404. The runbook (S17) records it as a reachability finding; this run confirms it
and pins the cause.

| host | `/.well-known/arkova-keys.json` | `/.well-known/did.json` |
|---|---|---|
| `https://app.arkova.ai` | **404** | 200 |
| `https://arkova-worker-kvojbeutfa-uc.a.run.app` (prod) | **404** | 200 |
| side-rig worker | **404** | 200 |
| `https://edge.arkova.ai` | 404 (wrong host — edge does not serve it) | — |
| soak rig | 403 (OIDC — not disturbed) | 403 |

Cause: `services/worker/src/api/proof-keys.ts` defines
`router.get('/.well-known/arkova-keys.json')` but `services/worker/src/index.ts` **never
imports or mounts it** (`grep -n "proof-keys\|proofKeys" services/worker/src/index.ts` →
no matches). Its sibling `didWebRouter` *is* mounted, which is why `did.json` answers 200
from the same process. Proof bundles reference a key registry that has never been
reachable at its published URL.

### Also observed (not counted as failures)

* **`get_flag` makes a fresh environment's MCP surface dark.** The edge kill switch
  (`mcp-kill-switch.ts:70`) comments *"Missing flag row → fresh DB; fail-open with true"*,
  but `get_flag('ENABLE_MCP_SERVER')` returns **`false`**, not `NULL`, when the row is
  absent (verified on the side-rig). The fail-open branch is unreachable; the first
  request to any newly built environment gets
  `{"error":"mcp_disabled","message":"MCP server is temporarily disabled by an operator."}`
  with no operator having disabled anything. Same failure mode as the known
  "fresh env = `/api/v1` dark" behaviour. Worked around here by inserting the flag row.
* **`get_organization` is membership-scoped despite a public-sounding description.** It
  answers *"Organization <id> was not found"* for any org the caller is not a member of
  (`handleAgentGetOrganization` filters `org_members.user_id = caller`). Correct as
  privacy behaviour, but the description says *"Get organization profile details by
  organization public_id. Use after search…"*, and `search` can surface orgs, so an agent
  will read the 404 as "does not exist" rather than "not yours".

---

## GAP 2 — the 46-spec Playwright E2E suite

**Deliverable:** `scripts/staging/fullsoak-e2e-daily.sh` (new).
**Evidence:** `docs/staging/evidence/fullsoak-2026-08/2026-08-13/e2e-daily-2026-08-13T163730Z.{md,json}`.

The suite had never run during the soak: CI's `e2e` job is path-gated and skips green on
doc-only changes. It has now run against the side-rig, end to end.

**346 chromium tests across all 46 spec files: 320 passed, 25 failed, 1 did-not-run.**
After re-running two specs whose failures were seed artifacts, the standing count is
**334 pass / 11 real failures**, from exactly **three defects plus one deliberately-RED
spec plus one hosted-environment limit**.

### How it was run

CI (`.github/workflows/ci.yml:1276`) runs a local Supabase + a local worker on `:3001`
with `USE_MOCKS=true`, chromium, `workers: 1`. Two conditions had to be matched or the
results would have been noise, and two earlier passes were **discarded** rather than
reported:

* A local worker must be running — `resolveWorkerBaseUrl()` (`src/lib/workerUrlSafety.ts`)
  falls back to `http://localhost:3001` in a dev build. The first pass had none and
  produced fake failures in `api-keys`, `api-verify-flow`, `cross-tenant`.
* `workers=1` is load-bearing. At `--workers=4` specs began landing on `/login` ~30 min
  in: the refresh token in `.auth/orgAdmin.json` had been revoked
  (`{"code":400,"error_code":"refresh_token_not_found"}`) while its access token was still
  valid — parallel browser contexts sharing one `storageState` race GoTrue's refresh-token
  rotation.

Final method: one `playwright test` invocation per spec file, chromium, `workers=1`, so
`auth.setup.ts` mints a fresh session per spec. The worker had to run under **node 22** —
`@sentry/node-cpu-profiler` ships no darwin-arm64 prebuild for node 25's ABI 141.

### Failing specs

| Spec | Pass | Fail | Cause |
|---|---|---|---|
| `onboarding` | 0 | **9** | E-2 |
| `identity` | 3 | **5** | E-2 |
| `cross-tenant` | 2 | **5** | **E-1** |
| `billing` | 13 | 2 | E-3 (15/15 after restoring the row) |
| `route-guards` | 9 | 1 | E-2 |
| `auth` | 6 | 1 | hosted-Supabase email quota, not a defect |
| `integrations-docusign-member` | 7 | 1 | flake (11/11 on clean re-run) |
| `verify-ratelimit-contract` | 1 | 1 (+1 not run) | known RED by design (SCRUM-2603) |

The other 38 spec files passed clean, including `route-screenshot-baseline` (57),
`api-keys` (15), `integrations-docusign` (15), `attestation-verification` (11),
`public-verification` (10), `mobile-viewport` (10), `semantic-search` (8).

### E-1 — a transient "Record Not Found" both breaks *and* hollows the G4 / CC6.1 evidence (NEW, most important)

`/records/:id` renders the **"Record Not Found"** empty state for ~20 ms during load, for a
record the signed-in user **owns**. Measured on the side-rig, headings sampled every 50 ms:

```
  55ms  []
 783ms  ["My Records","Record Not Found"]     <-- transient false not-found
 806ms  ["My Records"]
 942ms  ["My Records","Record Details", ...]  <-- real content
```

Mechanism, in `src/hooks/useAnchor.ts`. The hook does apply `authLoading` to what it
returns (`loading: authLoading || loading`, line 111), but its effect's early-return
branch does not consult it:

```ts
useEffect(() => {
  if (!user || !id) {
    async function reset() { setAnchor(null); setLoading(false); }   // latches loading=false
    void reset();
    return;
  }
  ...
}, [user, id, fetchAnchor]);
```

So any moment where `useAuth()` reports `{loading: false, user: null}` — the ordinary
session-restore window on a hard refresh or deep link — latches `loading=false` with
`anchor=null`, and `RecordDetailPage.tsx:142`'s `if (error || !anchor)` renders the
not-found card before the fetch has started.

Two consequences, and the second is the serious one:

1. **User-visible.** Every deep-link or hard refresh of a record page flashes *"The
   requested record does not exist or you do not have permission to view it."* Wider on
   slow connections.
2. **Audit-grade test integrity.** `e2e/cross-tenant.spec.ts` is the G4 / CC6.1 evidence,
   and PR #2213 hardened it so that "blocked" means *the explicit `Record Not Found`
   heading on the record path*. That heading is now also a **loading state**:
   * `expectRecordBlocked()` can be satisfied by a page that is merely loading a record
     the accessor **can** read — precisely the hollow pass the hardening exists to
     prevent, re-opened from the product side rather than the test side.
   * Its mirror `assertOwnRecordReadable()` fails outright, which is what we observe.
     `observeRecordPage()`'s `waitForFunction` resolves on the transient at ~783 ms, then
     the separate `isVisible()` re-queries land in the 806–942 ms hole where the heading
     is gone and the content has not arrived, so both flags read false:

     ```
     Error: precondition: org A admin session did not render its own record at
     /records/<id> within budget (neither the record content nor an error state appeared).
     ```

   All five UI legs fail this way, deterministically, serially, with fresh sessions:
   individual→org-admin record, org-admin→individual record, Org A→Org B record,
   Org B records absent from Org A dashboard, Org B records absent from Org A registry.

**What is still valid G4 evidence today:** the spec's two non-UI legs pass —
*Cross-Tenant Isolation — direct PostgREST (RLS)* (an authenticated org-admin JWT gets
zero rows for foreign anchors, after proving it can read its own) and *Cross-Tenant
Isolation — public API (API keys)* (an org key is denied another org's batch job in both
directions, after each key proves it can read its own). Both are in the daily script and
pass. The database-level and API-level isolation assertions hold; it is the **browser-level
leg that cannot currently produce evidence**, and the heading it keys on is no longer a
trustworthy signal even when it does.

**Fix:** have the effect's early-return branch keep `loading` true until `authLoading` is
false, and/or have `RecordDetailPage` distinguish "auth pending" from "no row". Both the
flash and the hollow-pass hole close with that one change. Note `record-detail.spec.ts`
passes 9/9 — it does not use the appear-then-re-query gate, so its green is not evidence
that this is fine.

### E-2 — the E2E harness hard-binds three specs to a *local* Supabase (NEW)

`e2e/helpers/profile-session.ts:80` injects the session under a hardcoded storage key:

```ts
localStorage: [{ name: 'sb-127-auth-token', value: JSON.stringify(sessionData.session) }],
```

supabase-js derives its storage key from the project host. `sb-127-auth-token` is correct
only for a local Supabase at `127.0.0.1:54321`; against the side-rig the app's real key is
`sb-ehqqearcitrgloibtjqx-auth-token` (confirmed by reading the `.auth/individual.json` that
`auth.setup.ts` writes). The injected session is invisible to the app, so every such page
boots unauthenticated and lands on `/login`
(`Received string: "http://localhost:5173/login"` vs `Expected pattern: /\/onboarding\/role/`).

Blast radius — every spec using `withProfileSession()`: `onboarding` 9/9 fail,
`identity` 5/8 fail, `route-guards` 1/10 fail. **This is the concrete reason the suite was
not portable to a rig**, i.e. the mechanical cause of the gap this exercise set out to
close. Fix: derive the key from `E2E_SUPABASE_URL` instead of hardcoding it.

### E-3 — `identity-entitlement.spec.ts` destroys a seeded subscription and never restores it (NEW)

`e2e/identity-entitlement.spec.ts` lines 102, 108 and 186 all run

```ts
await service.from('subscriptions').delete().eq('user_id', USER.id);
```

in `beforeEach` **and** `afterAll`, with no restore, where `USER` is the seed individual.
In CI this is invisible because `supabase db reset` reseeds before every run. On any
**persistent** environment — a staging rig, or a daily scheduled soak run — the seeded
`dddddddd-…-0002` row is gone permanently after the first run and every later
`billing.spec.ts` run fails (`Select Plan` button absent, because with no subscription the
app makes `free` the current plan and its button becomes a disabled "Current Plan").
Confirmed by mechanism: re-inserting the row took billing from **13/15 to 15/15**.

This is a day-2 failure mode that a daily runner hits and a one-shot CI run never does —
exactly the class of bug that scheduling this suite was meant to surface.

### Reproduced as-designed: the §1.10 rate-limit contract violation

`verify-ratelimit-contract.spec.ts` is written RED on purpose (SCRUM-2603) and is still red:

```
Error: A verify burst of 11 < 100/min must not 429 against a sub-contract limit.
Got 2 such 429(s) advertising limits [60,60] — the admin checkout limiter (10)
binding ahead of the verify router (SCRUM-2603).
Expected: 0  Received: 2
```

Note the advertised limit observed is **60**, not the §1.10 anonymous 100. Worth reading
next to GAP 3: the number the contract advertises is wrong *and* the number it enforces is
multiplied by the instance count.

### Environment limit, not a defect

`auth.spec.ts` → *"signup stops on the email-confirmation screen"* fails because the
hosted Supabase project throttles signup email — probed directly:
`{"code":429,"error_code":"over_email_send_rate_limit","msg":"email rate limit exceeded"}`.
CI does not hit this (local Supabase + Inbucket). Needs custom SMTP or a raised quota on
the target project. The spec's premise is right — `supabase/config.toml` already sets
`enable_confirmations = true`.

### Specs that could NOT run, and exactly why

| Spec | Tests | Why |
|---|---|---|
| `onboarding.spec.ts` | 9 of 9 | E-2 — `profile-session.ts` hardcodes `sb-127-auth-token` |
| `identity.spec.ts` | 5 of 8 | E-2, same |
| `route-guards.spec.ts` | 1 of 10 | E-2, same |
| `cross-tenant.spec.ts` UI legs | 5 of 7 | E-1 — transient "Record Not Found" breaks the ready-gate |
| `auth.spec.ts` signup | 1 of 7 | hosted Supabase email rate limit (429) |
| `verify-ratelimit-contract.spec.ts` | 1 of 3 (+1 serial dependent) | known RED by design (SCRUM-2603) |

Nothing was skipped for want of a Bitcoin node, a DocuSign account, live Stripe keys, or a
missing migration: the side-rig is at ledger head **0409**, identical to `main`, and the
DocuSign / Drive / Stripe / treasury specs stub at the Playwright `route()` boundary and
passed.

### Side-rig seeding for GAP 2

Four auth users at the exact UUIDs `e2e/fixtures/supabase.ts` pins (carson@arkova.ai,
sarah@arkova.ai, demo-admin@arkova.local, demo-user@arkova.local), then a mirror of
`supabase/seed.sql` minus its destructive prologue: 2 organizations, 4 profiles, 3
`org_members`, 3 memberships, 4 plans, 2 subscriptions, 2 credential templates, 11 anchors.
No `TRUNCATE`; every write `ON CONFLICT DO NOTHING/DO UPDATE` on its own rows. Failing
profile-session specs leaked 18 `e2e-*` auth users whose teardown does not survive a 30 s
test timeout; those were deleted afterwards. The CI-parity worker's `check-confirmations`
cron promoted one seeded `SUBMITTED` anchor to `SECURED` via `MockChainClient` — contained
to the side-rig, so no soak SECURED count is affected.

### The daily script

`scripts/staging/fullsoak-e2e-daily.sh` refuses to start unless the resolved Supabase URL
contains `ehqqearcitrgloibtjqx` and none of the three protected refs; exports
`SOAKING_PROJECT_REFS` so `e2e/helpers/soaking-ref-guard.ts` is armed too; boots or reuses
the vite dev server and the CI-parity worker under node 22; runs 42 spec files with a
`--grep-invert` for the six known-bad tests, each named with its reason; writes a dated
`.md` + `.json` under `docs/staging/evidence/fullsoak-2026-08/<date>/`; exits 1 on failure
and 2 on a precondition error. Validated end to end
(`E2E_DAILY: PASS — 13 passed / 0 failed`), with the grep-invert correctly reducing
`cross-tenant` to its two passing G4 legs.

---

## GAP 3 — Upstash distributed rate limiting (SCRUM-3139)

**Evidence:** `docs/staging/evidence/fullsoak-2026-08/2026-08-13/ratelimit-scrum3139-2026-08-13T155921Z.json`.

The record said "prod-only, untestable". That was wrong on both counts: the credentials
are in Secret Manager, the side-rig takes them, and the defect reproduces in minutes.

### 3.1 The defect, in source

`services/worker/src/utils/upstashRateLimit.ts` (HEAD):

* `get(key)` returns `this.cache.get(key)` — a process-local `Map`. **Redis is never read
  on the hot path.**
* `set(key, entry)` writes through to Redis, but `rateLimit()`
  (`services/worker/src/utils/rateLimit.ts:126-146`) only calls `set()` on the *create a
  new window* branch, with `count: 0`. The actual increment is `entry.count++`, an
  in-place mutation of the object already in the local Map. **The increment is never
  written back.**
* `syncFromRedis()` — the only method that reads Redis into the cache — is called from
  **nowhere** in the worker (`grep -rn syncFromRedis services/worker/src` returns the
  definition and its unit tests, and nothing else).

Net effect: every Cloud Run instance enforces a private bucket, and Redis holds a
permanent `count: 0` for the window. The class satisfies `IRateLimitStore` and logs
`Upstash Redis rate limiting initialized`, so everything looks wired.

### 3.2 Empirical demonstration on the side-rig

Side-rig set to `min-instances=2 max-instances=2` (rev `…-00008-jnj`), Upstash bound.
Target: `GET /.well-known/did.json`, which runs through `apiIpShadowGuard` — a documented
**60 req/min per client IP** (`services/worker/src/index.ts:413`, bucket key = `req.ip`,
`trust proxy = 2`).

200 requests, concurrency 25, from one egress IP `216.183.125.66`, elapsed 1.3 s:

```
started 2026-08-13T15:59:21.929Z   ended 2026-08-13T15:59:23.248Z
documented_limit   60
accepted           114      <-- 1.9x the documented limit
rate_limited_429    86
distinct X-RateLimit-Reset values: ["1786636805","1786636819"]   <-- TWO windows, one key
duplicate X-RateLimit-Remaining values: 57
```

Every `X-RateLimit-Remaining` value from 56 down to 0 was returned **exactly twice**. Under
one shared counter that sequence is a strict permutation with no repeats. Two independent
counters produce it. The interleaving is visible in the raw capture — consecutive requests
milliseconds apart report `remaining 48 / 56 / 44 / 50 / 45 / 46` against two different
`reset` epochs 14 seconds apart.

**Instance correlation** (Cloud Logging, `resource.labels.service_name=arkova-worker-connector-sidecar-2026-08-staging`,
window `15:59:22.872Z → 15:59:23.253Z`, 86 `Rate limit exceeded` entries, revision
`…-00008-jnj`):

| `labels.instanceId` (first 32 chars) | 429 warnings |
|---|---|
| `001548f729c5f4e23bf276c048acec08…` | 49 |
| `001548f72961871a3a9f679d946ac6b3…` | 37 |

Distinct bucket keys logged across all 86 entries: **exactly one**, `216.183.125.66`. Each
instance logged `{"key":"216.183.125.66","count":60,"maxRequests":60}` — both reached 60
independently on the same key.

**The Redis side, directly.** With the worker logging `Upstash Redis rate limiting
initialized` (side-rig, 15:58:00.748Z), waited out the window, then:

```
T0  GET {upstash}/get/216.183.125.66  ->  {"result":"{\"count\":0,\"resetAt\":1786636898380}"}
    ... 25 requests issued (accepted 25, 429s 0; remaining went 52 -> 39 with duplicates) ...
T1  GET {upstash}/get/216.183.125.66  ->  {"result":"{\"count\":0,\"resetAt\":1786636898380}"}
    GET {upstash}/ttl/216.183.125.66  ->  26
```

The key exists, the TTL is live, and after 25 counted requests the stored count is still
**zero**. Redis is a write-only decoration.

**Blast radius in production.** `arkova-worker` runs `min-instances=2, max-instances=10`
with both Upstash secrets bound. So *at all times* every configured limit is at least 2×
its stated value, and up to 10× under load. On the 5/min auth limiter that is 10–50/min;
on the 60/min per-IP shadow guard, 120–600/min; on the 1,000/min-per-key API limiter,
up to 10,000/min. Constitution §1.10 is not being enforced at its stated numbers anywhere
that matters.

### 3.3 Does PR #2223 fix it?

**Yes — demonstrated, not reviewed.** PR #2223 (`claude/quirky-darwin-e5e1b7`, head
`45d51ff263d9797ce1319298100e5feee255179f`, currently Draft, base `main`) adds an optional
`increment(key, windowMs, now)` to `IRateLimitStore`, implements it as a pipelined Redis
`INCR` + `PTTL` (with `PEXPIRE` on the first hit and self-heal on a `-1` TTL), routes
`rateLimit()` through `enforceShared()` whenever the installed store exposes it, and
deletes the read-modify-write entirely. The local `Map` survives only as an explicitly
logged fail-open bucket for when Redis is unreachable.

Rather than take that on trust, both versions were run head-to-head against the **real
Upstash instance** — two Node processes per variant (two "Cloud Run instances"), the same
60/min limiter shape, 200 requests round-robined across them, probe-scoped bucket keys so
nothing could collide with a live bucket:

| variant | accepted | 429 | split across the two instances | distinct reset values | duplicate `remaining` pairs |
|---|---|---|---|---|---|
| `main` @ HEAD (pre-fix) | **120** | 80 | 60 / 60 | 1 | **60** |
| PR #2223 @ `45d51ff2` | **60** | 140 | 30 / 30 | 2 | **0** |

`main` admits exactly 2× the documented limit, each instance counting to 60 on its own.
PR #2223 admits exactly 60 across both instances with zero duplicate `remaining` values —
one shared bucket, enforced once. The fix is correct.

### 3.4 Residual, not fixed by #2223

**The Redis key has no environment namespace.** PR #2223 uses
`COUNTER_PREFIX = 'arkova:rl:'` plus the limiter key, which for the shadow guard is the
bare client IP. The **same** `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` secrets
(no environment suffix in the secret names) are bound to:

| service | min / max instances | Upstash bound |
|---|---|---|
| `arkova-worker` (prod) | 2 / 10 | yes |
| `arkova-worker-staging` | 1 / 2 | yes |
| `arkova-worker-connector-sidecar-2026-08-staging` | 2 / 2 | yes |
| `arkova-worker-fullsoak-2026-08-staging` | 1 / 5 | **no** |

Today this is inert, precisely *because* nothing reads Redis. The moment #2223 lands it
becomes live: a burst against shared staging from an IP that also calls production will
consume production's budget for that IP, and vice versa. Recommend prefixing the counter
keyspace with an environment discriminator (`arkova:rl:<env>:`) in the same PR, or binding
separate Upstash databases per environment.

**Secondary observation:** the fullsoak rig has **no** Upstash binding at all and runs
`max-instances=5`. Any rate-limit evidence gathered during this soak is therefore
per-instance in-memory (up to 5× the stated limits) and does not exercise the Upstash path
in any direction. That does not invalidate the soak's other evidence, but no rate-limit
conclusion from the soak should be read as covering distributed enforcement.

---

## What could NOT be run, and why

1. **The 16 MCP tools against the deployed `edge.arkova.ai`.** The soak MCP key is a
   soak-rig credential and the deployed worker is bound to the production Supabase project
   — verified 401, §1.0. Driving it would require a production API key, and
   `anchor_document` would then write the production ledger. Only the auth-negative and
   metadata legs were run against the live host; the tool bodies ran against the identical
   edge source under `wrangler dev`, side-rig bound. `scripts/staging/fullsoak-mcp-probe.sh
   --remote` runs the safe legs against prod and explicitly SKIPs the tool calls rather
   than reporting them as passes.
2. **`anchor_document` on production.** Deliberately not attempted; also disabled there
   (`scopes_supported` lacks `write:anchors`, so prod serves 15 of 16 tools).
3. **The Workers AI binding under `wrangler dev`** reports `not supported` in local mode.
   It does not affect any result here: `nessie_query` stopped using `ARKOVA_AI` for
   embedding (the `_ai` parameter is retained for signature compatibility only) and proxies
   to the worker instead.
4. **Semantic search could not be observed working anywhere**, because
   `credential_embeddings` has 0 rows and `ENABLE_SEMANTIC_SEARCH` returns 503. The
   negative result is real; a positive semantic result was not obtainable in any
   environment available.
5. **15 E2E tests across `onboarding` / `identity` / `route-guards`** cannot run anywhere
   but a local Supabase at `127.0.0.1:54321` — defect E-2, a hardcoded storage key. Not a
   rig limitation; a harness one.
6. **The five browser-level tenant-isolation legs of `cross-tenant.spec.ts`** cannot
   produce evidence until E-1 is fixed. The RLS and public-API legs do pass and are in
   the daily script.
7. **`auth.spec.ts` signup** cannot complete against a hosted Supabase project — the
   project's signup-email quota returns 429 `over_email_send_rate_limit`. Needs custom
   SMTP or a raised quota, not a code change.
8. **`verify-ratelimit-contract.spec.ts`** is RED by design (SCRUM-2603) and was not
   "fixed" to make the run green.
9. **A green E2E run was never manufactured.** Two full passes were discarded as invalid
   (no local worker; `workers=4` racing GoTrue refresh-token rotation) rather than
   reported as results.

## Defect index

| id | severity | title | status |
|---|---|---|---|
| D-1 | High | `search_credentials` is literal `ILIKE %query%` while its own tool description and three other published surfaces call it semantic | confirmed, root-caused |
| D-2 | High | `nessie_query` / `nessie_ask` synthesize a fluent answer with `confidence: 0` for a permanently disabled capability; HTTP 200, no error marker | confirmed on both edge MCP and worker |
| D-3 | Medium | `anchor_document` returns no `public_id` (column does not exist) and the `verify_document` follow-up it instructs cannot resolve the row | **new** |
| D-4 | **High (SOC2)** | MCP audit log rejected 400 on every insert — `event_category: 'security'` vs an uppercase-only CHECK. Zero `MCP_TOOL_CALL` rows in production across 409,885 audit rows | **new**, live in prod |
| D-5 | Medium | `/.well-known/arkova-keys.json` 404 on every worker host — `proof-keys.ts` is never mounted in `index.ts` | confirmed, root-caused |
| D-6 | Medium | `get_flag` returns `false` (not NULL) for a missing row, so the edge MCP kill switch's documented fail-open is unreachable and a fresh environment serves `mcp_disabled` | **new** |
| D-7 | **P0** | Upstash rate limiter shares no state — `get()` never reads Redis, the increment is never written back, `syncFromRedis()` is never called. 114 requests admitted against a documented 60; two instances, one bucket key, `count:0` in Redis after 25 counted requests | **SCRUM-3139 confirmed**; PR #2223 fixes it (demonstrated) |
| D-8 | Medium | Rate-limit counter keyspace has no environment namespace, and prod + shared staging + the side-rig share one Upstash database. Inert today, live the moment #2223 lands | **new** |
| E-1 | **High** | `/records/:id` renders "Record Not Found" transiently while auth resolves. Breaks all 5 UI legs of `cross-tenant.spec.ts`, and makes `expectRecordBlocked()` satisfiable by a loading state — a hollow pass in the G4 / CC6.1 evidence | **new** |
| E-2 | High | `e2e/helpers/profile-session.ts:80` hardcodes the local-Supabase storage key `sb-127-auth-token`, so 15 tests across 3 specs can only ever run against a local DB. This is the mechanical reason the suite was never portable to a rig | **new** |
| E-3 | Medium | `identity-entitlement.spec.ts` deletes the seed individual's `subscriptions` rows with no restore — invisible under CI's `db reset`, permanently destructive on any persistent rig or daily runner | **new** |

## Reproducing

```bash
export CLOUDSDK_PYTHON=/opt/homebrew/opt/python@3.14/bin/python3.14

# GAP 1 — boots services/edge under wrangler dev against the side-rig, drives all 16 tools
./scripts/staging/fullsoak-mcp-probe.sh
./scripts/staging/fullsoak-mcp-probe.sh --remote     # auth-negative legs vs edge.arkova.ai

# GAP 2 — see §2
./scripts/staging/fullsoak-e2e-daily.sh

# GAP 3 — the burst is four lines; see §3.2 for the exact captures
```
