# services/edge/scripts

Operator helpers for the Cloudflare edge worker.

## Files

- `sign-allowlist-entry.ts` — SCRUM-1283 (R3-10). Signs a per-API-key allowlist entry with HMAC so the edge worker's `mcp-origin-allowlist.ts` can verify it. Reads JSON from stdin, outputs signed envelope to stdout. Pipe to `wrangler kv key put` for deployment.

## Constraints

- Requires `MCP_ALLOWLIST_HMAC_SECRET` env var.
- Does not call `wrangler` itself — operator pipes output to their preferred KV-write workflow.
