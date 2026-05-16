# infra/cloudflare/agents.md

Cloudflare infrastructure provisioning scripts. Run manually via `npx tsx`.

## Files
- **`dlp-policy.ts`** — provisions Cloudflare Gateway DLP profile to block SSN/Tax ID patterns in inbound API traffic. Enforces Constitution 1.4 (no PII in transit).
- **`load-balancer.ts`** — configures Cloudflare Load Balancer with origin pool, active health checks on `/api/health`, and failover policy.

## Conventions
- Requires `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and (for LB) `CLOUDFLARE_ZONE_ID` env vars.
- These are one-shot provisioning scripts, not CI-managed. Idempotent where possible.
