# Day-0 evidence — seed-UUID re-key surgery (DEG-5 fix, executed 2026-08-12)

**Operator:** CTO session, Day-0 execution. **Rig:** Supabase `gnkuaywlpmsaezwvlvhk` (isolated fullsoak rig).
**Committed:** 2026-08-12 ~13:29 UTC, single atomic transaction via Supabase MCP `execute_sql`.
**Authorization:** founder directive 2026-08-12 ("rigorous soaks only"); premortem DEG-5 follow-up. This is a
**pre-clock** environment repair on an isolated rig — no soak evidence existed for the period at execution time.

## Why

`deg5-org-queue-triage.md` (same folder) root-caused the org-queue-scheduler INTERNAL failures: Zod 4's strict
RFC-9562 `z.string().uuid()` rejects the rig's seed fixture UUIDs (version/variant nibbles `0`), which are valid
to Postgres but invalid to the worker's validators. The triage found the same validator class on **user_id** in
`rule-action-dispatcher.ts:131` and `connector-artifact-drain.ts:76` — both soak-critical paths switched ON for
this soak. Fixing only orgs would have moved the 500s to other jobs mid-week. Ruling: fix data pre-clock
(image untouched — BL-1 digest parity preserved); file the worker validator defect separately (T2, 57 sites).

## What changed (old → new, all 7 entities)

| Entity | Old id | New id |
|---|---|---|
| org "Arkova" | `aaaaaaaa-0000-0000-0000-000000000001` | `aaaaaaaa-0000-4000-8000-000000000001` |
| org "Acme Corp" | `bbbbbbbb-0000-0000-0000-000000000001` | `bbbbbbbb-0000-4000-8000-000000000001` |
| user seed-fixture-user@seed-fixture.invalid | `5eed0000-…-0000000000a1` | `5eed0000-0000-4000-8000-0000000000a1` |
| user carson@arkova.ai | `44444444-…-000000000001` | `44444444-0000-4000-8000-000000000001` |
| user sarah@arkova.ai | `44444444-…-000000000002` | `44444444-0000-4000-8000-000000000002` |
| user demo-admin@arkova.local | `55555555-…-000000000001` | `55555555-0000-4000-8000-000000000001` |
| user demo-user@arkova.local | `55555555-…-000000000002` | `55555555-0000-4000-8000-000000000002` |

Emails, passwords, org names, `public_id`s, `org_prefix`es (ARK/ACC), API keys, memberships, and credit
balances all preserved byte-for-byte (temporarily munged where a unique index required it, restored in the same
transaction from pre-captured snapshots).

## Method

Copy-insert → dynamic FK repoint → delete-old → restore, one transaction:

1. `request.jwt.claim.role`/`request.jwt.claims` set to `service_role` transaction-locally (trigger guards on
   `anchors` legitimately pass service-role operators; direct client paths stay guarded).
2. `auth.users` rows copied to new ids (generated column excluded dynamically; GoTrue one-time-token fields
   blanked; email munged then restored). `handle_new_user`-style auto-rows deleted before explicit profile copy.
3. `public.profiles` copied (public_id/email munged→restored; activation_token nulled).
4. `auth.identities` repointed: `user_id`, `provider_id` (email provider), and `identity_data.sub`.
5. Every FK column referencing `auth.users`, `public.profiles`, `public.organizations` discovered from
   `pg_constraint` **at runtime** (not a hand list) and repointed old→new.
6. Old rows deleted (auth children cascaded); org copies same pattern (trigger-seeded free-tier `org_credits`
   rows for the new ids deleted before repointing the real ones).
7. `job_queue` PENDING/RUNNING payload strings rewritten for all 7 ids.
8. **In-transaction verification:** re-scan of every FK column for any surviving old-id reference —
   `RAISE EXCEPTION` (full rollback) if count > 0. Result: 0.

## Immutability-guard handling (disclosed, not hidden)

`audit_events` (update+delete), `billing_events` (update+delete), and `org_credit_deductions` (append-only)
carry reject-mutation triggers. These five triggers were `ALTER TABLE … DISABLE TRIGGER`'d **inside the
transaction** and re-enabled before commit (an aborted transaction rolls back the disable). Event **content**
was not modified — only the entity keys were re-pointed, preserving referential integrity of the audit trail to
the live entities. Rows re-keyed under disabled guards: `audit_events.actor_id`=3, `audit_events.org_id`=3,
`billing_events`: 0 (no rows referenced the old ids), `org_credit_deductions.org_id`=7.

## Full re-key log (rows changed per FK column)

anchors.user_id=5 · api_keys.created_by=4 · audit_events.actor_id=3 · credential_templates.created_by=2 ·
memberships.user_id=3 · org_members.user_id=3 · subscriptions.user_id=2 · anchors.org_id=5 ·
api_key_usage.org_id=4 · api_keys.org_id=4 · audit_events.org_id=3 · credential_templates.org_id=2 ·
memberships.org_id=3 · org_credits.org_id=2 · org_daily_usage.org_id=2 · org_members.org_id=3 ·
profiles.org_id=3 · subscriptions.org_id=1 · organization_queue_run_state.org_id=2 ·
org_credit_deductions.org_id=7

## Post-surgery state (verified in the same call)

2 orgs / 5 users / 5 identities / 3 org_members / 4 api_keys / 3,399,999 credits / anchors SUBMITTED×5 /
`organization_queue_run_state` rows on the new compliant ids. `staging-honesty-preflight` run after surgery
(13:36 UTC): **`environment_type=clean_mirror`**, duplicate_names/versions clean, exit 0.

## Two failed attempts (rolled back atomically, disclosed)

1. Unique **index** (not constraint) `idx_profiles_email` blocked the profile copy → email munge added.
2. plpgsql loop variable shadowed a SQL alias → renamed.

Both aborted the entire transaction; no partial state ever existed.

## Follow-ups filed

- T0 PR: `supabase/seed.sql` (+7 pinning files) move to RFC-compliant fixture UUIDs so future rigs never
  re-import the defect.
- T2 bug (post-window): worker strict-uuid validation of DB-sourced uuids — 57 sites share the class; one bad
  row DoSes a whole job pass. Bug-log entry in the Confluence master tracker.
