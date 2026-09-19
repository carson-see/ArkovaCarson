# UAT-17 completion — T3 staging qualification plan

Status: planning only. No rig has been provisioned, no candidate deployed, no soak clock started, and no hosted email has been sent by this follow-up.

## Candidate and authority

- Story: SCRUM-5145; Confluence specification/evidence: page 148340737.
- Stack dependency/base: existing PR #2964 head `8c1561f6fff5080d8ebc7cf1b6cc28f88ea491d6` (`cto/uat17-email-20260914`). The new follow-up draft must target that branch so it does not duplicate PR #2964.
- Follow-up head: `PENDING` until root commits and pushes the independently reviewed local tree. Before admission, bind every deployment and evidence artifact to the full 40-character head read back from the remote draft PR, not merely a local branch SHA.
- Authorization: founder permits exactly one new draft PR for UAT-17 while the repository remains below the hard cap of 25 total open PRs, including drafts. Root owns the final live-count check and PR creation. Keep the PR Draft and `do-not-merge` until separate release authority and all qualification gates are satisfied. This plan grants no authority to open additional PRs, mark ready, merge, deploy, apply migrations, alter Auth/SMTP settings, or send external email.
- Risk: T3. Migration 0470 changes tenant association and privileged membership creation.

## Environment admission

Use a dedicated isolated Supabase project and separately wired Cloud Run staging service, or an explicitly exclusive verified-clean rig. Do not share a mutable database with UAT-23 or another migration/auth soak.

Before deployment:

1. Freeze the exact follow-up head and dependency SHA. Run the changed-file tier detector; expected minimum is T3.
2. Confirm current project ref, worker service/tag, image digest, migration ledger, and no active reservation collision. Add an active `rig-reservations.json` entry only when provisioning actually begins.
3. Run `staging-honesty-preflight.ts` against the exact project and current production ref. Admission requires `environment_type=clean_mirror`, all checks passing, and a committed artifact. `fixture_seeded`, `soak_artifact`, unexplained migration rows, or another active owner abort admission.
4. Deploy a candidate containing PR #2964 plus this follow-up. Apply 0470 only to this isolated/exclusive rig. Record deploy-log ID, revision, tag URL, image digest, base SHA, candidate SHA, and numeric migration ledger row.
5. Verify `/health` reports the candidate SHA and healthy database. Never send probes to the production worker or production Supabase project.

## Qualification window

Run at least 25 continuous hours, exceeding the repository's 24-hour T3 floor, at a five-minute cadence. Cycle 1 is the coverage gate: every required probe below must pass before the clock is accepted. Require at least 301 complete scheduled cycles, zero unexplained failed cycles, no worker/DB identity drift, and observation across all scheduled auth/member driver cycles. The closing cycle must **start after both** the recorded wall-clock deadline and an independently recorded monotonic-duration deadline, then finish with every required probe passing; a cycle that started before either floor cannot close the window. A process being alive is not evidence; each cycle records concrete database and HTTP postconditions.

### Required probes every cycle

- Identity: exact worker git SHA, revision/tag, image digest, Supabase ref, migration 0470 presence, and bounded latency/error envelope.
- Auth configuration readback: hosted GoTrue reports email confirmation enabled, `otp_expiry=900`, and resend `max_frequency=90s`. Repository `config.toml` alone is not proof.
- Callback contract: valid confirmation reaches the intended callback and mandatory MFA gate; expired, replayed, tampered, and mismatched locally remembered identity remain truthful and actionable.
- Verified-domain membership:
  - unconfirmed email creates no membership;
  - confirmed email matching exactly one `domain_verified=true` organization creates exactly one member row and profile association;
  - unverified exact domain creates nothing;
  - two verified organizations with the same normalized domain create nothing;
  - admin-provisioned placement remains authoritative;
  - tenant A cannot acquire or alter tenant B membership.
- MFA: AAL1 human requests are denied before member mutation; same-user AAL2 succeeds for an authorized owner/admin. Machine/service authority remains restricted to its intended server boundary.
- Add existing member:
  - owner/admin and platform admin can add one ACTIVE existing account by exact email to the exact authorized org;
  - ordinary member, unrelated admin, deleted/deactivated actor, suspended/payment-suspended org, malformed/unknown input, and missing/ambiguous normalized email are denied with bounded responses and no existence leak to unauthorized callers;
  - concurrent identical requests yield one membership and one audit row, with the other response idempotent;
  - a same-role replay is idempotent, while a different-role replay returns bounded `409 membership_role_conflict` without changing membership, profile, or audit state;
  - audit failure rolls back membership and profile backfill;
  - retry does not duplicate audit or change role unexpectedly;
  - rate-limit responses are observed under bounded authorized-admin abuse without DB writes.
