---
name: relation-anon-grants
description: The baseline's ALTER DEFAULT PRIVILEGES grants `anon` and `authenticated` the FULL privilege set on every table/view/matview/sequence at CREATE time, so a `GRANT ... TO service_role` next to a definition removes nothing — only an explicit `REVOKE ... FROM anon` closes a relation, and a revoke living off the replay path (archive or operator script) leaves every rebuilt environment weaker than prod.
type: feedback
---

The function-axis version of this rule is `memory/feedback_secdef_function_grants.md`. This is the **relation** axis, and it is a separate rule because the function ratchet structurally cannot see it.

The squashed baseline carries:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;          -- baseline:15105
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated; -- baseline:15106
```

So every table, view, materialised view and sequence created on the replay path hands both browser roles the full relation privilege set (`arwdDxtm`) **directly** at CREATE time. The idiomatic-looking line next to a definition

```sql
GRANT ALL ON TABLE public.some_view TO service_role;
```

reads as "service_role only" and is in fact **purely additive** — it removes nothing. This is the relation-axis twin of the `0364` no-op-revoke catch, and it is easy to miss precisely because the grant *looks* restrictive.

**Why:** this shipped as FD-17's third instance. `public.v_slow_queries` — a `pg_stat_statements` diagnostic view — is created by the baseline (`baseline:9502`), granted to `service_role` (`baseline:15050`), and never revoked on the replay path; its real revoke lives only in `docs/migrations-archive/0192_enable_pg_stat_statements.sql:33`. Prod measured closed (`postgres=arwdDxtm/postgres service_role=arwdDxtm/postgres`, anon and authenticated both false, 2026-08-22, `vzwyaatejekddvltxyye`); a container replay of the baseline shape measured anon **and** authenticated holding all eight relation privileges. The view is definer-rights (`reloptions = <none>`), so on a rebuilt environment an unauthenticated PostgREST caller reads `extensions.pg_stat_statements` through it.

It survived both earlier FD-17 fixes — `0414` (sixteen archive-only EXECUTE revokes) and `0418` (four operator-script-only EXECUTE revokes) — because both are *function* revokes, and every part of the ratchet guarding them parses `CREATE FUNCTION`, reasons about `has_function_privilege`, and burns keys out of `secdef-grants-baseline.json`. A view has no `SECURITY DEFINER` marker and never had a key in that burn-down list to burn. **A ratchet only catches the object class it was written for**: a detector finds sites a careful census misses, but only within the shape it parses.

**How to apply:**
- Any migration creating a `public` table, view, matview or sequence that should not be world-readable needs an explicit revoke naming the roles:
  ```sql
  REVOKE ALL ON TABLE <schema>.<rel> FROM PUBLIC, anon, authenticated;
  GRANT  ALL ON TABLE <schema>.<rel> TO service_role;
  ```
  Naming `anon`/`authenticated` is the load-bearing part; `FROM PUBLIC` alone does not touch a direct grant.
- When the defining file cannot be edited (the generated squashed baseline, or an already-merged migration per CLAUDE.md §1.2), the revoke goes in a later compensating migration and the relation gets pinned in `REPLAY_PARITY_REVOKES` in `scripts/ci/feedback-rules/relation-anon-grants.ts`.
- Use `anonAxisOnly: true` when prod deliberately keeps `authenticated` — the relation-side mirror of `DELIBERATELY_AUTHENTICATED`. Over-revoking reverses a decision prod already made, which is the same divergence pointed the other way.
- Adding a pin is a security decision: check the live prod ACL with `has_table_privilege('anon', '<schema>.<rel>', 'SELECT')` first and copy prod's posture rather than inventing one.

**Useful Postgres fact, measured rather than assumed:** `CREATE OR REPLACE` of an **already-existing** object PRESERVES its ACL. Only a genuinely fresh create (or `DROP` + `CREATE`) re-applies `ALTER DEFAULT PRIVILEGES`. A static reading that assumes every re-definition reopens the ACL produces false positives — it is what makes the 4-arg `supersede_anchor` / `resolve_anchor_queue_by_public_id` overloads (revoked by `0367`, re-defined by `0398` without a revoke) *look* reopened when they are in fact correctly closed. The CI rule is deliberately conservative here anyway, because "fresh" is not decidable from static SQL.

**Enforcement:** CI lint `scripts/ci/feedback-rules/relation-anon-grants.ts`, auto-loaded by the `scripts/ci/check-feedback-rules.ts` orchestrator's `Policy Lints` job. Because `Policy Lints` is not a Mergify merge condition, the merge-time gate is `relation-anon-grants.test.ts`, which runs in `Tests` (`vitest.config.ts` includes `scripts/**/*.test.ts`) — verified by deleting the compensating migration and confirming both go red.

**Override label:** none. The pin list itself is the escape hatch: removing an entry is an explicit, reviewable edit that states you are dropping the guarantee.
