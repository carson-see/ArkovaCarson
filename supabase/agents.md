# supabase/agents.md

Supabase project configuration, migrations, seed data, and email templates.

## Structure
- **`config.toml`** — Supabase CLI config: project ID `arkova`, Postgres 15, API port 54321, studio enabled.
- **`migrations/`** — SQL migration files (numbered `0000`-`03xx`). Never modify an existing migration; write a compensating one.
- **`seed.sql`** — seed data for local development (demo users, orgs, anchors).
- **`templates/`** — email templates: `confirmation.html`, `magic_link.html`, `recovery.html`.

## Conventions
- RLS + `FORCE ROW LEVEL SECURITY` on every table. No exceptions.
- SECURITY DEFINER functions must `SET search_path = public`.
- Schema changes require: migration + rollback comment + `gen:types` + seed update + Confluence page update.
- Test with `npx supabase db reset` after any migration change.
- Apply to staging first (`npx supabase db push --linked`) before production.
