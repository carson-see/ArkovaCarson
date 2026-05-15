# services/worker/scripts/ops/agents.md

Operator-run scripts for production or sandbox verification. Keep commands safe by default: read-only checks should be the default mode, and any command that can enqueue work in production must require an explicit opt-in flag and document the side effect.

## Files

- `docusign-connect-smoke.ts` — SCRUM-1655 DocuSign Connect smoke helper. Default `orphan` mode verifies invalid-HMAC rejection and signed unknown-account acknowledgement without touching integration state. `accepted-duplicate` mode can enqueue a real rule event/job and must only be used with a connected DocuSign sandbox account plus `--allow-processing`. Protected Cloud Run staging targets can use `WORKER_BEARER_TOKEN`; keep bearer tokens and HMAC secrets in env, never argv.
