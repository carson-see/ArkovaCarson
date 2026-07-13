# services/api-gateway — Arkova API Gateway (Cloudflare Worker)

## What this is

A minimal Cloudflare Worker (`arkova-api-gateway`) that owns two custom
domains on the `arkova.ai` zone:

| Hostname | Purpose |
|---|---|
| `api.arkova.ai` | Public API hostname. Path-mapped allowlist proxy to the Cloud Run worker (`WORKER_ORIGIN` in `src/router.ts`). |
| `docs.arkova.ai` | Developer docs landing page + `/keys.json` (proof-bundle Ed25519 verification-key distribution point referenced by `services/worker/src/api/v1/verify-proof.ts`). |

Deployed 2026-07-12 to close the gap where both hostnames were referenced in
code and SDK defaults (v2 OpenAPI `servers`, `packages/arkova-py` default
`base_url`, edge `WORKER_BASE_URL` deploy comment) but did not resolve.

## Path contract (api.arkova.ai)

- `/v1/*` → worker `/api/v1/*` and `/v2/*` → worker `/api/v2/*` — this is the
  hostname contract the Python SDK (`base_url="https://api.arkova.ai/v2"`,
  sibling-`/v1` routing) and the v2 OpenAPI `servers` entry rely on.
- `/api/v1/*`, `/api/v2/*`, `/api/docs/spec.json` → passthrough (canonical
  full paths keep working). **No blanket `/api/*`** — the worker also mounts
  non-versioned `/api/admin`, `/api/treasury`, `/api/billing`, `/api/audit`,
  and `/api/anchor-revoke` surfaces that are NOT public contract and must
  never resolve on this hostname (P1 review, PR #1505; regression-tested).
- `/health` → worker `/health`; `/openapi.json` → worker `/api/docs/spec.json`.
- Everything else → 404. **Deliberately an allowlist**: internal worker
  routes (`/jobs/*`, `/webhook-retries`, cron surfaces) are NOT exposed on
  the public hostname. Do not widen to a catch-all.
- `docs.arkova.ai/keys.json` shape is the verifier contract (`PublishedKeys`
  in `packages/verifier-cli/src/types.ts`): top-level `keys[]` of
  `{kid, alg, pem}` — `signing_key_id` resolves against `keys[].kid`.

## Rules for this folder

- **Peripheral proxy only** (CLAUDE.md §1.1 edge-compute constraint): no
  business logic, no secrets, no bindings, no data access. Auth, rate
  limiting, and CORS are the worker's job — the gateway forwards
  `CF-Connecting-IP` as `X-Forwarded-For` and sets `X-Forwarded-Host`, only.
- Routing changes go through `resolveRoute()` in `src/router.ts` (pure,
  fully unit-tested in `src/router.test.ts`). TDD: extend the test first.
- `keys.json` (`src/index.ts`) is the published verification-key list. It is
  EMPTY until `PROOF_SIGNING_*` is configured on the production worker —
  publish the public key here in the same change that enables signing, and
  bump the `updated` field.
- Deploy: `npm run deploy` with `CLOUDFLARE_API_TOKEN` (Secret Manager:
  `cloudflare_api_prod_token`). Note: the current tokens can upload the
  script but lack zone `Workers Routes` permission, so `wrangler deploy`
  exits non-zero AFTER a successful upload while reconciling `routes` — the
  custom domains were attached via the account-scoped API
  (`PUT /accounts/{id}/workers/domains`) and persist independently of that
  error. Verify with `curl https://api.arkova.ai/health` after deploy.

## Test / verify

```
npm test          # vitest — routing contract
npm run typecheck
curl -s https://api.arkova.ai/health
curl -s https://api.arkova.ai/v1/verify/<public-id>
curl -s https://docs.arkova.ai/keys.json
```
