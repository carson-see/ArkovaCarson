# Admin profile RPCs — removal of runtime DDL on the hot `profiles` table (migration 0428)

> **Status of this file.** Internal engineering note, staged for Confluence. The
> Jira story and the Confluence page for this work are **NOT yet created** — the
> Atlassian connector was unauthenticated in the session that produced the change
> and the session was non-interactive, so it could not run the OAuth flow.
> Whoever picks this up should file the story + page from the content below and
> paste the Confluence URL into the ticket (CLAUDE.md §3 gates 2, 3, 4).
>
> Doc Update Matrix (CLAUDE.md §4): this change touches RLS-adjacent protective
> triggers and an audit-relevant admin path, so the **Security & RLS** page is
> the one to update, plus **Identity & Access** for the admin-console endpoints.

## Goal

Remove the need for `ALTER TABLE profiles DISABLE/ENABLE TRIGGER` from the three
SECURITY DEFINER admin RPCs reachable from the admin console, rather than merely
bounding it with a `lock_timeout`.

## The defect

Three RPCs wrapped their `UPDATE` in runtime DDL against `profiles`, a table on
the auth hot path, with no bounded `lock_timeout`:

| RPC | Endpoint | Triggers disabled |
|---|---|---|
| `admin_change_user_role` | `POST /api/admin/users/:id/change-role` | `enforce_role_immutability`, `protect_privileged_fields` |
| `admin_set_platform_admin` | `POST /api/admin/users/:id/promote-admin` | `trg_protect_platform_admin` |
| `admin_set_user_org` | `POST /api/admin/users/:id/set-org` | `protect_privileged_fields` |

All three are called from `services/worker/src/api/admin-actions.ts`.

## Severity — measured, and narrower than first assumed

The originating report described this as an `ACCESS EXCLUSIVE` lock and the same
mechanism as the 2026-08-11 P0. **That is not accurate, and the difference
matters.** Measured on PostgreSQL 17 via `pg_locks`:

* `ALTER TABLE ... DISABLE/ENABLE TRIGGER` takes **`ShareRowExclusiveLock`**.
* `ALTER TABLE ... ADD COLUMN` (the 2026-08-11 shape) takes **`AccessExclusiveLock`**.

Consequences:

* **Readers are never blocked.** `/api/v1/verify` and PostgREST schema-cache
  introspection were never exposed by this defect. It is *not* the P0 mechanism
  described in CLAUDE.md §1.2.
* **Writers are blocked, and the FIFO barrier is real on the write axis.**
  `ShareRowExclusive` conflicts with `RowExclusive`, so once the RPC's lock
  request queues behind any in-flight write to `profiles`, every later write
  queues behind it — including writes to *unrelated rows* whose locks are
  mutually compatible and would otherwise be granted instantly.

Measured with one slow in-flight write held on `profiles`, timing an innocent
write to a **different** row:

| | innocent unrelated write waits |
|---|---|
| today (DDL) | **4.95 s** |
| after 0428 | **0.04 s** |

With no `lock_timeout` that wait is unbounded — the RPC camps the queue for as
long as the blocking writer runs.

## Why the DDL could be deleted outright

Two of the three trigger-disables were never load-bearing. Measured with the
triggers left **enabled**, invoking the RPCs exactly as PostgREST does
(`SET LOCAL ROLE service_role` plus service_role JWT claims):

| Trigger | Result with trigger enabled | Why |
|---|---|---|
| `protect_privileged_fields` | write **succeeded** | `protect_privileged_profile_fields()` opens with `IF get_caller_role() = 'service_role' THEN RETURN NEW` |
| `trg_protect_platform_admin` | write **stuck** | `protect_platform_admin_flag()` gates on `current_setting('role')`, which is `service_role` |
| `enforce_role_immutability` | write **blocked** | `check_role_immutability()` had no bypass of any kind |

Underlying fact, re-measured rather than inherited from migration 0395: inside a
SECURITY DEFINER function owned by `postgres`, `current_user` becomes
`postgres`, but **both** `current_setting('role')` and `get_caller_role()` still
report the caller's role. SECURITY DEFINER swaps the SQL execution privilege, not
the JWT claims or the `role` GUC.

So `admin_set_platform_admin` and `admin_set_user_org` needed no trigger change
at all. Only `check_role_immutability()` needed a bypass.

## The change (migration 0428)

