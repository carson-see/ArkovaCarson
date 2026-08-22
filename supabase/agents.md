# supabase/agents.md

Supabase project configuration, migrations, seed data, and email templates.

## Structure
- **`config.toml`** — Supabase CLI config: project ID `arkova`, Postgres 15, API port 54321, studio enabled.
- **`migrations/`** — SQL migration files (numbered `0000`-`03xx`). Never modify an existing migration; write a compensating one.
- **`seed.sql`** — seed data for local development (demo users, orgs, anchors). Switchboard block re-seeds flags post-TRUNCATE-cascade; launch-gated flags (e.g. `ENABLE_ORG_CREDIT_ENFORCEMENT`, G4/PR #1614 — an audit-mirror row only; the worker gates on the env var, not this row) stay `false` so local resets never enforce early.
- **`templates/`** — email templates: `confirmation.html`, `magic_link.html`, `recovery.html`.

## Conventions
- **Fixture UUIDs must be RFC 9562 compliant** — version nibble `4`, variant nibble `8` (`aaaaaaaa-0000-4000-8000-000000000001`), never zeroed (`…-0000-0000-0000-…`). Postgres's `uuid` type accepts a zeroed one; Zod 4's `z.string().uuid()` — which the worker uses at ~57 validator sites — does not, so a zeroed fixture id 500s any worker path that validates a DB-sourced id. That is DEG-5 (`docs/staging/fullsoak-2026-08/deg5-org-queue-triage.md`), which took out `/jobs/org-queue-scheduler` on the fullsoak rig. Ratchet: `tests/infra/seed-fixture-uuids.test.ts`. The nil UUID stays legal.
- RLS + `FORCE ROW LEVEL SECURITY` on every table. No exceptions.
- SECURITY DEFINER functions must `SET search_path = public`.
- Schema changes require: migration + rollback comment + `gen:types` + seed update + Confluence page update.
- Test with `npx supabase db reset` after any migration change.
- Apply to staging first (`npx supabase db push --linked`) before production.
