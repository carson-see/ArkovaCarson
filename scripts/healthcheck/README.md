# scripts/healthcheck — credential + external-service smoke test

**Jira:** [SCRUM-1056 (SEC-HARDEN-03)](https://arkova.atlassian.net/browse/SCRUM-1056)
**Parent epic:** [SCRUM-1041 (SEC-HARDEN)](https://arkova.atlassian.net/browse/SCRUM-1041)

CLI that pings every external service Arkova depends on and reports pass/fail. Used as:

- **Post-rotation verification** after any key rotation (90-day cadence per SEC-HARDEN-04).
- **Secret Manager migration gate** for [SCRUM-1055 (SEC-HARDEN-02)](https://arkova.atlassian.net/browse/SCRUM-1055) — run before + after each secret moves from Cloud Run env vars into GCP Secret Manager.
- **Day-2 smoke test** before sensitive releases (mainnet anchoring, treasury changes).

## Usage

```bash
npm run healthcheck                         # exit 0 if all green, 1 if any red
npm run healthcheck -- --fix                # print remediation hints for failed checks
npm run healthcheck -- --only=gcp-adc,jira  # run a subset by name
```

Per-check timeout is 10s; the suite runs every check in parallel and finishes in <20s.

## Checks

| Name | What it verifies | Required env |
|---|---|---|
| `supabase` | Service-role key still authorized | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| `stripe` | Secret key + balance endpoint | `STRIPE_SECRET_KEY` |
| `together` | Together.ai models endpoint | `TOGETHER_API_KEY` |
| `runpod` | RunPod endpoint health | `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID` |
| `resend` | Resend domains endpoint | `RESEND_API_KEY` |
| `courtlistener` | CourtListener REST root | `COURTLISTENER_API_TOKEN` |
| `openstates` | OpenStates jurisdictions | `OPENSTATES_API_KEY` |
| `sam-gov` | SAM.gov entity-information API | `SAM_GOV_API_KEY` |
| `upstash` | Upstash Redis REST `/ping` | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| `gemini-vertex` | Gemini Generative API (until [SCRUM-1061](https://arkova.atlassian.net/browse/SCRUM-1061) migrates to Vertex SA) | `GEMINI_API_KEY` |
| `anthropic` | Anthropic Claude API (optional — NVI flows only) | `ANTHROPIC_API_KEY` |
| `cloudflare` | Cloudflare API token verify | `CLOUDFLARE_API_TOKEN` |
| `vercel` | Vercel `/v2/user` (works for any token scope) | `VERCEL_TOKEN` |
| `figma` | Figma `/v1/me` via PAT header | `FIGMA_TOKEN` |
| `github` | GitHub `/rate_limit` (works for any valid token) | `GITHUB_TOKEN` or `GH_TOKEN` |
| `sentry` | Parses `SENTRY_DSN` (no network probe — DSN is public) | `SENTRY_DSN` |
| `gcp-adc` | Application-default-credentials context detected | one of `GOOGLE_APPLICATION_CREDENTIALS`, `K_SERVICE`, `GCP_KMS_PROJECT_ID` |
| `jira` | Atlassian token via `/myself` (optional — MCP is primary) | `JIRA_API_TOKEN`, `JIRA_EMAIL` |
| `confluence` | Same Atlassian token via `/wiki/rest/api/space` | `JIRA_API_TOKEN`, `JIRA_EMAIL` |

`anthropic`, `jira`, `confluence` return `ok` when their env vars are absent (they are documented as optional). Every other check returns red on missing env so a partial Secret Manager migration cannot silently pass.

## Adding a check

1. Add to the `checks` array in [`checks.ts`](./checks.ts). Reuse `guardedFetch`, `bearerHeader`, `missingEnv`, and `rotateAt` for consistency.
2. Add the service name to the `required` list in [`tests/infra/healthcheck.test.ts`](../../tests/infra/healthcheck.test.ts) so it's enforced going forward.
3. Document the env var(s) in this README.

## Pitfalls observed while building this

- **GitHub:** prefer `/rate_limit` over `/user` — the latter requires user-scoped tokens and 401s for fine-grained / app installation tokens.
- **Vercel:** prefer `/v2/user` over `/v2/teams` — team-scoped tokens 403 on `/v2/teams`.
- **Figma:** PATs use `X-Figma-Token`, OAuth tokens use `Bearer`. We support PATs only.
- **SAM.gov:** the API key goes in the query string, not a header. Bound the probe (`size=1`) — daily quota is aggressive.
- **Confluence:** the cloud API path is `/wiki/rest/api/...`, not `/rest/api/...`. The same Atlassian token covers Jira + Confluence — don't issue a second one.