1. **`check_role_immutability()`** gains the service_role exemption that
   `protect_privileged_profile_fields()` already had — **scoped to the RAISE
   only**. The `role_set_at` stamping stays on the same path for every caller.
   A blanket `IF get_caller_role() = 'service_role' THEN RETURN NEW` at the top
   would have silently dropped that stamping for the worker's own
   profile-creation paths; this shape cannot.

   *Not a privilege widening:* `user_role` has exactly three values
   (`INDIVIDUAL`, `ORG_ADMIN`, `ORG_MEMBER` — confirmed against prod), the same
   set `admin_change_user_role` already validates, and any holder of the
   service_role key could already reach all three through that RPC. A NULL
   `get_caller_role()` fails **closed** (`IS DISTINCT FROM`).

2. **`protect_platform_admin_flag()`** additionally accepts
   `get_caller_role() = 'service_role'`, removing the RPC's dependence on the
   `role` GUC specifically. Silent-revert semantics for every other caller are
   deliberately unchanged — it fires on every `profiles` UPDATE, and promoting
   the revert to a RAISE would fail unrelated write paths.

3. **`admin_set_platform_admin`** re-reads the row and raises if the flag did not
   take. That trigger reverts *silently*, so without this the only failure mode
   of removing its DDL would be a false success: HTTP 200, `{"success":true}`,
   nothing written.

4. Authorization guards, validation, ordering, and `User not found` behaviour are
   byte-identical. (`FOUND` was verified to survive the removed `ALTER TABLE`
   statements, so those checks behaved correctly before and behave identically
   now — no latent bug there.)

5. Grant hygiene for the `secdef-function-grants` ratchet. For the three admin
   RPCs the REVOKE/GRANT restates live prod (anon=f, authenticated=f,
   service_role=t) and is a no-op. `protect_platform_admin_flag` is a real
   tightening: the baseline grants it to anon/authenticated and prod still does
   (the 0388/0414/0418 class). It is trigger-returning so it was never usefully
   callable over PostgREST, and Postgres does not check EXECUTE when firing a
   trigger — verified that after the REVOKE an `authenticated` UPDATE still fires
   the trigger, still gets its escalation reverted, and ordinary profile updates
   are unaffected. Burns one baseline entry (109 → 108).

The migration alters no table — function bodies only — so it takes no lock on
`profiles` and needs no `SET LOCAL lock_timeout` of its own.

## Why a new test rather than relying on the existing gate

`scripts/ci/check-hot-table-ddl-lock-timeout.ts` **already detects all twelve**
of these statements. They are silent only because the entire squashed baseline
migration is grandfathered per-FILE in
`scripts/ci/snapshots/hot-table-ddl-lock-timeout-baseline.json`. That gate reads
migration *text*, not live definitions, so it can never notice that 0428 fixed
the runtime behaviour, and it would not stop a future author copying the old body
out of the baseline into a new migration.

`src/tests/sec-0428-admin-profile-rpcs-no-hot-table-ddl.test.ts` (24 tests) closes
that gap with a LATEST-DEFINITION invariant: whichever migration defines these
routines last must define them without hot-table DDL. Verified that reintroducing
the DDL turns **both** that test and the hot-table gate red.

## Verification performed

Isolated throwaway PostgreSQL 17 cluster on a private socket — never prod, never
a soak rig, never the shared local Supabase stack.

* Prod function bodies read live via `pg_get_functiondef` on
  `vzwyaatejekddvltxyye` and confirmed byte-identical to the committed baseline
  before any change was designed.
* Forward → rollback → forward, plus a double forward apply (idempotent).
* Rollback block extracted from the file header and executed; confirmed it
  restores pre-0428 semantics (role change blocked again without the DDL).
* 14-case behavioural matrix, all green: service_role writes land for all three
  RPCs; authenticated / anon / no-claims direct writes still blocked;
  `is_platform_admin` escalation still reverted; `org_id` write still blocked;
  `role_set_at` still stamped; all three RPCs still reject non-service_role;
  `User not found` and validation errors preserved; read-back assertion fires
  against a deliberately hostile trigger; no trigger left disabled.
* Lock behaviour measured directly from `pg_locks`, with the innocent write
  targeting a different row so row-level contention could not confound the
  table-lock result.

## Not done in this change

* **Jira story and Confluence page** — connector unauthenticated, see the banner
  at the top of this file.
* **Bug Tracker row** (CLAUDE.md §0 rule 5) — same reason.
* **Applying to prod** — this is T3 and requires its own 48 h isolated-rig soak
  first. The migration is file-only and has not been applied to prod or any rig.
