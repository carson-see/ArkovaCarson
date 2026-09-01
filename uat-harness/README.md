# Sub-org credit control — UAT harness (SCRUM-3865)

Renders `ManageSubOrgs` in a real browser against **stubbed** `@/lib/supabase`
and `@/lib/workerClient` modules, with an in-page `fetch` stub that implements
the two credit endpoints (including the `insufficient_parent_balance` rejection)
and keeps running balances.

Why not the normal dev server: the panel needs an authenticated admin of a
parent org with sub-orgs, which means the full local Supabase stack. That stack
is **shared across every worktree** (`project_id` is the same for all of them),
and another session was active while this change was built — a concurrent
`supabase stop` would have wiped the run mid-UAT. The harness needs no database
at all, and it exercises the component that actually changed.

Run it:

```bash
npx vite --config uat-harness/vite.config.ts --port 5599 --strictPort
```

Then open <http://localhost:5599>.

Screenshots captured from this harness for the PR:
`docs/staging/hakichain-suborgs-2026-09/uat-1280.png` and `uat-375.png`.

Not part of the app build — nothing in `src/` imports it.
