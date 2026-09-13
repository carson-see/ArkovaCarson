# docs/api/agents.md

Developer-facing API documentation. Engineering mirrors and guides for the Arkova Verification API.

## 2026-09-12 — documenting `webhooks:manage` enforcement, and why openapi.yaml was not the place (SCRUM-3981)

`/api/v1/webhooks*` now requires the `webhooks:manage` scope. Three documentation surfaces changed
and one deliberately did not:

- **`README.md`** — the Webhooks row of the surface matrix now lists all ten routes and names the
  scope, and the paragraph under the canonical scope table says plainly that a scope being listed
  there is not a claim that it is enforced, pointing at the census test that says which are.
- **`webhooks.md`** — Authentication section states the scope requirement, the ORG_ADMIN overlay on
  the five mutating routes, and that a cross-org read is 404 rather than 403; both error tables gain
  the two 403 rows.
- **`services/worker/src/api/v1/docs.ts`** — the served spec: `x-arkova-required-scopes` plus a 403
  on each of the ten operations, pinned by `docs.test.ts`.
- **`openapi.yaml` — untouched, on purpose.** It documents no `/webhooks` path at all, so "add the
  403" would have meant authoring ten operations into a file `canonical-sources.md` demoted on
  2026-07-28 for having drifted 12+ routes behind the runtime spec. Writing a fresh, second
  description of this surface there would recreate the drift the demotion was meant to end. It is
  still parse-checked by `scripts/ci/check-api-scope-vocabulary.ts` for scope VOCABULARY parity, and
  the vocabulary did not change here — no scope was added, renamed, or removed.

## 2026-09-05 — the `arkova_` rename vs §1.8: what moved and what did not (SCRUM-4465 / BUG-2026-09-02-001)

§1.8 freezes the published verification API schema: no breaking changes without a `v2+`
prefix and a 12-month deprecation. The MCP tool rename touched a field inside that spec,
so the decision is recorded here rather than left to be re-litigated by the next reader.

**`operationId` did not change, and must not.** `search`, `verify`, `get_anchor`,
`list_orgs`, `get_organization`, `get_record`, `get_fingerprint`, `get_document` are the
same strings they were. They name REST operations, and generated clients key off them —
renaming one silently breaks every consumer that regenerated from the spec. The v2 REST
paths did not move either.

**`x-agent-usage.tool_name` DID change, to `arkova_<operationId>`.** That is an `x-`
vendor extension, which OpenAPI defines as ignorable by any tool that does not recognise
it. Measured, not assumed: the only readers of `x-agent-usage` in this repository are
`scripts/ci/check-api-contract-drift.ts` and two test files
(`services/worker/src/api/v2/openapi.test.ts`,
`services/worker/src/mcp-tool-schemas.test.ts`). Neither SDK reads it, no runtime code
path reads it, and it is not part of any request or response body. So changing it is not
a §1.8 breaking change — nothing that §1.8 protects can observe it.

**And it is a security exception regardless.** The bare tool names are what caused an
agent to sweep local secrets (BUG-2026-09-02-001); a field that advertises a tool name to
an agent has to advertise the name the server actually registers, or the annotation is
worse than absent. A deprecation window is not available for a defect of that shape.

`check-api-contract-drift.ts` now derives the expected value as `arkova_${operationId}`
rather than comparing the two for equality, which is what keeps the two identifiers
pinned to each other while they differ by a fixed prefix.

## 2026-09-05 — three ways these docs were wrong about the rename, and they are different failures

Worth separating, because the fix for each is a different discipline.

**`agent-workflows.md` — right in the table, wrong in the example.** The surface matrix
listed `arkova_search` / `arkova_get_anchor`; the three `MCP:` fenced blocks under it
still called `search({...})` and `get_anchor({...})`. The existing test read the matrix,
so the document was correct exactly where it was checked and broken where it is copied.
`agentWorkflows.test.ts` now parses the `MCP:` blocks and rejects any call whose name is
not a registered tool. REST paths and SDK method calls in the neighbouring blocks are
deliberately out of that scope — they are correct bare.

