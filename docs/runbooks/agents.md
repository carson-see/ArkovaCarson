# docs/runbooks/agents.md

Operational runbooks for manual and scheduled production procedures.

## Files
- `provider-registry-refresh.md` - SCRUM-1933/SCRUM-1949 quarterly CPE/CLE provider registry refresh procedure, audit evidence, and overdue-alert rollout.

## Conventions
- Keep commands copy-pasteable but never include secret values.
- Mark staging evidence as staging-only when the environment is not a production mirror.
- Database changes documented here still require reviewed migrations; do not apply linked Supabase pushes from an agent session.
