# UAT-19 completion: verification and proposed soak

Proposed T3 plan, not an executed soak or release approval. Canonical scope and
status: [SCRUM-5268](https://arkova.atlassian.net/browse/SCRUM-5268) and
[Confluence](https://arkova.atlassian.net/wiki/spaces/A/pages/153256009).

## Candidate and authority

Initial base: `ec108c4220787876494c61a9b04c3cc25212de4b`, the inspected
release-owned PR2968 head. Preserve its branch, holds and historical evidence.
Record the final candidate/base and any reviewed UAT-24 dependency at publication;
the initial base is not the final candidate. One held Draft for UAT-19, after
independent review and a fresh total-open-PR count below the founder cap of 30.
Do not merge, mark ready, deploy, alter hosted schema/configuration, provision a
rig, send real emails, buy credits or perform real network securing under this
plan. Run local tests against mocks and session-owned native fixtures only.

## Acceptance matrix

| Surface | Required proof |
|---|---|
| Organization profile | Exact route organization supplies records, folder tree, queue actions, social links and Secure Document dialog. No primary-org fallback, including when the caller belongs to several organizations. |
| Search and visibility | Actual server-paginated organization registry search; personal search remains requester-owned. Exact owner/admin sees authorized organization records; ordinary members cannot inherit primary-organization admin authority. Empty/error/loading and delayed old responses are covered. |
| Folders | Main profile supports actual create, rename, nested filtering, delete and bulk move where permitted, not navigation-only placeholders. Ordinary members retain intended read/filter scope and cannot mutate org folders. Preserve global-personal privacy and approved contextual admin visibility from UAT-24. |
| Queue | GET pending, manual run, collision context and resolution all use the same exact selected organization. Explicit org input must match the selected public anchor and collision key. Malformed, missing, stale or unauthorized context fails closed without cross-tenant rows or writes. |
| Authority | Exact owner/admin membership allows; unrelated membership, demotion/revocation and stale primary profile roles deny. Test nullable profile flags/roles and service-role RPC calls directly; HTTP middleware is not the sole protection. Preserve only explicitly supported platform/approved-parent policy, consistently across all four operations. |
| Resolution integrity | Actual PostgreSQL concurrent same-selection replay returns one receipt and one audit. Competing different selections in one set serialize without deadlock or double winner. Unrelated collision sets remain independent. Post-lock checks prevent stale decisions. Preserve ACL, row locks, audit IDs and immutable receipts. |
| Secure document | Selected-org instant versus queue uses canonical submission/quota/credit controls. Show held or pending outcomes truthfully; no duplicate charge or alternate insert path. No payment-policy expansion. |
| Profile links | Only approved safe web protocols render as links; no executable URLs, opener access or private metadata leakage. Missing socials produce a usable layout. |
| Browser | Actual production components at 1280px and 375px; keyboard, long names, partial move failures, role changes, context switches during reads/writes, unavailable queue and error recovery. Clearly label mocked boundaries; screenshots alone are not authenticated hosted proof. |

## Start gates and observation

Assign an exclusive clean database and worker after operator approval. Check live
ownership and leases; never reset or borrow another team's running rig. Record
full candidate/base and driver SHAs, migration0477 hash and ledger, actual ACL and
function bodies, database ref, worker revision/image digest and configuration
readbacks. Require `environment_type=clean_mirror` before and after the window.
Read back actual pg_proc ACL/search_path, enum/composite types and current
anchors/org_members/audit triggers; trigger or type drift is a stop condition.
Native minimal fixtures do not establish whole-schema replay, generated type
parity, hosted Auth or production behavior. The local browser fixture exercises
actual OrgProfile, registry, folder dialogs and AnchorQueuePage components, but
stubs authentication/network boundaries and SecureDocumentDialog internals.
Canonical securing behavior is inherited UAT-12 evidence, not newly proven by
this browser fixture.

Use synthetic users with real mounted AAL2 sessions and separate tenant API keys
on the assigned rig. Include AAL1, expired/missing sessions and revoked keys.
Rehearse additive migration application, schema cache refresh and rollback on
that rig first. Compute fixture capacity as setup plus cycles times records per
cycle plus retry margin, against both daily and lifetime limits. A capacity
failure invalidates the probe; it is not a waived test.

Plan 25 hours and at least 301 complete five-minute cycles. The closing cycle
must start after both monotonic and wall-clock floors. Each cycle samples exact
runtime/schema identity and exercises changed queue authorization and resolution
behavior, not health-only requests. Cover the applicable daily queue flush using
the approved mock-network profile. Preserve failed assertions and evidence.
Any timeout, missing cycle, privacy leak, identity drift or failed assertion
invalidates the window; corrected code requires a fresh window. No silent fixture
repair or reuse of historical parent-PR soak credit.

## Premortem and rollback

- Primary-profile compatibility silently restores a revoked administrator: test
  absent and demoted exact memberships at HTTP and native RPC boundaries.
- SQL three-valued logic bypasses a negative guard: test NULL role/platform
  flags and use explicit fail-closed authorization outcomes.
- Same-selection concurrency passes while different selections deadlock: run
  both contenders concurrently against distinct candidates in the same set,
  enforce a bounded timeout, and assert one coherent terminal result.
- UI route changes but an old response changes rows, selection or success state:
  defer responses across context transitions and verify identity-keyed rendering.
- A folder-only fixture hides organization-page integration defects: include
  actual OrgProfile and queue page browser flows and disclose mocked services.
- A successful resolve is retried after an ambiguous transport failure: assert
  server idempotency, one audit and truthful client recovery, without blind write
  retries or duplicate manual-run jobs.
- Manual run does not have a request-id receipt. An ambiguous response requires
  status/reload-before-retry, not a claim of idempotent manual-run submission.
- Membership is revoked while a contender waits on the collision lock: repeat
  authorization after the wait and deny before returning a receipt or mutating.
- A held collision lock blocks an unrelated set: explicitly run the independent
  set concurrently and assert bounded completion without waiting for that lock.
- Stacked dependencies change during review: compare exact parent head and
  changed-file inventory again, integrate only reviewed scope and rerun tests.

Prefer disabling candidate queue mutations and rolling back the worker/client
while retaining safe additive authority corrections. Never restore stale-role
authorization while traffic is enabled. Preserve all resolution/audit records;
do not delete receipts or reopen rejected candidates as a rollback shortcut.
The old worker remains signature-compatible with retained0477; do not restore
the pre0477 function body as an enabled-traffic fallback.
Reapply the corrected function and rerun allow/deny/concurrency tests before any
authorized restart. Record actual rollback evidence separately from this plan.

## Completion checkpoint

Draft preparation requires fixed scoped defects, independent changed-file review,
debugging and proportional local evidence, a held Draft, independently premortemed
plan, and read-back-verified Jira, Confluence and canonical source-document
updates. Pin exact test commands/counts and remaining limits. Jira remains In
Progress when staging/release gates remain unmet. No actual soak is claimed here.