**`mcp-tools.md` — the changelog was rewritten into the present.** The v1.0 / v1.1 / v1.2
rows were re-spelled with `arkova_*` names, so the table claimed the March 2026 release
added `arkova_verify_document`. A changelog exists to answer "what was this client calling
when they integrated"; rewriting it destroys the only record of that. Restored verbatim
from `main`. When a rename lands, the changelog rows are the one place you do NOT sweep —
add a row (v3.0 does exactly this) instead.

**`README.md` — the tool list was a live claim, and it was false.** It told new
integrations to prefer `search` / `verify` / `list_orgs` / `get_anchor`. There are no
aliases: v3.0 removed the bare names on purpose, so every name on that list was
unroutable. Now lists all 16 registered tools and says the old names are gone rather than
deprecated. The Python paragraph one screen above was listing SDK METHODS in the same
bare-backtick style, which reads as a second tool namespace; it now says methods, and two
factual errors surfaced while checking it against `client.py` (the four v2 detail methods
were missing, and "write/anchoring workflows remain in the TypeScript SDK" is false —
`anchor()` and `anchor_bulk()` are on the Python client).

Standing rule this leaves behind: `mcp-tools.md` is gate-checked for tool coverage and
claim parity, `README.md` and `agent-workflows.md` are not equally covered. Anything you
write about tool names in this folder should be phrased so a gate could check it, and if
it is executable, a gate should.

## 2026-07-28 v1 spec canonical source flip (pentest-prep API contract audit)

- `openapi.yaml` is DEMOTED — no longer canonical. It had drifted 12+ mounted `/api/v1` routes behind the runtime-served spec (`services/worker/src/api/v1/docs.ts`, served at `GET /api/docs/spec.json`), which is what a pen tester enumerating the API actually sees. `docs.ts` is now canonical, matching the v2 pattern (`services/worker/src/api/v2/openapi.ts`). See `docs/api/canonical-sources.md`.
- New CI guard: `services/worker/src/api/v1/docs.routeParity.test.ts` extracts real routes from a set of v1 leaf routers (via `router.stack`, not a hand-transcribed list) and fails when a mounted route is missing from `openApiSpec`. It also re-reads `router.ts` to confirm its assumed mount prefixes still hold. Currently covers the routers touched by this audit (`verify-proof`, `attestations`, `webhooks`, `cle-verify`, `ai-review`, `ai-integrity`, `ai-embed`, `ai-feedback`) — the extraction logic is router-agnostic, so widening coverage to the rest of `/api/v1` is additive follow-up, not a rewrite.
- Fixed a real spec bug found in the same audit: `POST /ai/integrity` never matched anything — the router actually mounts `POST /ai/integrity/compute`. Also added the previously-undocumented `GET /ai/integrity/{anchorId}`.
- `openapi.yaml` is kept (not deleted) because `scripts/ci/check-api-scope-vocabulary.ts` still reads it for `API_KEY_SCOPES` vocabulary parity, and `docs/api/README.md` / `packages/sdk/README.md` link it as an offline/Swagger-import convenience. Its endpoint list is NOT guaranteed complete — do not add new hand-written entries there expecting them to be authoritative.

## 2026-05-22 Scope Notes

- Document anchor submit with both accepted write scopes: `anchor:write` and `write:anchors`.
- `POST /api/v1/anchor/submit` is a compatibility alias for `POST /api/v1/anchor`; new integrations should prefer `/anchor`.
- `GET /api/v1/usage` requires `usage:read`. General read/search scopes do not include usage analytics.

## Files
- **`openapi.yaml`** — frozen OpenAPI 3.0.3 spec for API v1 (authentication, rate limits, all endpoints).
- **`v2-migration.md`** — v1-to-v2 migration guide with deprecation calendar (v1 sunset 2027-04-23).
- **`webhooks.md`** — webhook developer guide: registration, HMAC verification, retry policy, SSRF protection.
- **`agent-workflows.md`** — canonical agentic call sequence for REST v2, MCP, TypeScript, and Python SDKs.
- **`mcp-tools.md`** — MCP server tool reference (15 read-oriented tools, `anchor_document` gated).
- **`canonical-sources.md`** — engineering source map linking repo files to API surfaces.
- **`v1-deprecation-communication-plan.md`** — customer communication plan for v1 deprecation.
- **`arkova-py-example.ipynb`** — Jupyter notebook example for the Python SDK.

