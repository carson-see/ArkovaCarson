# The hollow 200: a swallowed `statement_timeout` reported as success

**A swallowed error must never be reported as "not found" — or as success.**

**Rule.** In a read path, `if (error || !data)` is a bug. It collapses three
different situations into one answer:

- the row genuinely does not exist — a real 404;
- the query was killed (`statement_timeout`), refused (RLS), or could not be
  planned (schema-cache miss) — a real 500;
- the client is unauthorised — a real 401/403.

Branch on `error` first and throw. Let `!data` alone mean not-found.

## Why

The collapsed form is silent by construction: the endpoint returns a
well-formed, plausible response, so nothing alerts, nothing retries, and the
metric that would show the failure is the one being faked. A 60s query kill was
reported as a clean result for **1,108 runs** before anyone noticed, because
the handler answered `200` with an empty body every time.

It is also undetectable by small-fixture testing. The failure is
scale-dependent — the timeout only fires against production-sized data, so a
soak on a synthetic rig passes while prod is silently broken. Nothing about the
code path looks wrong in review; the defect is entirely in the `||`.

The same shape reaches auditors. A verification endpoint that answers "not
found" when it actually failed to look is asserting something it did not
measure (CLAUDE.md §1.5, and the R-7 claims gate in §1.13).

## How to apply

```ts
// WRONG — a timeout, an RLS denial and a missing row are one answer
const { data, error } = await db.from('t').select('...').maybeSingle();
if (error || !data) return null;

// RIGHT — the failure is loud, absence is quiet
const { data, error } = await db.from('t').select('...').maybeSingle();
if (error) throw new Error(`lookup failed: ${error.message}`);
return data ?? null;
```

Then assert both halves separately in tests: one case proving a query error
surfaces as 5xx, one proving a genuinely absent row is 404. A single test that
only checks the 404 will pass against the broken form.

Applies to every read that fronts a public or audited surface. Related:
`memory/feedback_read_the_emitting_code.md`, `memory/feedback_bounded_body_reads.md`.
