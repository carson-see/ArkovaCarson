# Pre-mortem — Platform-admin org + account provisioning

**Date:** 2026-09-01 · **Author:** CTO session · **Status:** pre-implementation
**Scope:** `POST /api/admin/organizations` (create org) + `POST /api/admin/users`
(create account), plus the two admin-console dialogs that drive them.
**Not in scope:** setting quota/credits — `handleSetOrgQuota` and
`handleAdjustOrgCredit` already ship and work.

Premise: it is 2026-11-01. The feature shipped. Something went wrong. Below is
what it was, ranked by expected cost, each grounded in a fact verified against
prod (`vzwyaatejekddvltxyye`) rather than assumed.

---

## F1 — Privilege escalation via the create-user endpoint (CRITICAL)

**Mechanism.** `POST /api/admin/users` accepts `role` and (if we are careless)
`is_platform_admin`. It is the highest-value endpoint in the product: one
missing auth check mints an attacker an `ORG_ADMIN`, or a second platform
admin. Every other admin action mutates an *existing* subject; this one
conjures the subject.

**Evidence this is a live risk.** `adminRouter` gates per-handler, not once at
the router: each of the five existing handlers calls `isPlatformAdmin(userId)`
itself. A new handler that forgets the call is wired and reachable with no
compile-time or route-level error.

**Mitigations (binding on the implementation):**
- `isPlatformAdmin` check is the first statement in both handlers, before any
  body parsing.
- `is_platform_admin` is **not an accepted field**. Promotion stays exclusively
  on the existing `promote-admin` endpoint, which has a self-demotion guard.
  Creating a platform admin is a two-step, two-endpoint act, on purpose.
- A test asserts 403 for a non-platform-admin caller on both endpoints, and a
  test asserts an `is_platform_admin: true` field in the body is ignored.

## F2 — Auto-association silently misfiles the account, and the role is then frozen (HIGH)

**Mechanism.** Two prod facts combine badly:
1. `zz_auth_user_auto_associate_org` fires when `email_confirmed_at` is set and
   calls `auto_associate_profile_to_org_by_email_domain`, which joins the user
   to **any org whose `domain` matches their email domain**, setting
   `role = COALESCE(role,'ORG_MEMBER')`.
2. `enforce_role_immutability` is `BEFORE UPDATE` and raises whenever a
   non-null role changes.

So: admin creates `ops@acme.com` as `ORG_ADMIN` of a new org, an unrelated
"Acme" org already claims `domain='acme.com'`, the trigger sets role
`ORG_MEMBER` first, and our subsequent update to `ORG_ADMIN` **throws**. The
admin sees a 500 on an account that already exists, and the role can now only
be fixed by the trigger-disabling RPC (see F5).

**Why we would not have caught it in staging:** no staging org has a populated
`domain`, and PlanBook's `gmail.com` matched nothing. The bug is invisible
until the first customer whose domain collides.

**Mitigations:**
- Create the auth user with `email_confirm: false`, so auto-association is
  short-circuited (`email_confirmed_at IS NULL` returns early).
- Write `role` and `org_id` in the **profile INSERT**, not a follow-up UPDATE.
  Verified: both protective triggers are `BEFORE UPDATE` only, so an INSERT
  carrying the final role is unguarded and needs no DDL.
- Test covers the domain-collision case explicitly.

## F3 — Duplicate organizations from a double-click (HIGH, near-certain)

**Mechanism.** `organizations` has unique constraints on `public_id` and
`ein_tax_id` only — **`display_name` is not unique** (verified). Two clicks on
"Create organization" produce two orgs with the same name, each with its own
auto-seeded `org_credits` row. Credits then get granted to the wrong one and
the partner reports a zero balance.

**Mitigations:**
- Handler rejects with 409 when an org with the same `display_name` already
  exists, and returns the existing org's id in the error body.
- UI disables the submit button while in flight.
- Not solved with a DB unique constraint: that is a migration on a hot table
  and would force T3 + a backfill decision about existing duplicates. Deferred
  deliberately and noted below.

## F4 — Orphaned auth user blocks re-provisioning that address forever (MEDIUM)

**Mechanism.** `createUser` succeeds, the profile/membership writes fail, the
compensating `deleteUser` also fails. The address now has an auth user with no
profile. Every retry returns "account exists" and the admin cannot provision
that person again without manual DB surgery. `invitations.ts` already carries a
comment describing exactly this failure, so it is a known-real mode.

