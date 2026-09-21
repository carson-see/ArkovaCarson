# UAT-24 completion: verification and soak plan

Proposed T3 plan, not a completed soak or release authorization. Canonical scope
and evidence live in [SCRUM-5142](https://arkova.atlassian.net/browse/SCRUM-5142)
and [its Confluence page](https://arkova.atlassian.net/wiki/spaces/A/pages/148307969).

## Scope and publication boundary

Close the complete UAT-24 requirement: personal, organization and sub-organization
folders; authorized administrator visibility; nested hierarchy; truthful bulk
moves; connector sorting; and applicable API, SDK, CLI, MCP and webhook parity.
Extend canonical folders and existing permissions, never create a second model.

The candidate starts at existing PR2968 head
`ec108c4220787876494c61a9b04c3cc25212de4b`. Preserve that release-owned branch,
its historical observations and do-not-merge hold. Publish corrections as a
separate held Draft stacked on the verified parent, after independent review and
a fresh queue/head/count check. The founder cap is 30 total open PRs, including
drafts. Pin the eventual full candidate/base SHAs in the PR and canonical page;
this starting SHA is not the final candidate identity.

Pre-publication reconciliation found the release-owned parent advanced to
`5a9c3b392a53ccb405de7d8f2db65c88a7acfef3` and introduced contractual-cap
migration0475. The unpublished folder privacy correction is therefore0480;
0475 is preserved unchanged. Review and integrate that exact parent, then rerun
combined checks before publication. No historical local test is attributed to
the integrated candidate until actually rerun.

## Start gates

- Every acceptance scenario below has an executable targeted probe or a named
  manual step with captured expected/actual results. Missing probes block launch.
- Fresh inventory assigns an exclusive clean database and worker. Do not reuse,
  reconfigure, reset or stop another session's rig, lease, observer or fixtures.
- Record candidate/base SHA, driver SHA, database ref, migration ledger and DDL
  hashes, worker revision/image digest, deploy log and feature/config readbacks.
  Require staging-honesty preflight `environment_type=clean_mirror` before and
  after the window. A tag alone is not database isolation.
- Rehearse the additive privacy-policy migration and exact schema/cache/ACL
  readback. Local minimal PostgreSQL fixtures are not whole-schema Supabase
  replay, hosted Auth proof or generated whole-schema type verification.
- Use approved synthetic accounts with real authenticated AAL2 JWTs for owner,
  ordinary member, exact admin, approved ancestor admin and platform admin;
  separate API keys for exact parent/child tenants. Prove missing/AAL1/expired
  sessions and revoked keys deny at the mounted middleware boundary.
- No production writes, real emails, real-money purchases, real network securing,
  source-provider account changes or hosted configuration changes are authorized
  by this plan. Provider tests use fixtures unless separately approved.
- Compute fixture capacity from the actual driver: setup plus cycles times new
  records per cycle plus retry margin. Verify daily and lifetime caps and cleanup
  before launch; the historical B4 cap failure is not passing evidence.

## Observation window

Plan 25 hours, at least 301 complete five-minute cycles, with both monotonic and
wall-clock floors. The final complete cycle must START after both floors. Sample
source/runtime/schema identity before and after every cycle. Exercise repeated
connector triggers, applicable daily flush and per-org isolation on the exact
candidate. Health-only requests do not qualify changed folder behavior.

Any gap, failed assertion, timeout, private-data disclosure or identity drift
invalidates the window. Preserve failures; no silent fixture repair or clock
credit across a corrected runtime. Budget and process supervision must cover
the entire window and bounded closing cycle.

## Acceptance probes

| Capability | Required result |
|---|---|
| Global personal privacy | Owner reads through REST and direct authenticated PostgREST; peers, org/ancestor/platform admins cannot read that owner's context-free folder. Anonymous and NULL identity deny. |
| Contextual personal visibility | Owner and authorized exact/approved ancestor/platform admins read only intended organization-context folders; ordinary peers cannot. Admin read authority does not grant personal mutation. |
| Member drill-down | JWT-only member-context and roster endpoints require exact/approved-ancestor/platform authority. Target membership comes from org_members, never a stale profile primary org. Explicit DTO roles reflect exact membership; roster retains a stable 500-member bound with encoded-wire-byte-bounded hydration. Test removed members, secondary members, missing/AAL1/expired JWTs and API keys. |
| Organization/sub-org selection | URL/session-selected organization controls query keys, reads and new writes. No fallback to primary-org authority while context is loading. Switching scope clears stale selections/dialogs; late responses cannot mutate new context UI. |
| Personal hierarchy context | A child's owner and nullable context match its parent, including globally personal roots when an organization is selected. Cross-owner/context parents deny. |
| Organization hierarchy | Exact owner/admin can manage exact-org folders; approved ancestors have read-only access. Unapproved parent linkage and unrelated tenants deny. API-key tenant remains an upper bound. |
| Nesting integrity | Create/rename/reparent/delete valid trees, reject self/descendant/cross-owner parents, and reject a real two-session cycle race. Parent view includes intended descendants with bounded cycle-safe traversal. |
| Bulk moves | Valid rows move; denied/not-found rows have truthful per-row results. 207 is not blanket failure or blanket success. Failed selections remain actionable; only failed rows retry. Systemic database failures atomically abort rather than inventing partial success. |
| Destination revalidation | Revoked membership and inaccessible destinations deny at mutation time. Source revocation stops auto-ingestion/new binding; retained organization-owned folder content is not deleted or made inaccessible merely because the provider disconnected. |
| Connector sorting | Approved active exact-scope binding produces the canonical destination on new, replayed, duplicate and reconnect paths. Preserve existing placement and privacy. Duplicate folder names are distinguishable by hierarchy/provider in configuration. |
| Cross-client contract | UI, REST, served/static OpenAPI, TS/Python SDK, CLI and both registered MCP implementations cover applicable list/create/update/reparent/delete/bind/move operations. Preserve existing v1 compatibility and 100-row bounds. |
| Python patch/retry | Omitted parent leaves hierarchy intact; explicit null moves to root; omitted name is not sent as null. Ambiguous folder-write failures are never automatically replayed. |
| Events and privacy | Applicable folder lifecycle and record-folder-change events carry public folder IDs and bounded counts, not private folder names, source IDs or record-owner identifiers. No event on a denied mutation; provider dispatch failure must not report an already committed move as uncommitted. |
| Browser experience | Production components served from the isolated worktree at 1280px and 375px support keyboard actions, long/deep names, scope switches, empty/error states and partial recovery without clipped controls. Mocked boundary fixtures are labeled as such. |

## Rollback rehearsal

1. Capture exact pre-change policies/functions and known-good worker identity on
   the assigned rig. Pause only candidate writes and confirm in-flight work is
   settled before testing rollback.
2. Prefer worker/client rollback while retaining the tightened privacy policy.
   Reinstating the permissive platform/global-personal policy while users have
   access is not an acceptable serving fallback. If exercising old policy text
   for proof, revoke intake/read access for the entire rehearsal.
3. Reapply compensation and assert owner allow, contextual admin allow and
   global-personal admin deny under real authenticated roles. Confirm preserved
   folder IDs, parent relationships, assignments, bindings and audit history.
4. Verify older compatible clients still work against retained additive schema;
   no folder, anchor, binding or evidence deletion is part of rollback.
5. Resume only the assigned rig after probes pass; a changed candidate requires
   a new observation window unless an explicit exact-head exception is granted.

## Premortem

- **Worker-only privacy proof misses direct access.** Test actual RLS under a
  non-bypass authenticated role, not just a service RPC with actor parameters.
- **Legacy primary-org state contaminates selected child.** Test member/admin
  roles that differ between primary and active organizations, with delayed
  reads and in-flight writes across switching.
- **A screenshot passes before content appears.** Wait for actual dialog/page
  animations to settle and visually inspect the saved desktop/mobile artifacts.
  A DOM visibility assertion alone is not readable screenshot evidence.
- **A mocked verifier pretends to prove MFA.** Execute the mounted discriminator
  with locally signed JWTs through the real verifier; mocked provider boundaries
  remain disclosed and do not establish hosted Auth behavior.
- **Null versus omission destroys hierarchy.** Exercise every Python sync/async
  patch combination and bind/unbind; keep wire-level assertions.
- **Automatic retry duplicates mutations/events.** Force 429, 503 and ambiguous
  transport outcomes; assert one request and explicit caller recovery.
- **Partial result loses remaining work.** Mix allowed/denied IDs, then retry;
  assert moved IDs are removed and failed IDs remain visible and selected.
- **Overcorrection changes policy.** Retain global owner privacy, intended
  ancestor read access, usable retained disconnected-source folders and existing
  authenticated v1 identifier compatibility. Do not invent connector immutability.
- **Historical evidence is misattributed.** The parent release exception and old
  seven-cycle observation do not qualify this new substantial correction head.
- **Draft checks appear green because skipped.** Report executed, skipped,
  cancelled and failed CI separately; preview capacity/baseline failures remain
  release blockers, never grounds to change infrastructure without approval.

## Completion and release distinction

The requested session checkpoint requires fixed scoped defects, independent
review, proportional local verification, held Draft publication, this plan and
its independent premortem, plus verified Jira/Confluence/source-document updates.
Jira remains In Progress while real release gates are unmet. Record exact test
commands/counts and honest coverage limits at final publication. No merge,
deployment, hosted migration or actual soak has been performed by this plan.
