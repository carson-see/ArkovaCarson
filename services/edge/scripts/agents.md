# services/edge/scripts

Operator helpers for the Cloudflare edge worker.

## Files

- `sign-allowlist-entry.ts` — SCRUM-1283 (R3-10). Signs a per-API-key allowlist entry with HMAC so the edge worker's `mcp-origin-allowlist.ts` can verify it. Reads JSON from stdin, outputs signed envelope to stdout. Pipe to `wrangler kv key put` for deployment.
- `generate-build-info.mjs` — SCRUM-3907. Overwrites `../src/build-info.ts` with `{ git_sha, built_at }` for the commit about to be deployed. Run as `npm run build:info` from `.github/workflows/edge-deploy.yml`, immediately before `wrangler deploy`. Deliberately plain Node ESM (no `tsx`/TypeScript compile step) — unlike `sign-allowlist-entry.ts`, this one runs inside the deploy job itself, so it has no dependency beyond what `wrangler deploy` already needs. `.test.ts` sibling covers the pure `renderBuildInfoModule` / `resolveGitSha` functions.

## Constraints

- Requires `MCP_ALLOWLIST_HMAC_SECRET` env var.
- Does not call `wrangler` itself — operator pipes output to their preferred KV-write workflow.
- `generate-build-info.mjs` does not call `wrangler` either — it only writes `src/build-info.ts`; the workflow's next step runs `wrangler deploy` separately.
