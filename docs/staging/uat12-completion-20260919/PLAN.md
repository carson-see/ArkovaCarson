# UAT-12 completion follow-up: proposed T3 verification window

Engineering plan, not soak evidence. Canonical documentation is
[SCRUM-5139 in Confluence](https://arkova.atlassian.net/wiki/spaces/A/pages/148275201).
The session's preparation gate requires a reviewed draft PR and this premortemed
plan; release still requires its own CI, migration and staging admission.

Carson explicitly authorized reuse of existing PR2966 only after ownership and
queue checks, including returning it to Draft. The zero-new-PR cap remains.
Keep its merge hold in place; no merge, deployment or other PR reuse is authorized.
Preserve older observations as history, not evidence for the corrected head.

## Identity and start gates

- Use reused PR2966's exact immutable candidate head and current base, not its older
  head or its founder no-resoak exception. Record both full SHAs, image digest,
  revision, deployment log, driver SHA, flags, database ref and schema ledger.
  Resolve the candidate head from the remote PR after its authorized push; local
  pre-publication identity is not the final soak identity.
- Assign an exclusive isolated database and worker only after a fresh inventory
  proves ownership. Do not reuse, reconfigure, stop or reset an existing soak.
- Run staging honesty preflight against that exact database and require
  `environment_type=clean_mirror`. Record preflight and post-window readbacks.
- Apply additive corrections on the assigned rig before the candidate worker.
  Record schema/ACL/function definitions. No production or ledger repair is
  authorized by this plan. Function signatures are unchanged; verify generated
  catalog contracts still match rather than introducing unrelated type churn.
- Disable real-money and real-network side effects in the harness. Label mock
  Stripe/network coverage explicitly; it does not prove real settlement or
  chain inclusion. Do not expose raw files, private tags, secrets or tenant IDs
  in public evidence.
- Verify health, authenticated scope, required flags and all targeted probes
  before starting the clock. A generic health probe cannot qualify this change.

## Window and capacity

Plan 25 hours (at least the required 24-hour T3 floor), five-minute cycles, and a
complete closing cycle beginning after both wall-clock and monotonic floors.
Use at least 301 cycles and observe the applicable scheduled triggers plus daily flush.
Every cycle records source/runtime/schema identity before and after its probes.
Any missing cycle, assertion failure or identity drift invalidates the window.

Before launch, compute each scope's required capacity from the executable driver:
`cycles * new_records_per_cycle + setup_records + retry_margin`. For example,
three new records per cycle with 20 setup records and 10% margin requires at
least 1016 records in the affected lifetime pool. Do not assume a default free or
sandbox plan can sustain this. Check daily allowance across the UTC boundary,
lifetime cap, purchased credits, queue capacity and fixture teardown policy.
Any bounded fixture entitlement increase needs the release owner's approved,
audited operation; do not bypass the quota implementation being tested.

The proposed personal-three / organization-twenty-five purchase cap and
zero-before-refill rule is not approved and is not part of this candidate or
capacity model. Before separate implementation, define whether pending or HELD
debits count, whether “zero” means spendable balance or total entitlement, and
whether organization scope is exact-org or an organization family. Credits stay
nonexpiring under this plan; do not infer a purchase cap from the daily create
quota or alter conservation accounting to simulate one.

## Required scenarios and assertions

| Scenario | Required observable result |
|---|---|
| Personal queue, tags omitted | Canonical RPC succeeds without org-only403; no instant debit or job. |
| Parent and selected child queue | Exact selected scope and policy; no parent-credit substitution. |
| Two concurrent identical requests | One anchor; one daily-quota unit; identical scoped receipt; no duplicate intent/job/debit. |
| Daily last-slot contention, different fingerprints | Exactly one success; denial leaves no anchor/tags/intent/job or excess usage. |
| Same user's fingerprint in another scope | Preserve existing global active fingerprint uniqueness: bounded409; no existing record disclosure and no quota charge. |
| Duplicate with changed/omitted/equal tags | Supplied changed tags409; omitted/equal tags idempotent; neither mutates prior tags. |
| User/org tag suggestions | Exact scope, including >100 newer unrelated tags and second/third comma-separated token; no stale-scope result. |
| Queue versus instant | Explicit choice preserved across UI, API, SDK/CLI and applicable MCP/webhook surfaces; instant feature-off fails closed. |
| Hosted MCP canonical submission, every accepted call shape | With the hosted flag and write scope enabled, bare fingerprint, legacy optional record fields, explicit queue/instant, description and private-tag calls all cross the same canonical worker create boundary. Prove matching quota/idempotency/tag/action results and no legacy RPC or direct-table insert. Missing worker configuration or caller key fails closed with no database write. Capture bounded request/response plus registry/server-card identity in the mocked, no-side-effect harness. The hosted canonical-routing correction and its regression tests are mandatory launch prerequisites. |
| Empty credits to funded recovery | NEEDS_CREDIT remains honest; purchase one exact-scope pool; explicit fresh-funded rearm creates one replacement job and eventual debit. |
| Purchase replay/concurrency | Exact event/session grants once; mismatch denied; org conservation zero; personal purchase transaction unchanged. |
| Historical accounting compensation | Only exact receipt/GRANT matches corrected; replay inert; unmatched/malformed audit rows preserved. |
| Failure before network submission | Proven safe failure refunds once, never twice; status reflects actual settlement. |
| Ambiguous network outcome | HELD without unsafe refund or resubmission; truthful status survives API retry. |
| Auth/tenant boundaries | Wrong owner/org/member scope denied with bounded response; NULL/missing service role cannot execute privileged grant/create. |
| NULL canonical-create inputs | NULL action, fingerprint or tag arrays return bounded invalid_request; no anchor/tag/intent/job/quota mutation. |
| Delayed checkout and rapid clicks | Native popup/link usable under delayed response; one purchase request; fingerprint preserved in original tab; no duplicate rearm POST. |
| Status outage/malformed response | Visible bounded error and working retry; no fabricated success or unsupported credit claim. |
| Privacy/public projection | Private tags never appear in public evidence/webhooks; description disclosure matches public projection. |
| Desktop/mobile/keyboard | Native1280px/375px interactions; short-height controls reachable; no horizontal clipping; screenshot evidence bound to served worktree. |

Each assertion needs an executable targeted probe or an explicitly named manual
step with captured input/output. Unimplemented probe rows block soak launch; a
green aggregate test count cannot replace a missing scenario.

## Rollback and reapply rehearsal

1. Record the known-good worker and the exact pre-change function definitions.
2. Pause candidate intake and purchase fulfillment on the assigned rig. Preserve
   queued events/intents for replay; do not drop audit rows or reverse a real
   customer grant. Confirm no in-flight purchase call or canonical create before
   function rollback.
3. Treat 0474 as one worker+RPC change: with writes still disabled, restore both
   the prior worker quota reservation and the prior RPC body, or restore neither.
   Rolling back only 0474 makes organization creates unmetered; rolling back only
   the worker double-charges quota. Rehearse worker rollback while retaining
   compatible additive schema. The old
   org-purchase implementation double-books conservation, so restoring0461 is
   **not** an acceptable purchase-serving fallback. If exact function rollback
   is rehearsed, purchases remain disabled throughout.
4. Reapply corrections, verify privileges/schema-cache reload, replay the same
   purchase event and retry, and require zero conservation divergence with one
   grant/debit/job. Retain immutable compensation history.
5. Re-enable only the assigned rig's candidate paths after targeted checks pass;
   establish a fresh full window if runtime/tested code changes.

## Premortem and abort criteria

- **False completion:** prior tests mocked the quota boundary. Require real SQL
  contention and real middleware tests in addition to mocked route tests.
- **Fixture exhaustion:** the prior B4 window failed after seven passing cycles
  at its lifetime cap. Capacity is a preflight gate; never relabel that failure.
- **Cross-tenant drift:** bind actor, selected scope, fingerprint and query keys;
  exercise selection changes and async late responses, not only static fixtures.
- **Release-head drift:** reuse is authorized for PR2966 only. Recheck its
  ownership, exact remote head and absence from the queue before a fast-forward
  push. Keep it Draft and held. Bind review to the selected candidate head/base;
  rerun overlap checks and obtain a new review after any rebase or retarget.
- **Accounting rollback regression:** never serve purchases through restored
  duplicate-grant code. Abort if the rehearsal violates this invariant.
- **Quota-policy drift:** 0474 derives the exact organization tier and carries
  the current 100 / 10,000 / 1,000,000 daily limits transactionally. Compare those
  values to the worker tier table in CI and at soak admission; any mismatch is
  a release-blocking contract change, not a documentation correction.
- **Observer loss:** missing process or observation gaps are not elapsed soak.
  Preserve failure artifacts and start a new window only after correction.
- **Incomplete surface parity:** check actual registered routes/tools, client
  signatures, OpenAPI and applicable event payloads, not manifest names alone.

Abort for any private-data disclosure, unauthorized scope, double grant/debit,
quota leakage, orphan intent/job, fabricated status, unsafe refund, dirty
preflight, capacity shortfall, identity drift, failed probe or observation gap.
Do not repair data silently to keep the clock running. Log defects in the
Confluence master tracker and obtain release-owner disposition before restart.

## Evidence handoff

Publish the exact-head test commands/results, independent review findings and
fixes, native SQL output, desktop/mobile screenshots and CI links in the draft
PR and canonical Confluence page. Keep the Jira release story In Progress until
its separate production/release gates actually pass. This file grants no merge,
deployment, new infrastructure, payment or production-database authority.