- Invitation dependency (#2831): create, delivery-failure, safe retry, acceptance, exact-org role mapping, and roster refresh remain working. Do not duplicate or overwrite open #3008's failed-resend refresh fix or #3003's mobile People layout fix.
- Data hygiene each cycle: no cross-tenant rows, no orphan membership, no duplicate audit, no raw email in worker logs/Sentry, no unexpected Auth/profile/invitation residue.

### One-time and boundary probes

- Run `scripts/uat17/native-pg-verified-domain-member-add.sh` from the exact head. It is a minimal owned PostgreSQL fixture, not full hosted-schema proof. Preserve its concurrency, rollback, null-role, ambiguity, confirmation, and catalog/type assertions.
- Run the focused worker/frontend tests, root and worker typechecks with complete dependencies, lint, copy lint, documentation-pointer checks, and the full required CI matrix.
- Run production-source browser checks at 1280px and 375px for signup confirmation, 90-second disabled/resend state, expired callback, member-add click, Enter-key action, double-submit prevention, errors, focus, and overflow. The checked-in standalone member fixture has no authenticated session; it proves controls/layout only, not membership authorization.
- With explicit release-owner approval and a dedicated non-production mailbox, deliver one real branded signup email. Verify Arkova sender identity/subject/body, 15-minute link behavior, callback origin/path, one successful confirmation, expiry after 15 minutes, 90-second resend rejection/acceptance boundary, replay behavior, and MFA routing. Redact addresses/tokens from evidence. Do not use real customer addresses.

## Capacity and outbound-email controls

- Local/unit/native/browser loops use captured Auth/worker responses or owned database rows and send no real email.
- Continuous cycles must not send external email. Use a captured provider or an isolated sink that proves enqueue/provider calls without internet delivery.
- The single real-mailbox probe is manual, bounded, approved, and excluded from the five-minute loop. Abort if provider configuration could target arbitrary/customer recipients.
- Load is bounded to one normal cycle per five minutes plus explicit small concurrency bursts. Record 429s, Postgres waits, and Cloud Run saturation; never raise capacity or quotas during the clock to conceal failures.

## Premortem and abort criteria

| Failure mode | Early signal | Abort / restart rule |
|---|---|---|
| Repository config differs from hosted GoTrue/SMTP | readback is not 900s/90s or delivered branding/link differs | do not start, or stop clock; correct config through an authorized change and deploy a new exact head/config identity |
| Wrong tenant selected for a domain | membership appears for unverified/ambiguous domain | immediate security abort; quarantine rig evidence and require code/data remediation plus a new 25h window |
| Service-role RPC bypasses exact-org authority | unrelated/AAL1/deactivated actor succeeds | immediate security abort and invalidate all window evidence |
| Concurrent retries duplicate membership/audit | counts exceed one or result pair is not winner+idempotent | abort; fix transaction/constraint behavior and restart on a new head |
| Role-mismatch replay silently succeeds or mutates state | requested role differs but response is not bounded 409, or membership/profile/audit changes | abort; fix conflict handling and restart on a new head |
| Partial membership survives audit/profile failure | membership/profile delta remains after forced fault | abort; rollback candidate and restart after atomicity fix |
| Email enumeration or PII reaches logs | unauthorized status differs by account existence, raw email in logs/Sentry | abort and treat captured evidence as sensitive; scrub before retention |
| MFA or callback causes an account wall | confirmed AAL1 bypasses MFA, or valid AAL2 cannot recover | abort; preserve break-glass access and correct routing before restart |
| Shared/dirty rig contaminates results | preflight not clean, ledger/fixtures change, foreign supervisor detected | do not start or stop immediately; use a fresh isolated rig |
| Candidate changes after clock start | runtime/migration/auth/config SHA differs | invalidate clock and restart; only detector-confirmed T0 evidence-only delta may use the documented allowance |
| External email escapes an automated loop | provider shows unexpected recipients/volume | stop driver and outbound integration immediately; notify operator and do not resume without approval |

Any worker 5xx, SQL error, authorization mismatch, identity drift, failed required probe, unexplained cycle gap, or evidence writer failure stops acceptance. Diagnose honestly; never delete evidence or repair the ledger to make the window green.

## Rollback rehearsal

The rollback unit is coordinated worker plus RPC behavior:

1. Disable signup/domain-auto-membership intake and the exact-email add-member UI/route before changing the database function. Disable/capture invitation/member writes as needed; existing reads remain available.
2. Route the isolated worker tag to the last known-good revision and confirm the new `/organization-members/:id/existing` action is unreachable/disabled.
3. In the isolated rig only, rehearse dropping `add_existing_org_member` and restoring the prior auto-association function while intake remains disabled. The prior function accepts unverified matching domains and must never serve live intake.
4. Prove no in-flight membership/audit transaction or delivered invitation is lost, and existing memberships remain readable.
5. Reapply 0470, restore the candidate worker, repeat the authorization/concurrency probes, then re-enable intake only after verified-only behavior passes.

Production rollback must follow the same order. A schema-only rollback while the new worker is live breaks writes; a worker-only rollback while auto-association intake remains live can expose the old verified-domain defect. No production action is authorized by this plan.

## Evidence and closeout

Seal only with exact remote-PR-head CI green, 25h/301-cycle summary whose final passing cycle started after both timing floors, raw cycle artifacts, pre/post clean preflight, deploy-log export, rollback/reapply record, mailbox/config evidence, 1280/375 screenshots, per-org isolation result, and named human approval. Root updates SCRUM-5145, Confluence 148340737, and the single authorized draft PR. Keep Draft/`do-not-merge` until release authority is explicit. No merge/deploy claim is valid until those gates actually pass.

### Local browser evidence already captured

- `screenshots/member-add-native-1280.png`
- `screenshots/member-add-native-375.png`

These screenshots come from the standalone production-component fixture on loopback port 5197. It intentionally has no hosted seed/session; the visible failure state confirms click/Enter recovery and layout only. It does not prove JWT/MFA, worker authorization, SQL mutation, email delivery, or hosted configuration.
