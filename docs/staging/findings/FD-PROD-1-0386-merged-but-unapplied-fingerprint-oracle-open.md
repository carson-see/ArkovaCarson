# FD-PROD-1 — migration 0386 is merged but never applied to prod, so the fingerprint existence oracle it closed is still open in production

**Found:** 2026-08-21, while building the FD-FERPA-1 fix (PR #2314) against a scratch DB replayed to match live prod.
**Status:** OPEN. Prod-apply item for whoever holds RTE.

## The finding

`public.get_public_anchor_by_fingerprint` in production is **still the pre-0386 body**:

| | md5 | length |
|---|---|---|
| prod (live) | `468db545…` | 1,381 chars |
| repo head (post-0386) | — | 1,863 chars |

Migration 0386 is merged to `main`. It has not been applied to production. The **fingerprint
existence oracle** that 0386 was written to close is therefore still open on the live
verification API.

This was found only because the FERPA work replayed the migration set into a scratch database
and md5-compared each function body against prod, rather than assuming repo head equals prod.

## Why it survived

Per `memory/project_migration_drift_gate_mechanics.md` and CLAUDE.md §0 rule 10, prod-apply is
expected to happen *before* merge, and the drift gate checks the numeric ledger. A migration
that merged without being applied leaves the repo and prod disagreeing about a function body
while the ledger looks fine.

## Related, found in the same sweep

`public.bulk_create_anchors(jsonb)` and `public.resolve_anchor_queue(text, uuid, text)` are
**anon-EXECUTABLE in production**. They are safe only because each `RAISE`s on an `auth.uid()`
/ `profiles` lookup before doing anything — i.e. the protection is inside the function body,
not in the grant. This is the same class as the 0377/0378 anon-revoke work
(`memory/project_supabase_revoke_from_public_is_not_enough.md`: anon/authenticated are granted
directly at CREATE, so `REVOKE FROM PUBLIC` does not cover them).

## The rule this is a case of

**Never assume repo head equals production for a database function.** Compare the live body.
A merged migration is not an applied migration, and CLAUDE.md §1.13 says the config-drift gate
does not yet read running prod — so nothing automated would have caught this.