**Mitigations:**
- Mirror the `invitations.ts` rollback: wrap all post-create writes, and on any
  failure `deleteUser` best-effort with a loud, PII-free log naming the user id
  for manual cleanup.
- Tolerate `23505` on the profile insert — `on_auth_user_created` may have
  created the row first; that is success, not a conflict to fight.

## F5 — We copy the existing trigger-disabling pattern and cause a repeat of the 2026-08-11 P0 (MEDIUM, catastrophic if hit)

**Mechanism.** The shipped RPCs `admin_change_user_role` and
`admin_set_platform_admin` both run
`ALTER TABLE profiles DISABLE TRIGGER ...` inside the function. That is
unguarded DDL on a hot table with **no `lock_timeout`** — it takes an ACCESS
EXCLUSIVE lock on `profiles` and queues every reader behind it. This is the
precise mechanism CLAUDE.md §1.2 attributes to the 11m39s `service_unavailable`
outage. The obvious way to write our handler is to copy the neighbour.

**Mitigations:**
- Our path takes **zero DDL**. Role is set at INSERT (F2), and `org_id` is
  writable because `protect_privileged_profile_fields` grants `service_role` an
  explicit bypass. Verified empirically while provisioning PlanBook.
- Pre-existing hazard in those two RPCs is **out of scope here** and filed
  separately rather than smuggled into this PR.

## F6 — The account is created and nobody can ever log in (MEDIUM, high embarrassment)

**Mechanism.** With `email_confirm:false` (per F2) and no email sent, the
account exists, cannot sign in, and nothing tells anyone. The admin believes
provisioning succeeded. This is the most likely *silent* failure.

**Mitigation — the delivery decision, made explicitly:**
- `send_invite_email` defaults to **true**. The point of creating an account is
  that someone can use it.
- When the admin opts out, the response returns the activation link and the UI
  displays it with a "no email was sent — you must deliver this" warning. An
  opted-out account is created with `email_confirm:true` so it is immediately
  usable via password-reset or Google sign-in, which is exactly how PlanBook
  was provisioned by hand.
- The response always states, in a field, which of the two paths happened.

## F7 — PII leakage into logs and Sentry (MEDIUM, compliance)

**Mechanism.** The natural `logger.error({ error, email }, ...)` leaks a real
person's address into logs and Sentry, against §1.4.

**Mitigation:** log the user id and org id only; never the email or full name.
An existing lint covers document bytes, not emails, so this is review-enforced
and called out in the PR body.

## F8 — Quota semantics inverted on create (LOW, silent)

**Mechanism.** `trg_seed_free_tier_org_credits` auto-inserts
`org_credits(is_test=true, anchor_quota=10)` on every org INSERT. A handler
that treats "no quota specified" as "leave it alone" silently ships every new
org a 10-anchor test cap; a handler that wants uncapped must explicitly write
`anchor_quota=null, is_test=false`.

**Mitigation:** handler always writes the resolved credit state after insert
and returns it in the response, so the caller sees what it got. Test asserts
both the defaulted and the uncapped case.

---

## Design decisions this pre-mortem forces

1. Role and org_id are written in the profile **INSERT**, never a follow-up UPDATE. (F2, F5)
2. Auth user created with `email_confirm:false` on the emailed path. (F2)
3. `is_platform_admin` is not an accepted input on create. (F1)
4. Duplicate `display_name` is a 409, not a second org. (F3)
5. Full compensating rollback around every post-create write. (F4)
6. Zero DDL. No trigger disabling. (F5)
7. `send_invite_email` defaults true; opting out returns the link and says so. (F6)
8. Credit/quota state is always explicitly written and echoed back. (F8)

## Deliberately NOT done in this PR

- No unique constraint on `organizations.display_name` (migration on a hot
  table; needs its own dedup decision).
- No fix to `admin_change_user_role` / `admin_set_platform_admin` DDL hazard
  (F5) — filed separately.
- No change to `auto_associate_profile_to_org_by_email_domain` semantics.

## Tier and verification

Declared **T3**: the change creates accounts and grants roles, which is the
"security" surface in the §1.12 matrix, even though it touches no migration and
no `chain/`. Verification must include the F1 403 cases, the F2 domain
collision, the F3 double-submit, and the F4 rollback path — a generic worker
smoke test does not exercise any of them.
