# agents.md — services/worker/src/integrations/oauth/

_Last updated: 2026-09-21 (`drive.ts` `DRIVE_DEFAULT_SCOPES` cutover to `drive.readonly` + dual OAuth client support — SCRUM-5287/SCRUM-2903/SCRUM-2330)._
_Last updated: 2026-09-21 (`drive.ts` `listChanges()` fields-mask incident fix — SCRUM-2903/3661/5094/2330)._
_Last updated: 2026-09-13 (`drive.ts` gained `listChildFolders()` + `drive.metadata.readonly` scope — Connectors page folder picker, SPEC-CONNECTORS §2.1/§2.2)._
_Last updated: 2026-08-31 (signer-backfill follow-on to PR #2474: `fetchDocusignEnvelopeRecipients` + `extractCapturedSigners`, now delegating to the shared `captureDocusignSigners` mapper)._
_Last updated: 2026-08-30 (`adobe-sign.ts` gained the OAuth + webhook-provisioning client)._

## 2026-09-21 — `DRIVE_DEFAULT_SCOPES` cutover: `drive.file` → `drive.readonly`, dual OAuth client (SCRUM-5287/SCRUM-2903/SCRUM-2330)

**Why.** The 2026-09-13 entry below records `drive.file` + `drive.activity.readonly` +
`drive.metadata.readonly` + `userinfo.email` as the requested set. An independent review the same day
(SCRUM-2903 fields-mask PR follow-up) found this could never deliver what the connector promises:
`drive.file` per-file access is granted ONLY for a file the app itself created, or one the user
explicitly picked through Google's REAL Picker widget — NOT merely "a file listed via
`drive.metadata.readonly`." Arkova's Connectors-page folder browser is a custom `files.list`
component, not the Picker, so a file someone else later adds to a watched folder is invisible to
`drive.file` and 403s on byte fetch (`fetchDriveFileBytes`). The Arkova org's own grant working
(cited in the 2026-09-13 entry) was because it ALSO carries the broad `auth/drive` scope from an
unrelated earlier consent, not because the requested set was sufficient.

**CTO decision (2026-09-21):** request exactly `drive.readonly` + `userinfo.email`. Confirmed against
Google's REST reference via `WebFetch` (cited in full in `DRIVE_DEFAULT_SCOPES`'s doc comment) that
`drive.readonly` covers every Drive API call this module makes: `files.get` (incl. `alt=media`),
`files.export`, `files.list`, `changes.list`, `changes.watch`, `changes.getStartPageToken`.

