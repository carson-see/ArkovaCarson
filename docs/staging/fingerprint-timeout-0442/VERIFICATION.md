# 0442 — verify-by-fingerprint times out in production

Pre-soak verification for migration `0442_fingerprint_lookup_bpchar_cast.sql`.
Everything below was run locally on 2026-09-08 against a throwaway PostgreSQL
17.9 cluster. Nothing here touched production, the standing rig, or any rig in
an open soak window.

## The defect

`anchors.fingerprint` is `character(64)` (bpchar). The RPC parameter is `text`.
Migration `0386` (the body live in production, applied 2026-08-02/03) compares
them bare:

```sql
WHERE a.fingerprint = lower(p_fingerprint)   -- bpchar = text
```

There is no `bpchar = text` operator, so Postgres resolves the comparison by
casting the **column** — the one side that must stay untouched.
`idx_anchors_fingerprint_lookup` is a btree on the bare bpchar column
(`ON anchors (fingerprint) WHERE deleted_at IS NULL`), and it cannot drive an
expression it was not built on. The fingerprint predicate is demoted from an
Index Cond to a Filter, and with nothing selective left the planner falls back
to `idx_anchors_status_secured_submitted` over the ~3.5M-row SECURED partition.

Production impact, found 2026-09-08 during the SCRUM-3797 edge catch-up deploy
(`docs/staging/edge-retro-2026-09-07/DEPLOY.md`, finding 1): the MCP tools
`verify` (by fingerprint) and `get_fingerprint` on `https://edge.arkova.ai` both
return `isError: "Document verification timed out"`. The RPC does not return
slowly — it does not return at all.

This is not a regression. `get_public_anchor_by_fingerprint` does not appear in
the June edge bundle at all; the catch-up added the path, and the path is slow.

## Fix

Cast the **parameter**, never the column:

```sql
WHERE a.fingerprint = lower(p_fingerprint)::bpchar
```

Identical mechanism and identical remedy to migration `0370` (SCRUM-3031), which
hit the same bpchar/text mismatch on this same column in `batch_insert_anchors`.
0370's rule, restated: cast explicitly only on the non-indexed side.

## Measured — prod

Captured against prod `vzwyaatejekddvltxyye` before this migration was written.

| Form | Plan | Cost / time |
|---|---|---|
| `= lower(p_fingerprint)` | `Filter: ((fingerprint)::text = …)`, falls back to `idx_anchors_status_secured_submitted` | cost **2,302,395** — exceeds `statement_timeout` |
| `= lower(p_fingerprint)::bpchar` | `Index Scan using idx_anchors_fingerprint_lookup` | **3.020 ms** |

## Measured — local repro

PostgreSQL 17.9, `anchors` rebuilt to prod's column types and index shapes
(`idx_anchors_fingerprint_lookup`, `idx_anchors_status_secured_submitted`,
`idx_anchors_active_created`), 300,020 SECURED rows. Full transcript:
[`explain-300k-repro.txt`](./explain-300k-repro.txt).

| Form | Plan | Execution time |
|---|---|---|
| before | `Index Scan using idx_anchors_active_created`, `Filter: ((fingerprint)::text = …)`, **Rows Removed by Filter: 300,019** | **65.788 ms** |
| after | `Index Scan using idx_anchors_fingerprint_lookup`, `Index Cond: (fingerprint = …::bpchar)` | **0.058 ms** |

The before-cost is O(N) in the table, so it widens rather than narrows at prod's
~3.5M rows. That is why prod times out where a 300k repro merely crawls.

## Regression test — red before, green after

`tests/rls/fingerprint-lookup-index-plan.test.ts`. Run against a fixture holding
the pre-0442 (0386) body, then after applying 0442, then after rolling back:

| Fixture state | Result |
|---|---|
| 0386 body installed (pre-fix) | **3 failed / 4 passed** — `no Index Cond on idx_anchors_fingerprint_lookup`, and the plan carried `Filter: ((fingerprint)::text = …)` on `idx_anchors_status_secured_submitted`, reproducing prod's plan on a 10-row table |
| 0442 applied | **7 passed** |
| rollback: 0386 re-applied verbatim | **3 failed / 4 passed** (same three) |
| 0442 re-applied | **7 passed** |

That last pair is also the rollback rehearsal: the `-- ROLLBACK:` comment in
0442 is "re-apply 0386 verbatim", and it was executed as written, reversed the
behaviour, and the forward migration re-applied cleanly afterwards.

### Why the test pins the plan and not the clock

A timing assertion cannot catch this defect and must not be written for it. The
12h retro-soak that preceded the outage ran against a 10-row rig fixture, where
a sequential scan is instant. The defect is invisible below roughly a million
rows, and no CI fixture will ever be that large; seeding to prod scale to make a
stopwatch meaningful would trade a fast exact test for a slow flaky one.

So the suite pins the plan, which is true or false at any table size:

1. `SET enable_seqscan = off` removes the only variable that actually depends on
   row count. What remains is a question about the predicate, not about cost:
   can this comparison drive that btree at all? A type-mismatched predicate
   cannot, on ten rows or ten million.
2. The assertion is on **Index Cond**, not on the index name appearing somewhere
   in the plan. With seqscan disabled the planner will happily full-scan
   `idx_anchors_fingerprint_lookup` and apply `(fingerprint)::text` as a Filter —
   a plan that contains the index name while doing exactly the pathological
   thing. Asserting the name alone passes on the broken function.
3. The query is extracted from the live `pg_proc` body rather than re-typed into
   the test, so it degrades if someone reverts the function.
4. A negative control runs the pre-0442 form of that same extracted query and
   asserts it does not reach the index, so a green result cannot be an artifact
   of a small fixture.
5. Positive controls call the function for real — a SECURED row still resolves,
   upper-case input still resolves, and an in-flight fingerprint stays
   byte-identical to an unknown one, so 0386's SECURED-only invariant is proven
   to survive the cast.

## Not asserted

* **Not applied to production.** Prod-apply is RTE/CTO-owned. The prod numbers
  above are reads captured before the change, not the result of applying it.
* **No staging soak has run yet.** This is T3 (`supabase/migrations/`) and needs
  a 48h window on a clean-mirror or isolated rig. No rig was provisioned by this
  session, and no rig in an open window was touched.
* **The local repro is not prod.** It reproduces prod's column types, the three
  relevant index shapes, and the plan shape at 1/12th of prod's row count. It
  does not reproduce prod's data distribution, bloat, or cache state.
* **Truncation is out of scope, deliberately.** An explicit cast to
  `character(64)` silently truncates an overlong input rather than raising —
  that was the hazard adversarial review caught in 0370's first cut. It does not
  apply here because this cast is on a read predicate, not on a value entering
  the column: an overlong input truncates and then matches a real fingerprint
  the caller already supplied in full, or matches nothing. No pre-validation was
  added, so this migration changes exactly one thing.
