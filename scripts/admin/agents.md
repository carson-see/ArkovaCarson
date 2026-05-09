# scripts/admin/agents.md

Operator-only TypeScript scripts that need a service-role connection. Run via `npx tsx scripts/admin/<name>.ts`. Never imported from runtime code.

## Files
- **`provision-sandbox-org.ts` (SCRUM-1740, PR #738)** — provisions a partner-sandbox org with a scoped API key.
  - Zod-validated CLI args (`--partner=<slug>`, `--anchors=<int>`, `--credits=<int>`, optional `--owner-email=<email>`).
  - **Fail-closed `loadConfig()`**: requires `STAGING_SUPABASE_URL` + `STAGING_SUPABASE_SERVICE_ROLE_KEY` by default; allows non-staging only if `ALLOW_PROD_PROVISIONING=true` is explicitly set. Prevents accidental prod provisioning from a shell with prod creds.
  - **Idempotent**: re-running with the same `--partner` slug TOPS UP the existing org's `anchor_quota` and `balance` (sums prev + new) rather than overwriting. CodeRabbit P0 fix.
  - **Idempotent api_keys**: looks up existing active key by `(org_id, name)` and reuses if found rather than minting a new one (which would orphan the previous raw key).
  - HMAC-SHA256 hashes the raw API key per CLAUDE.md §1.4; raw key shown ONCE via stdout, never persisted in plaintext.
  - 17 unit tests (hmacApiKey, parseCliArgs, loadConfig — fail-closed staging guard cases).

## Conventions
- Service-role only. Scripts here are not in the worker's deploy bundle.
- Always Zod-validate CLI input. Refuse to run on partial / malformed args.
- Document the idempotency contract at the top of every file (re-runs must be safe).
- Print structured JSON to stdout for the partner provisioner; printf-style status to stderr.

## Open work
- SCRUM-1740 (PR #738) — awaiting Carson merge + Mon deploy.
- Onboarding email template for HakiChain pilot still TODO (separate from this folder).
