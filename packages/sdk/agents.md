# packages/sdk/agents.md

`arkova` — TypeScript SDK for the Arkova Verification API (PH1-SDK-01 + INT-01).

## Structure
- **`src/`** — client, types, barrel export.
- **`examples/`** — usage examples.
- **`vitest.config.ts`** — test runner config.
- **`package.json`** — published to npm; works in Node.js and browser.

## Conventions
- Client-side fingerprinting via SHA-256 (documents never leave the user's device).
- Published via `.github/workflows/publish-sdk.yml`, or manually via `scripts/release/publish-npm.sh`.
- Must stay in sync with `integrations/shared/src/fingerprint.ts` algorithm.
- **npm name is unscoped `arkova` (CTO ruling 2026-08-18), superseding the 2026-08-01
  `@carsonarkova/sdk` scoped-package ruling below.** Parity with the PyPI package, which already
  publishes unscoped as `arkova`. An unscoped name needs no npm org at all — first-publish
  ownership is per-package, not per-org — so the `carsonarkova`-vs-`arkova` org-scope question
  that blocked the 2026-08-01 attempt is moot for this package. Confirmed free via
  `npm view arkova` (E404) on 2026-08-18. `@arkova/*` scoped aliases can follow later if the
  founder creates the `arkova` org on npmjs.com, but nothing requires that today.
  `publishConfig.provenance` was dropped from `package.json` in the same change: provenance
  attestation needs CI/OIDC (`id-token: write`) and fails outright on a manual laptop publish,
  which is the near-term path (`scripts/release/publish-npm.sh`, no npm auth on the agent
  machine — operator finishes the publish themselves). `.github/workflows/publish-sdk.yml`
  still requests `--provenance` explicitly on its `npm publish` invocation and has real OIDC via
  `permissions: id-token: write`, so CI-path provenance is unaffected by this change — only the
  publishConfig default was removed. Restore `publishConfig.provenance: true` once the CI
  workflow is the proven, exercised publish path rather than the untested one.
  **Historical record, not current guidance:** the 2026-08-01 `@carsonarkova/sdk` rename (PR
  #1785) and its org-scope rationale are preserved in `HANDOFF.md` `## History` — read there for
  what actually happened, not here. `packages/embed` (`@arkova/embed`) is unaffected by either
  ruling and keeps its own scope question open (see `scripts/publish-packages.sh`).

## Methods added since PH1-SDK-01
- `anchorBulk(inputs, options?)` (W3 / HAKI-REQ-02 wiring, 2026-07-28) — wires `POST /api/v1/anchor/bulk` (`services/worker/src/api/v1/anchor-bulk.ts`). Rows accept either a pre-computed `fingerprint` or raw `data` (fingerprinted client-side via the existing `fingerprint()` helper — never both, never neither). Caps at `BULK_ANCHOR_MAX_ROWS` (1000, mirrors the server's `.max(1000)`) and throws `ArkovaError({code:'batch_too_large'})` client-side rather than auto-chunking — chunking would split intra-batch duplicate detection and credit deduction across requests. `dryRun` / `duplicateStrategy` / `batchId` map to the server's `dry_run` / `duplicate_strategy` / `batch_id`. See `client.test.ts` `describe('anchorBulk', ...)` for the full contract (cap boundary, mixed input types, dry-run, per-row errors, 409 duplicate-fail, 402 insufficient-credits).
- **`LICENSE`** (2026-07-28, engineering-counsel review): MIT text copied verbatim from `packages/verifier-cli/LICENSE`. Listed in `package.json` `files` so it actually ships in the published tarball — `"license": "MIT"` alone doesn't discharge the obligation. See `scripts/security/package-license-files.test.ts`.
- **`package.json` `repository`/`author`** (2026-08-18, npm-publish clean-room verification): were missing entirely — added, matching the sibling `sdks/mcp-server/package.json` pattern (`repository.directory: "packages/sdk"`). `keywords` also had `"bitcoin"` (§1.3-banned, indexed on npmjs.com) — replaced with `"credentials"`. Guarded going forward by `src/package-metadata.test.ts`.
- **README/type-doc terminology + accuracy pass** (2026-08-18, npm-publish clean-room verification, same change as the `sdks/mcp-server` P0 fix): fixed "Bitcoin anchor status"-style prose (→ "network"), x402 "wallet" references (→ "signer" — this SDK's x402 config takes a real third-party on-chain signer, a different concept from the §1.3 "Wallet → Fee Account" UI-copy mapping, which is about *Arkova's own* product surface), and added two accuracy disclosures the README previously lacked: (1) the "Nessie semantic search" section (`query()`/`ask()`) now states up front that `GET /api/v1/nessie/query` is gated off in production today (`ENABLE_PUBLIC_RECORD_EMBEDDINGS` switchboard flag, confirmed off) and returns 503 until launch; (2) the x402 section now states payments currently settle on Base Sepolia (confirmed via `services/worker/src/config.ts`'s `x402Network` default `eip155:84532` and `deploy-worker.yml`'s prod env-var, which sets the same value), not Base's production network. See `src/terminology.test.ts` for the standing guard.

## 3.0.0 — breaking release (2026-09-02, packages/integrations truth pass)
CTO-decided fixes landed on top of the unmerged PR #2274 (`feat/npm-publish-prep`) packaging
base described above. This is a **major** bump — two of the fixes below change observable
client behavior:

- **Retry-safety fix (critical).** `private fetch()`'s HTTP-status retry branch (429/500/502/
  503/504) checked `attempt >= this.retry.retries` but never `isSafeRetryMethod(method)` — only
  the network-error `catch` branch checked it. A non-idempotent `POST` (e.g. `webhooks.create`)
  that got back a transient 503 was retried anyway and could create duplicates server-side. Now
  gated identically to the network-error branch: `!isSafeRetryMethod(method) ||
  !shouldRetryResponse(response) || attempt >= this.retry.retries`. `GET`/`HEAD`/`OPTIONS` still
  retry on 429/5xx as before. See `client.test.ts` `describe('retry safety ...')`.
- **Key hygiene (breaking for anyone inspecting the instance).** `apiKey` and `x402Config` were
  TS `private` fields — still own, enumerable properties at runtime, so `JSON.stringify(client)`
  and `Object.keys(client)` leaked the raw API key (and the x402 payer address). Moved to real
  ECMAScript `#apiKey` / `#x402Config` private fields (`tsconfig.json` already targets ES2022,
  which supports them natively — no target bump needed). `JSON.stringify(new Arkova({apiKey:
  '...'}))` and `Object.keys(client)` no longer contain the key. See `client.test.ts`
  `describe('Arkova', ...)` "never leaks..." tests.
- **Type drift closed.** The worker's `VerificationResult` (`services/worker/src/api/v1/
  verify.ts` L134-247) emits `proof_availability`, `proof_availability_note`,
  `fingerprint_source`, `fingerprint_rederivability`, `fingerprint_rederivability_note`,
  `ferpa_notice`, `directory_info_suppressed`, `merkle_proof_hash`, and `bitcoin_block` — none of
  these were typed or mapped on the SDK side. Added to `RichVerificationFields` (camelCase per
  SDK convention) and wired through `mapRichVerificationFields`. `bitcoinBlock` is a literal
  camelCase mirror of the frozen v1 field name (§1.8 frozen schema — not renamed to "network" the
  way user-facing §1.3 copy would be, because this is a typed contract mirror, not UI copy).
  Fields the worker OMITS rather than nulls (`proof_availability(_note)`,
  `fingerprint_rederivability(_note)`, `ferpa_notice`, `directory_info_suppressed`) are mapped as
  `undefined` when absent, not coerced to `null`. See `client.test.ts` `describe('verify', ...)`
  the two new tests immediately after the compliance-controls tests.
- **Missing exports.** `OrganizationDetails`, `RecordDetails`, `FingerprintDetails`, and
  `DocumentDetails` existed in `types.ts` and were the real return types of `getOrganization` /
  `getRecord` / `getFingerprint` / `getDocument` (`client.ts`), but were never re-exported from
  `index.ts` — a consumer could call the methods but not name the return types without reaching
  into `arkova/dist/types` directly. Added to the barrel. See `src/index.test.ts`.

Version bumped `2.2.0` → `3.0.0` (`package.json`, `package-lock.json`) for the two behavior
changes above; `src/package-metadata.test.ts` pins `3.0.0` and no longer claims parity with the
published `arkova-mcp-server`/PyPI `arkova` versions (those packages are unaffected).
`.github/workflows/publish-sdk.yml`'s job name updated to reference `arkova (packages/sdk)`
instead of the retired `@carsonarkova/sdk` name; its tag pattern (`sdk-v*`) and publish steps
are otherwise unchanged. `scripts/publish-packages.sh` already pointed at `arkova` /
`packages/sdk` from the PR #2274 base — no further repointing needed there.

README install-section bash fence had `# or` comments between the npm/pnpm/yarn commands —
replaced with a single `npm install arkova` fence plus prose for the pnpm/yarn alternatives, per
the no-inline-comments-in-bash-fences convention for this pass.

## Disabled surfaces
- 2026-08-15, CTO ruling R-1: `arkova.query()` and `arkova.ask()` hit `/api/v1/nessie/query`, which now
  fails closed with `503 {"code":"nessie_disabled","enabled":false}` — so both **throw `ArkovaError` on
  every call**. Nessie is permanently disabled by standing founder directive. The README section and
  both JSDoc blocks say so; a throw from these methods is NOT "no matching records", because no search
  runs. Behaviour is unchanged (the client already threw on non-2xx) — what changed is that the docs no
  longer advertise a capability we do not serve. Do not remove the methods or types: existing installs
  need to recognise and handle the disabled response. **Republishing to npm is founder-reserved** — this
  edit updates the in-repo docs only.

## 2026-09-05 — retry rule: safe method OR idempotent call (PR #2589 review)

The 3.0.0 "retry-safety fix" above was correct about non-idempotent writes and **over-corrected**
everything else. Gating the HTTP-status branch on `isSafeRetryMethod(method)` alone silently
dropped 429/5xx retry for *every* `POST` — including three calls that are idempotent server-side
and were retrying before the fix. Against `origin/main` that is a behaviour regression on the
rate-limited paths, not a hardening.

**The rule, in both branches (status and network-error):** retry when the method is safe
(`GET`/`HEAD`/`OPTIONS`) **OR** the call site opts in with `{ idempotent: true }`, the private
`fetch()` wrapper's new third argument. `private fetch(path, init?, options?)`; `options.idempotent`
never reaches `globalThis.fetch`.

Opted in:
- **`verifyBatch`** — a read expressed as `POST` (the body carries the ID list) served on the
  10 req/min batch tier, i.e. the call most likely to see a `429`. Retrying creates nothing.
- **`anchor`** / **`anchorBulk`** — idempotent on the fingerprint server-side (`README.md`
  "Idempotency: the same fingerprint returns the same `publicId`"). A retried anchor cannot
  double-create.

Left non-retrying (unchanged, and the whole point of the 3.0.0 fix): `webhooks.create`,
`webhooks.update`, `webhooks.delete`, `webhooks.test`.

Stated in three places so the contract cannot drift: `README.md` config comment + the "Retries are
built in" paragraph, and the `RetryConfig` JSDoc in `src/types.ts`. Tests:
`client.test.ts` `describe('idempotent-call retry opt-in ...')` — verifyBatch retries a 429 and
honours `Retry-After` (asserts `sleep(3000)`), anchor and anchorBulk retry a 503, `webhooks.create`
does not. The pre-existing `describe('retry safety ...')` block still passes untouched.

**Discarded retry bodies are released.** The status branch now does
`await response.body?.cancel().catch(() => {})` before sleeping. A retried response was previously
dropped on the floor with its body unread, holding the connection until GC — in Node's undici that
is a real socket leak under repeated 429s, which is exactly the regime retries put you in. The
`catch` swallows an already-locked/errored stream; optional chaining keeps mocked responses (no
`body`) working. Tests: `describe('discarded retry responses release their body')` — cancel fires
once per retried attempt and never on the returned response, and a rejected `cancel()` still
retries.

## 2026-09-12 — WebhookEventType gained the attestation events (SCRUM-3982)

`attestation.created` and `attestation.revoked` were appended to the union in
`src/types.ts` and to the exhaustive `WEBHOOK_EVENT_TYPE_PIN` in
`src/client.test.ts`. Two traps hit while doing it, both worth knowing:

- **No semicolons in the comments inside that union.** The PR-time gate
  `scripts/ci/check-webhook-event-registration-drift.ts` locates the union with
  `/export type WebhookEventType\s*=([\s\S]*?);/` — non-greedy to the FIRST
  `;`, so a semicolon in a comment truncates the region and the gate reports
  the trailing members as missing.
- **`src/terminology.test.ts` counts banned words in shipped source**, comments
  included. The word "block" in a new comment bumped the ratcheted count and
  failed the suite. Reword rather than raising the expected count.

`attestation.revoked` is typed and subscribable but its worker producer is not
reachable yet — no delivery of that event has occurred. See
`services/worker/src/webhooks/agents.md`.

## 2026-09-19 — Finality webhook event types

The SDK webhook union includes `anchor.revocation_anchored` and
`attestation.active`, matching the worker registry.
