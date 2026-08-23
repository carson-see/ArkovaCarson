# FD-PROD-1 — migration 0386 is merged but never applied to prod, so the fingerprint existence oracle it closed is still open in production

**Found:** 2026-08-21, while building the FD-FERPA-1 fix (PR #2314) against a scratch DB replayed to match live prod.
**Status:** **RESOLVED 2026-08-22.** 0386 is applied in production and the oracle is closed. Verification below. The original finding is preserved unedited underneath, because how it was *measured* is the reusable part.


## RESOLVED — verified against live prod, 2026-08-22

Migration 0386 **is applied**. Two independent checks against prod
(`vzwyaatejekddvltxyye`, via Supabase MCP `execute_sql`):

1. **Ledger.** `supabase_migrations.schema_migrations` contains
   `{"version":"0386","name":"0386_fingerprint_lookup_secured_only"}`, and prod's head is **0409**.
2. **Behaviour — the check that actually settles it.** The live body of
   `public.get_public_anchor_by_fingerprint` carries 0386's guard verbatim, including 0386's own
   comment:

   ```
   -- 0386: SECURED ONLY, restoring 0339.
   ...
   WHERE a.fingerprint = lower(p_fingerprint)
     AND a.status = 'SECURED'
     AND a.deleted_at IS NULL
   ORDER BY a.created_at DESC, a.id DESC
   ```

   `AND a.status = 'SECURED'` is present, so PENDING and SUBMITTED rows no longer answer.
   **The fingerprint existence oracle is closed in production.**

### The md5/length table below is obsolete — and it is why this stayed "OPEN" too long

The original table recorded prod at **1,381** chars and repo head at **1,863**. The live body
today measures **1,579** — *neither* number. That is not a third version of the function:
`pg_get_functiondef()` re-renders and normalises whitespace, so its length and md5 are **not
stable identifiers of a function body** and cannot be compared across databases or across
captures.

**Test the predicate, not the hash.** Grep the live definition for the guard the migration was
written to add. A hash comparison here produced a confident wrong answer in both directions:
first "prod is stale", then an inability to tell whether it had been fixed.

### Residual, unchanged by this

`bulk_create_anchors(jsonb)` and `resolve_anchor_queue(text,uuid,text)` remain anon-EXECUTABLE
in prod. Each is safe only because it `RAISE`s inside the body — the grant itself was never
revoked. That is tracked separately and is **not** closed by 0386.

---

## Original finding, preserved as filed 2026-08-21

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
