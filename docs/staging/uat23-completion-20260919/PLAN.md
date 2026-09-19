# UAT-23 spreadsheet import completion plan

Tracking: [SCRUM-5265](https://arkova.atlassian.net/browse/SCRUM-5265) · [canonical Confluence page](https://arkova.atlassian.net/wiki/spaces/A/pages/153223169)

## Scope and delivery

This branch is stacked on UAT-12 commit `5c11f6ab2e70278b2371d53c85ada47469fead8e` so it reuses the canonical queue/instant submission contract without duplicating PR #2966. That local base is not soak qualification for the eventual remote candidate head. Delivery is one new draft UAT-23 PR, subject to the cap of 25 total open PRs including drafts. It does not deploy, merge, mutate a hosted database, send recipient email, or modify release/soak queues.

Row-wise CSV/XLS/XLSX imports retain uploader ownership. One import-wide action (`queue` or `instant`), public description, and private user/organization tag defaults apply to every row; canonical public-field allowlists govern retained metadata. Successful allowlisted AI extraction fields merge into their matching row before submission, with explicit spreadsheet values taking precedence. Recipient email/name drive an auth-backed, unconfirmed pending profile without verified email or organization access. A newly created pending profile gets one automatic provider delivery attempt. An ambiguous delivery is held for reconciliation and is not automatically retried; import replay does not initiate another attempt.

Dashboard/JWT batches call `POST /api/v1/anchor-self-service/bulk`, where selected `org_id` is authorized from the session. API-key SDK, CLI, and MCP imports call the distinct `POST /api/v1/anchor/import` twin and omit `org_id` because tenant scope derives only from the API key. Both routes use the same canonical per-row submission contract. The browser does not fall back to `bulk_create_anchors` or make a second recipient-creation request. A dashboard batch is split into groups of ten for progress, with organization and action captured for the entire invocation. An ambiguous failed chunk is surfaced and is not automatically replayed.

## Verification

Representative browser evidence: [desktop 1280×800](screenshots/bulk-review-1280x800.png) and [mobile 375×812](screenshots/bulk-review-375x812.png).

- Hook tests: canonical request shape, queue default, no legacy RPC, recipient hints, organization scope across chunks, ambiguous failure, and truthful per-row `NEEDS_CREDIT`.
- Wizard tests: AI merge, shared metadata controls, tag normalization/limits, instant capability fail-closed, and completion summaries.
- Standalone browser tests: spreadsheet choice, mapping, extraction, recovery, processing, completion, keyboard order, and overflow at 1280×800, 375×812, 1280×480, and 375×480.
- Source typecheck and scoped lint must pass before handoff.

## Premortem and release limits

- A user changes organization during upload: the request closure retains the starting organization for every chunk; regression coverage delays chunk one and changes props before chunk two.
- A response is lost after acceptance: the client does not retry automatically, avoiding a second charge or misleading result; the error remains visible for manual reconciliation.
- Credit or instant capability becomes stale: the wizard preserves the chosen instant action, blocks submission, and requires the user to explicitly choose queue; the server remains authoritative per row and `NEEDS_CREDIT` is reported separately from failure.
- AI results appear but are discarded: only successful fields merge by row index, preserving existing spreadsheet metadata; failed extraction rows remain unchanged.
- Recipient provisioning races and orphans: only the canonical worker receives hints; concurrent rows must converge on one unconfirmed auth-backed pending profile, never grant membership/org access or mark email verified, and claim one provider attempt for first activation. A provider timeout is held without automatic retry. A profile created before downstream anchor/link failure remains unprivileged and auditable for bounded reconciliation; trigger/helper failure must not escalate role, membership, verified-email state, or expose another tenant.
- Activation delivery is at-most-once automatically, not a guarantee of exactly-once receipt: one durable claim permits one provider attempt, ambiguous provider outcomes remain held for manual reconciliation, and neither import replay nor a background loop retries automatically.
- Shared tags leak: user and organization tags remain private metadata and use the UAT-12 normalization/quantity/length contract. Public description is labeled separately.
- Partial completion is mistaken for atomic success: created/skipped/failed and instant outcomes remain per-row; no whole-import rollback or blanket success is claimed.

## Proposed T3 window

Use the common identity, isolation, honesty, side-effect, clock, and rollback controls in the UAT-12 plan, applied to the eventual UAT-23 remote PR head—not the current local base. Reserve an exclusive clean-mirror database and worker after inventory; capture full source/base SHAs, image digest, flags, database ref, schema ledger, driver SHA, and pre/post identity. Plan 25 hours at five-minute cycles and require a complete closing cycle that starts only after both wall-clock and monotonic 25-hour floors have elapsed (therefore at least 301 completed cycles). Calculate record/credit/queue capacity from the executable driver before admission. Missing cycles, identity drift, an assertion failure, or another soak touching the rig invalidates the window.

Targeted probes must cover CSV/XLS/XLSX row imports and the one-file alternative; UI via the JWT self-service route plus TypeScript SDK, Python SDK, CLI, npm MCP, and hosted MCP via the API-key import route, with no legacy fallback; queue and instant with one-credit-per-row disclosure and insufficient-credit partial outcomes; shared/private metadata; AI merge/retry; selected-org change midflight; concurrent pending-profile provisioning and orphan reconciliation; no verified-email/org-access escalation; one provider attempt for first activation, ambiguous delivery held, and no automatic retry; strict raw-payload rejection before clients transmit unknown/file-byte fields; chunk transport loss with durable receipt recovery; per-row `NEEDS_CREDIT`, `HELD`, duplicate, and failure outcomes; privacy/public projection; and desktop/mobile/keyboard layouts. Rollback rehearses worker/client rollback as one compatible unit while preserving anchors, receipts, profiles, the activation-delivery claim table (including held claims), ledger/audit rows, and retry evidence. No production or real-money/network side effects are authorized.

Native verification commands are the exact commands recorded in this plan's handoff: root focused Vitest/typecheck/lint and standalone Playwright; `packages/sdk` Vitest plus standalone `tsc`; isolated `uv --no-project` Python pytest and Ruff; `packages/api-cli` Vitest/tsc; `sdks/mcp-server` Vitest/tsc; `services/edge` tests/typecheck; root MCP manifest parity; native PostgreSQL activation-claim and canonical-import scripts under `scripts/uat23/`. Hosted probes remain no-side-effect clean-rig work and cannot be substituted with mocks.

Out of scope: owner reassignment, automatic organization access, the three-hour/daily policy, purchase caps, production migration/deployment, and changes to UAT-12 release disposition.