## Conventions
- v1 schema is frozen; additive nullable fields only. Breaking changes require v2+ prefix.
- Confluence is the documentation source of truth; these files are engineering mirrors/notes.
- A published description is a CLAIM (§1.13 R-7), governed like any other. When runtime behaviour and
  a description disagree, one of them is a defect — say which. 2026-08-15: `/nessie/query` is marked
  DISABLED + `deprecated: true` in `openapi.yaml` with the 503 `nessie_disabled` envelope documented
  as its only reachable response (CTO ruling R-1), and `search_anchors` in `mcp-tools.md` now
  leads with lexical substring matching rather than semantic similarity (BUG-026 — a false
  description, not a broken search; no behaviour changed).
- `mcp-tools.md` mirrors the live tool descriptions in `services/edge/src/mcp-tools.ts`, and
  `public/.well-known/mcp/server-card.json` mirrors them again. **Nothing checks the three for text
  parity** (`tests/infra/mcp-manifest-parity.test.ts` covers names and schemas only), so edit them
  together, by hand, in the same change.

## 2026-08-31 — M2: `ProofBundle` in `openapi.yaml` had drifted from the implementation

When migration 0427 added `tx_inclusion_branch` / `tx_block_index` to the emitted
`proof_bundle`, only the in-worker prose blob in
`services/worker/src/api/v1/docs.ts` changed. This file's `ProofBundle` schema —
which carries an explicit `properties` map AND a `required` list — was untouched,
so the published contract and the implementation disagreed and nothing in CI
compared them.

- Both fields are now in `properties` AND in `required`, with `nullable: true`.
  The route always EMITS the keys; nullability is expressed by `nullable`, not by
  omitting them, so publishing them as optional would misdescribe the response.
- The descriptions state the byte orientation, the fold rule, and — explicitly —
  that `tx_block_index` does NOT arm the CVE-2012-2459 guard on the bitcoin tree
  (that needs the block's total transaction count, which the bundle does not
  carry). Contrast `leaf_count`, which does arm the equivalent app-tree guard.
- `services/worker/src/api/v1/openapi-proof-bundle-contract.test.ts` now compares
  this schema's key set against what the API's own `buildProofBundle` emits, in
  both directions, so the next drift fails CI instead of shipping. It lives in
  the WORKER suite on purpose: a first version sat in the root suite and compared
  against the frontend `buildProofPacket`, which carries the same keys today but
  would not have caught a field added to the API bundle alone.
## DI-775 / SCRUM-3538 — `webhooks.md` event tables are CI-checked against the worker

The event-type tables in `webhooks.md` are a registration surface, not just prose: an event Arkova
dispatches but does not document is the same defect class as one it does not offer in the picker.
`scripts/ci/check-webhook-event-registration-drift.ts` now parses the first cell of every event-table
row and compares that set against `PAYLOAD_SCHEMAS_BY_EVENT_TYPE` in
`services/worker/src/webhooks/payload-schemas.ts`, in the required root `Tests` job.

Two consequences for edits here. A **prose mention** of an event does not satisfy the check — only a
table row does, deliberately, since the tables cross-reference sibling events inside their own
cells. And a per-event payload `data` paragraph belongs under the family heading whose table lists
it (`anchor.superseded` sits under Anchor Lifecycle, not Compliance).

When wording a row, keep "subscribable since <story>" honest: the CRUD allowlist is derived from the
worker schema map, so an event is API-subscribable from the moment its schema is registered, which
may be long before any UI or SDK lists it.

## 2026-09-12 — Attestation Lifecycle section added to webhooks.md (SCRUM-3982)

`docs/api/webhooks.md` gained an "Attestation Lifecycle" table for
`attestation.created` and `attestation.revoked`, plus their payload field
lists. This file is one of the six mirrors that
`scripts/ci/check-webhook-event-registration-drift.ts` compares against the
worker's `PAYLOAD_SCHEMAS_BY_EVENT_TYPE`; it is read as a SET (order-insensitive)
and only the FIRST cell of a markdown table row counts as a listing, so an
event merely mentioned in prose does not satisfy the gate.

Honesty note (§1.13 R-7): `attestation.revoked`'s Status cell says the emit
point is not yet reachable in production, because it is not — the revoke
handler's dispatch is guarded on an org id its ownership query never selects.
The contract is published so subscriptions can be registered ahead of the fix,
the same shape as `credential.verified`.
