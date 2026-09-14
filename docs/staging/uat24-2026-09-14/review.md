# SCRUM-5142 / UAT-24 review and soak plan

## Product boundary

Migration 0462 extends the existing 0365 `public.folders` model. A globally
personal folder (`USER`, `context_org_id=NULL`) remains visible only to its
owner. A personal folder with an explicit organization context is visible to
its owner, platform administrators, and administrators reached through an
approved organization-parent chain. Ordinary members cannot read a peer's
personal folders. Personal writes remain owner-only; organization writes
require exact-org administration.

Existing folder rows and anchor assignments are not rewritten. A legacy global
personal folder can continue to contain its owner's records from multiple
organizations. Every new assignment is checked against folder user ownership
and, when present, exact organization context.

## Surface parity

| Surface | Folder contract |
|---|---|
| Database | Same-owner nested folders, RLS, atomic API RPCs, partial bulk move, connector destinations |
| Web app | Nested personal/org trees, member-profile contextual tree, bulk move, Rules destination selector |
| REST/OpenAPI | List, create, update/reparent, delete, connector bind/clear, bounded bulk move |
| Outbound webhooks | Folder create/update/delete and record-folder change schemas |
| Inbound connectors | Existing Drive/DocuSign materialization auto-sorts inside the locked 0445 transaction |
| TypeScript SDK | `client.folders` mirrors REST |
| Python SDK | Sync and async folder methods mirror REST |
| Hosted and npm MCP | One `arkova_manage_folders` action tool forwards to REST |
| Discovery | Served OpenAPI, server card, MCP guide, `llms.txt`, and `llms-full.txt` |

## Pre-mortem

| Failure | Control and evidence |
|---|---|
| Parent admin sees unrelated global personal data | Context must be non-null and follow approved ancestry; native owner/admin/member assertions |
| Ordinary member reads a peer's contextual folders | Admin helper is distinct from membership; native peer denial and API test |
| Concurrent reparenting creates a cycle | Owner-scoped advisory transaction lock; two real PostgreSQL sessions race A→B/B→A |
| Service-role API checks race the write | Service-only RPC combines identity, row lock, authorization, and mutation |
| Org API key inherits issuer's other tenants | API org is an upper bound for list/source/destination; direct RPC adverse cases |
| Org-only key gets a 500 or false human attribution | Exact-org operation works with key-id creator attribution; both-null principal denied |
| Connector source squats or crosses owners | Direct authenticated binding denied; active exact-scope connection verified atomically |
| 0445 reuses an anchor and skips auto-sort | Artifact-link trigger handles explicit and unique-conflict reuse in the same transaction |
| Trigger order skips folder ownership check | Routing trigger runs before the owner guard; member fixture proves user/context equality |
| Reconnect leaves a revoked connection id | Validated new connection refreshes the reused destination; revoke/reconnect assertion |
| Bulk webhook describes multiple tenants as one | Explicit first-success state and `IS DISTINCT FROM`, with null/org and org/org cases |
| SDK/MCP drift from REST | Focused client tests plus six-surface MCP manifest parity |

## Local verification

- Native PostgreSQL 17 runner: rollback, reapply, RLS/API adverse cases, actual
  0445 materialization branches, reconnect, and concurrent cycle all pass.
- App typecheck and 25 focused migration/hook/folder component tests pass.
- Worker typecheck and 623 focused folder/router/materializer/rule/webhook tests pass.
- TypeScript SDK build and 112 tests pass.
- Python SDK 174 tests and Ruff pass.
- npm MCP build and 50 tests pass.
- Hosted edge MCP 61 focused tests and typecheck pass.
- MCP/discovery parity suite passes 115 tests with 17 registered tools.

The native runner uses a minimal surrounding fixture while executing the real
0365, 0445, and 0462 files. It is not a full production-schema replay.

## Safe staging soak

Use a fresh isolated T3 database and application revision pinned to the final
integration head. Do not use an active shared rig. Replay the complete migration
chain, including the separately owned 0459 signup/profile wiring when it is part
of the integration candidate, then record migration ledger, schema, policies,
grants, lock duration, and baseline folder/anchor counts.

Run real AAL1/AAL2 JWT, personal-key, principal-org-key, org-only-key, ordinary
member, exact-admin, approved-parent-admin, foreign-org, and both-null denial
controls. Exercise the browser flows on My Records, an authorized member
profile, and Rules. Exercise REST, both SDKs, hosted MCP, npm MCP, authenticated
inbound Drive/DocuSign operations, and outbound webhook delivery. Include fresh,
explicit-reuse, unique-conflict, historical cross-owner, pre-filed, and
reconnect connector cases.

On that isolated database only, execute the dependency-ordered rollback,
confirm legacy folders and assignments remain, restore 0445/0365, reapply 0462,
and rerun the adverse suite. Start the soak clock only after all controls pass.
For 24 hours, watch API 4xx/5xx by route, webhook failures, connector artifacts
stuck in processing, folder constraint violations, deadlocks/lock waits, and
partial bulk results. Any unexplained authorization success, cross-tenant event,
stuck materialization, or schema drift resets the clock after correction.