**`DRIVE_LEGACY_REQUESTED_SCOPES`** preserves the pre-cutover set so `driveGrantExcessScopes` does
NOT flag an existing/still-being-issued legacy grant as the SCRUM-5287 over-grant attack (its
"requested" bound is now the union of both sets). **`isDriveLegacyGrant()`** is the NEW, narrower
classifier that DOES distinguish a legacy row — consumed by `connector-health.ts` (new
`reconnect_required_scope_change` reason, ranked above `file_access_not_granted` since it is that
symptom's actual cause) and by `drive-changes-runner.ts`'s `loadDriveAccessToken` (selects which
OAuth client a refresh goes to — see next paragraph).

**Dual OAuth client.** `drive.readonly` is a Google RESTRICTED scope; requesting it from the shared
`GOOGLE_OAUTH_CLIENT_ID` (which also carries unrelated historical consents — the 32-scope prod row
`driveGrantExcessScopes` guards against) would put every OTHER integration riding that client through
Google's restricted-scope verification too. `requireClient(env, generation)` now supports a SECOND,
dedicated pair — `GOOGLE_DRIVE_OAUTH_CLIENT_ID`/`SECRET` (new `arkova-connectors` GCP project, NOT
PROVISIONED as of this PR) — preferred for new consent/refresh when both are set, with the original
pair as fallback. **A refresh token is bound to the client that issued it** — `refreshAccessToken`'s
`clientGeneration: 'legacy'` ALWAYS uses the original pair regardless of whether the new one is
configured, and `loadDriveAccessToken` in `../connectors/drive-changes-runner.ts` selects it via
`isDriveLegacyGrant(tokens.scope)` on the decrypted token blob. Getting this backwards sends an
old-client refresh token to the new client's token endpoint, which Google rejects with
`invalid_grant`. `config.ts` accepts either complete pair in production and rejects a half-set new
pair (id without secret) unconditionally.

## 2026-09-21 — `listChanges()` `fields` mask was concatenated — every Drive change notification failed since 2026-05-04 (SCRUM-2903/3661/5094/2330)

**Root cause.** `listChanges()` built its `fields` query param as
`[ 'newStartPageToken', 'nextPageToken', 'changes(fileId,removed,changeType,time,', 'file(...,', 'lastModifyingUser(...)))' ].join('')`
— an EMPTY-STRING join. The first two top-level entries and the start of
`changes(...)` fused together with **no separating commas**:
`newStartPageTokennextPageTokenchanges(...`. Google rejected EVERY call with
HTTP 400 `Invalid field selection newStartPageTokennextP...` (confirmed in
prod logs: 150 failures/day, zero successes, ever, since the commit that
introduced this — 90b4b9c72, 2026-05-04). The webhook 200-acks on any
`runDriveChanges` failure (so Drive does not retry-storm), which is exactly
why this went unnoticed for months: nothing downstream of `changes.list` —
folder-rule match, revision ledger, rule-event enqueue, file-changed job
enqueue, connector_artifact insert — had EVER run against a real Google
response for any org.

**Fix.** Rebuilt as one explicit string with commas written where they
belong (`CHANGES_LIST_FIELDS` constant) — no `.join('')` at all, so there is
no empty separator to get wrong a second time. Test coverage pins the EXACT
decoded string (the only assertion that actually catches THIS defect class —
see the doc comment on `assertValidFieldsMask` in
`__test-helpers__/fields-mask.ts` for why a purely structural validator
cannot: a no-separator join fuses two field names into one
syntactically-valid-looking identifier that a generic tokenizer cannot tell
apart from a legitimately long one).

**Full call-site sweep** (every Google API call in this file that sets
`fields`/`q`/`pageToken`/`supportsAllDrives`/`includeItemsFromAllDrives`):
`listChanges` was the ONLY defect. `getFileMetadata` (`fields=id,name,parents,driveId`),
`getSharedDriveName` (`fields=name`), `listChildFolders`
(`fields=nextPageToken,files(id,name,driveId)`, already had exact-string
coverage + `q` escaping via `escapeDriveQueryLiteral`) were all already
correct — each now also has an exact-string regression test.
`createChangesWatch`/`changes.watch` and `changes/startPageToken` carry no
`fields` param at all (channel-resource response is small by default) — both
now have exact-URL/param assertions too. Repo-wide `git grep -n "\.join('')"`
across `services/worker/src/integrations` and `services/worker/src/api/v1/integrations`
found no other instance of this pattern (DocuSign's `oauth/docusign.ts` joins
scopes with `.join(' ')`, which is the CORRECT separator for a
space-delimited OAuth scope string — not the same defect class).

**`getStartPageToken` extracted** from `createChangesWatch` into its own
exported function — same behavior, now independently callable. Needed for
the new 410/404 "pageToken invalid/expired" recovery path in
`drive-changes-processor.ts` (see `connectors/agents.md`): Google's
documented recovery for an expired page token is exactly this call, never a
retry of `changes.list` with the same stale token.

**Google docs verification.** The `google-developer-knowledge` MCP returned
`API key not valid` this session (server-side auth failure, not a missing
capability) — confirmed instead via `WebFetch` against
`developers.google.com/drive/api/guides/fields-parameter` (comma separates
sibling fields at a level; parentheses denote the next nesting level — e.g.
`fields=nextPageToken,changes(file(id,name,owners(displayName,emailAddress)))`,
which is exactly the shape `CHANGES_LIST_FIELDS` now uses) and
`.../reference/rest/v3/changes/list` (confirms `pageToken`, `includeRemoved`,
`supportsAllDrives`, `includeItemsFromAllDrives` are the right params, and
that `newStartPageToken` appears only on the final page while `nextPageToken`
appears on every page with more to fetch — matches the existing pagination
logic in `drive-changes-processor.ts`, unchanged by this fix).

## 2026-09-13 — `drive.ts`: `listChildFolders()` + `DRIVE_DEFAULT_SCOPES` gained `drive.metadata.readonly`

**Scope change** (the constant's own comment requires a security review before any addition — this
is that review, done as part of the Connectors-page build and reviewed by the release session's
`/codereview` pass on this PR): `DRIVE_DEFAULT_SCOPES` gained
`https://www.googleapis.com/auth/drive.metadata.readonly`. Reason: `drive.file` alone cannot
enumerate a user's PRE-EXISTING folders (it only sees files the app created or that were handed to
it via the Google Picker) — a folder picker built on `drive.file` alone returns nothing for a
newly-connecting org. `drive.metadata.readonly` is metadata-only (cannot read file bytes). Widening
the scope does NOT widen an already-issued refresh token — every connection made BEFORE this change
needs to re-consent before `GET /api/v1/integrations/google_drive/folders` works for it; that
endpoint fails closed (`409 insufficient_drive_scope`) rather than silently returning `[]` for a
stale grant. (CTO verified on prod, read-only, 2026-09-13: the Arkova org's own `google_drive` grant
already includes `auth/drive` + `drive.file`, so the picker already works for that org today — every
OTHER org's existing connection is the one that needs the re-consent.)

**`listChildFolders()`** — new export, `files.list` scoped to `'<parent>' in parents and
mimeType='application/vnd.google-apps.folder' and trashed=false`, `includeItemsFromAllDrives=false`
hard-coded (D2 — My Drive only; shared drives are out of v1 because neither
`drive-changes-runner.ts` nor `drive-changes-processor.ts` registers a per-shared-drive watch, so a
shared-drive folder picked here would silently never fire). `parent` is escaped via
`escapeDriveQueryLiteral()` (Drive's OWN query-language escaping — backslash and single-quote —
distinct from the `URLSearchParams` encoding wrapping the whole `q` string) before it ever reaches
the query, so a `'` or `\` in `parent` cannot terminate the quoted literal early. `DriveApiError`
gained an optional `retryAfter` field so a 429/5xx can carry Google's `Retry-After` header through to
the endpoint's own response.

## 2026-08-30 — `adobe-sign.ts` is now provider client + webhook helpers, like `docusign.ts`

The file used to hold only HMAC verification and payload parsing for inbound notifications. It now
also carries the OAuth v2 + REST v6 webhook client the connect flow needs
(`buildAdobeSignAuthorizationUrl`, `exchangeAdobeSignCode`, `refreshAdobeSignAccessToken`,
`revokeAdobeSignToken`, `fetchAdobeSignUserInfo`, `createAdobeSignWebhook`,
`deleteAdobeSignWebhook`), matching how `docusign.ts` holds OAuth + Connect provisioning together.

Contract points that are easy to get wrong and are pinned by `adobe-sign.test.ts`:

* **The webhook create id can arrive two ways.** Adobe documents both a body carrying the
  identifier and a `Location` header pointing at the created resource. Reading only the body is how
  a create that actually succeeded still yields a NULL `webhook_id` — the precise failure this
  connector was stuck in — so `extractWebhookId()` checks body then header and **throws** rather
  than returning an empty id. A loud failure beats a silently-null id whose only symptom is every
  future delivery orphaning with no explanation.
* **Credentials are FORM FIELDS, not Basic auth.** This is where Adobe differs from DocuSign; a
  copy-pasted `Authorization: Basic` header fails the token exchange.
* **`api_access_point` from the token response is the shard.** Every REST helper takes it as a
  required argument rather than reading a host from env — a hardcoded shard works for exactly one
  account and 404s/401s for every other.
* **`revokeAdobeSignToken` swallows 400/401/404 by design.** Disconnect calls it, and a token Adobe
  already considers dead must not strand an org in a connected state. 5xx still throws.
* **`deleteAdobeSignWebhook` treats 404 as success** — "Adobe is no longer delivering to us" is the
  desired end state and an already-deleted webhook satisfies it. Any other status throws so
  disconnect can report a webhook it failed to remove.
* **`AdobeSignApiError` follows the SCRUM-2492 shape**: no `body` field at all, and `detail` is
  bounded/PII-scrubbed by construction via `boundedErrorDetail`. Every path here is a non-document
  path (OAuth + webhook metadata), which is what makes attaching a detail safe — and it is what
  makes "the account tier lacks `webhook_write`" legible instead of a mystery 403.
* **`includeSignedDocuments` / `includeDocumentsInfo` are FALSE** on the webhook config, pinned by
  test. §1.6A permits a server-side fingerprint on a deliberate fetch path; it does not permit
  document bytes riding in on a notification body.

**Pre-existing oddity, still deliberately left alone:** `signatureHeader()` in
`api/v1/webhooks/adobe-sign.ts` falls back to `X-AdobeSign-ClientId` as a *signature*. On a
notification that header carries the client id, not an HMAC, so the fallback always fails the
compare and 401s — fail-closed, not exploitable. Do not "fix" it by comparing the client id
instead: that turns a public identifier into the auth check and is a straight auth bypass.
_Last updated: 2026-08-29 (docusign-bilateral PR-2: `resolveDocusignEnvironment` env-tag resolver)._
_Last updated: 2026-09-02 (Adobe Sign parse-layer bounds in code/constraint parity with `organization_rule_events`)._

## What This Folder Contains

Shared OAuth infrastructure — token encryption, HMAC webhook verification, and vendor-specific OAuth/API clients.

| File | Purpose |
|------|---------|
| `crypto.ts` | GCP KMS-based OAuth token encryption/decryption — cleartext never lands in Postgres |
| `hmac.ts` | Shared HMAC-SHA256 webhook verifier (timing-safe, supports base64 and hex encoding) |
| `drive.ts` | Google Drive OAuth client — token exchange, refresh, changes.watch, files.get, channels.stop. **DRIVE-02 (S2)**: `createChangesWatch` now returns the `startPageToken` (additive) and accepts an optional `driveId` to scope startPageToken + changes.watch to a shared-drive corpus. |
| `docusign.ts` | DocuSign OAuth client — consent URLs, token refresh, UserInfo discovery, envelope document fetch, Connect HMAC. **2026-08-29 (R7):** `resolveDocusignEnvironment(baseUri, env?)` — `'prod'\|'demo'` from the connection's `base_uri` (`demo.docusign.net` vs any other `*.docusign.net`), falling back to the existing `DOCUSIGN_DEMO` convention only when `base_uri` doesn't identify an environment. **2026-08-31 (signer backfill):** `fetchDocusignEnvelopeRecipients(args)` — GET `.../envelopes/{id}/recipients`, mapped through `extractCapturedSigners(signers)`, now a thin wrapper around the SHARED `captureDocusignSigners` mapper (`integrations/connectors/schemas.ts`) — the SAME algorithm PR #2474's webhook-side `extractSigners` (`api/v1/webhooks/docusign.ts`) calls, factored out once (2026-08-31 review) so the two could not drift: GUID-shape-pinned, deduped by `recipient_id_guid`, capped at `MAX_CAPTURED_DOCUSIGN_SIGNERS`, fail-soft skip on invalid/partial entries, never name/email. `extractCapturedSigners` itself is used only by `jobs/docusign-signer-backfill-deps.ts`. |
| `docusign-rate-limit.ts` | DocuSign outbound API guard — per-account 3,000/hour local slot budget plus Retry-After-aware 429 retry wrapper |
| `adobe-sign.ts` | Adobe Sign webhook HMAC verification + `RawAdobeWebhookPayload` parse. `agreement.id` / `agreement.name` / `senderInfo.email` are `.max()`-bounded to the `organization_rule_events` column CHECKs (500 / 500 / 320) the webhook handler writes them into |
| `docusign-hmac.ts` | SCRUM-2043: multi-key HMAC verifier + signature header extractor for dual-key rotation |
| `docusign-hmac.test.ts` | Tests for multi-key HMAC verification |

## Do / Don't Rules

- **DO** use `crypto.ts` for all token storage — dedicated symmetric KMS key, not the Bitcoin signing key
- **DO** use `hmac.ts` centralized verifier for all webhook signatures (prevents drift on timing-safe path)
- **DO** route DocuSign cron/job API fetches through `docusign-rate-limit.ts` so refresh/document calls share one per-account budget
- **DO** bound every vendor string a parser admits to what the column it lands in can store, AT THE PARSE LAYER — not wherever a downstream throw happens to land. `RawAdobeWebhookPayload` capped neither `agreement.id` (→ `organization_rule_events.external_file_id`, `char_length <= 500`) nor `senderInfo.email` (→ `sender_email`, `<= 320`). The id was caught late by `NonEmptyString.max(500)` inside `adaptAdobeSign` — but that throw fires AFTER the replay nonce is committed, so it produced a 500 whose retry is answered `200 {duplicate:true}`: the event is lost and the vendor is told it succeeded. The email was not caught at all (`MaybeEmail` has no length cap) and raised SQLSTATE 23514 in Postgres for the same result. A `.max()` on the ingress schema moves both into the handler's bounded 400 + DLQ branch, before any nonce exists. The webhook test reads those bounds out of `supabase/migrations/` so the two cannot drift.
- **KNOWN GAP:** `MaybeEmail` in `connectors/schemas.ts` is length-unbounded and is shared by the DocuSign (`sender.email`) and Checkr (`candidate.email`) adapters, which write the same 320-char `sender_email` column. Capping `MaybeEmail` is one line but changes three handlers' ingress at once — own ticket, own soak covering all three.
- **DO NOT** log response bodies from OAuth token exchanges (contain cleartext tokens)
- **DO NOT** reuse the Bitcoin asymmetric signing key for OAuth token encryption
- **DO NOT** add a `body`/raw-response field to `DocusignApiError` / `DriveApiError` (§1.6A / SCRUM-2492). They carry NO raw response body — a document-bearing response must never ride an error into a logger/Sentry/`last_error`. On `fetchDocusignCombinedDocument`'s non-2xx path (the only document-fetch path), do NOT read the response body and do NOT pass a `detail`; throw status + message only.
- **DO NOT** put `hmacSecret` (or any other secret) on the DocuSign Connect provisioning payload. `hmacSecret` is **not a field on DocuSign's `ConnectCustomConfiguration`** — DocuSign accepts the request and drops it, so it never installed Arkova's signing key while making `buildConnectPayload()` read as though it had. `includeHMAC: 'true'` only asks DocuSign *to* sign; **which** key it signs with is account-side state. Today it is aligned by a DocuSign admin on the customer account; the multi-tenant answer is DocuSign's API-only `integratorManaged` ("HMAC for Partners"), which is **not built** — see the runbook for the four things a story adding it must cover. Runbook: `docs/runbooks/integrations/docusign.md` → "The HMAC key is ACCOUNT-SIDE".
- **DO** keep `deliveryMode: 'SIM'` + `eventData: { version: 'restv2.1' }` riding with the `events` field — DocuSign 400s `INVALID_REQUEST_PARAMETER` on `events` without both (prod failure 2026-07-25, every org connect).
- **DO** use the optional `detail?: string` (3rd ctor arg) ONLY on the NON-document paths (token exchange/refresh, userinfo, DocuSign Connect list/mutation/parse/timeout; Drive token exchange/refresh, startPageToken, changes.watch, channels.stop, token revoke, files.get, changes.list) — whose error body is safe OAuth/API error JSON. Always build it with `boundedErrorDetail(json)` from `utils/byte-safety.ts` (bounded ~500 chars, byte-redacted, PII-scrubbed). Never pass a raw string/body directly.
- **DO NOT** re-add `include_granted_scopes` to `buildAuthorizationUrl` (drive.ts). With the shared Google OAuth client it made one Drive connect inherit EVERY scope that client was ever granted by the account — a 33-scope grant (full `drive`, `gmail.modify`, `calendar`, `contacts`, `classroom.*`, `chat.*`) was observed during FULLSOAK 2026-08 (shared-resource register #9). Absent, Google defaults it to false. Pinned by tests in `drive.test.ts`, `googleDrive.test.ts`, and `drive-oauth.test.ts`.
- **DO NOT** widen `DRIVE_DEFAULT_SCOPES` without a security review — it is the complete allowlist of what a leaked refresh token can reach. Current set (2026-09-21 cutover): `drive.readonly` (every Drive API call this module makes — files.get incl. `alt=media`, files.export, files.list, changes.list, changes.watch, changes.getStartPageToken; confirmed against Google's REST reference), `userinfo.email` (the callback's `oauth2/v3/userinfo` identity lookup; without it `account_id` degrades to a constant and collapses the `org_integrations` upsert key). `DRIVE_LEGACY_REQUESTED_SCOPES` documents the PRE-cutover set for classification purposes only — never re-request it.
- **DO NOT** send a refresh token to the WRONG OAuth client. A refresh token is bound to the client that issued it (`requireClient`'s doc comment). Always classify via `isDriveLegacyGrant(scope)` before calling `refreshAccessToken` — never assume `'current'` is safe for a row you haven't checked.


## PR #2474 release review — 2026-09-05

Environment classification parses the base URI hostname. A vendor string in a path, query, or attacker-controlled domain suffix cannot determine demo/prod. Invalid and non-vendor URIs retain the documented environment fallback.

## 2026-09-05 — Adobe OAuth response body deadlines

The request AbortController was cleared when headers arrived, leaving parseAdobeJson awaiting an unbounded text read. A stalled-token-response regression failed before the fix. All Adobe JSON response paths now use the existing readTextBounded helper with a fixed safe label and ten-second body deadline, translated to AdobeSignApiError 408 without secret-bearing URLs or body content.

## 2026-09-14 — Drive response body deadlines (F-D0-5)

`drive.ts` carried nine `await res.json().catch(() => null)` reads — every external Google call
in the file (token exchange, refresh, revoke, `changes/startPageToken`, `changes.watch`,
`channels.stop`, `files.get`, `changes.list`, `drives.get`). None of them was bounded: the
`AbortSignal`/controller pattern covers the REQUEST, and the body read that follows is a separate
await with no timer, so a Google endpoint that sends headers and then trickles parks the caller
indefinitely (undici's default `bodyTimeout` only fires on total silence). `refreshAccessToken`
and `listChanges` are both reached from `withRunLease`-held cron runs — the drive-changes runner
and the subscription-renewal job — which is the exact shape that disabled SUBMITTED→SECURED
promotion for every tenant for 35+ minutes on 2026-08-12.

All nine now go through `readDriveJson(res, label)`, a thin wrapper over `readJsonBounded`
(`utils/body-read-timeout.ts`) with `DRIVE_BODY_READ_TIMEOUT_MS = 10_000`, matching Adobe Sign.

Contract points pinned by `drive-body-timeout.test.ts`:

* **`label` is a stable OPERATION name, never a Drive URL.** The bounded reader embeds its `url`
  argument verbatim in the message it throws, and that text reaches logs, Sentry and
  `job_queue.last_error`. A Drive URL carries fileIds and driveIds, so the call sites pass
  `'Drive files.get'`, `'Drive changes.list'` and friends instead.
* **A parked body becomes `DriveApiError` 408 with NO `detail`** (§1.6A / SCRUM-2492) — a body that
  never arrived cannot be summarised, and 408 is visibly distinct from a slow-but-alive Drive.
* **A malformed / non-JSON body still degrades to `null`**, preserving the previous
  `.catch(() => null)` behavior at every call site: the caller's own `!res.ok` / missing-field
  check is what then produces the real error. Only the PARKED case is new.
* **`getSharedDriveName` still falls back to the drive id**, timeout included. Its documented
  contract is "falls back to the ID on failure"; a cosmetic display name must neither fail nor
  park a connector flow, so it catches the 408.

**Still unbounded, deliberately:** `readCappedBody` in `fetchDriveFileBytes` — the one
document-bearing path. It uses `arrayBuffer()` / a `for await` over the body stream, neither of
which the `readJsonBounded` / `readTextBounded` primitives cover, and neither of which the
`bounded-body-reads` lint flags. Bounding a size-capped streaming read needs its own primitive and
its own soak; see the Bug Tracker row for this finding.

## 2026-09-14 — Folder picker response deadline

`listChildFolders` uses the shared ten-second `readDriveJson` deadline from PR #2930. A stalled folder-list response becomes a sanitized `DriveApiError` 408; malformed-response and Retry-After handling remain unchanged. A parked-body regression failed before this correction. PR #2912 requires fresh observation for the corrected runtime.
