# Sarah Sprint 1 — Deploy + Enable Checklist

> **Version:** 1.0 | **Created:** 2026-04-21 | **Owner:** Carson (operator actions)
> **Scope:** Everything shipped across PRs #464, #468, #470, #472 (20 stories) that needs a human to flip/provision in production.

---

## Purpose

The 20 stories in Sarah Sprint 1 extension landed in four merged PRs. Code is on `main`. Vercel auto-deploys the frontend + marketing. Cloud Run worker auto-deploys from main. But several new features need either a **Cloudflare binding** (KV), a **secret** (Sentry DSN), or a **Supabase row** (kill-switch default) before the feature is actually live.

This doc is the single "what does the operator still need to do?" checklist. Work top-to-bottom.

## Status at time of writing

| Item | Status |
|------|--------|
| Supabase `ENABLE_MCP_SERVER` flag seeded `true` | ✅ Done (this checklist) |
| Supabase `ENABLE_PUBLIC_RECORDS_INGESTION` = `true` | ✅ Pre-existing |
| Supabase `ENABLE_VERIFICATION_API` = `true` | ✅ Pre-existing |
| Supabase `ENABLE_AI_EXTRACTION` = `true` | ✅ Pre-existing |
| `MCP_RATE_LIMIT_KV` binding | ⚠️ Already provisioned (previous sprint) |
| `MCP_ORIGIN_ALLOWLIST_KV` binding (SCRUM-985) | ❌ Needs provisioning |
| `SENTRY_DSN` on edge worker (SCRUM-987) | ❌ Needs setting |
| EDGAR Form ADV cron schedule (SCRUM-727) | ❌ Needs Cloud Scheduler entry |
| Drata SOW + connectors (SCRUM-964) | External — Carson's inbox |
| Cyber-insurance broker RFP (SCRUM-961) | External — Carson's inbox |
| CREST pentest RFP (SCRUM-962) | External — Carson's inbox |
| DPF self-certification (SCRUM-963) | External — Carson's inbox |
| CSA STAR L1 submission (SCRUM-960) | External — Carson's inbox |

Pre-existing + external items are out of scope for this runbook; see the per-story execution runbooks in `docs/compliance/`.

## 1. Provision `MCP_ORIGIN_ALLOWLIST_KV` — SCRUM-985

One-time Cloudflare KV namespace for the origin-allowlist gate.

```bash
cd services/edge
npx wrangler kv:namespace create MCP_ORIGIN_ALLOWLIST_KV
# Take the returned namespace_id and paste it into wrangler.toml:
#
#   [[kv_namespaces]]
#   binding = "MCP_ORIGIN_ALLOWLIST_KV"
#   id      = "<namespace_id>"
#
# Commit wrangler.toml. Vercel / CF auto-deploy picks it up.
```

Write the first allowlist entry for any enterprise API key that asks for origin gating (until then, the default policy is `challenge` — acceptable for open-beta):

```bash
npx wrangler kv:key put --binding=MCP_ORIGIN_ALLOWLIST_KV \
  "allow:<api_key_id>" \
  '{"mode":"allowlist","cidrs":["203.0.113.0/24"],"origins":["https://customer.example.com"]}'
```

**Verify:** `curl -I https://edge.arkova.ai/mcp -H 'X-API-Key: <non-allowlisted-key>'` should return 403 with `CF-MCP-Challenge: turnstile` header.

## 2. Set `SENTRY_DSN` on the edge worker — SCRUM-987

The anomaly detector ships alerts via fire-and-forget Sentry envelope POST. Without the DSN the detector still runs, it just never surfaces the alerts.

```bash
cd services/edge
npx wrangler secret put SENTRY_DSN
# Paste the MCP project DSN when prompted (get it from Sentry → Arkova org
# → project "mcp-edge" → Settings → Client Keys).
```

**Verify:** force a rapid-tool-cycling anomaly (6+ distinct tool calls from one API key inside a minute) and confirm a Sentry event appears within 5 seconds in the mcp-edge project.

## 3. Schedule the EDGAR Form ADV cron — SCRUM-727

The `/cron/fetch-edgar-form-adv` endpoint is deployed via the Cloud Run worker (auto-deploy on merge). It needs a Cloud Scheduler entry to fire it nightly.

```bash
gcloud scheduler jobs create http arkova-edgar-form-adv \
  --schedule="0 3 * * *" \
  --uri="https://arkova-worker-<region>.run.app/cron/fetch-edgar-form-adv" \
  --http-method=POST \
  --oidc-service-account-email=<scheduler-invoker@arkova1.iam.gserviceaccount.com> \
  --oidc-token-audience="https://arkova-worker-<region>.run.app" \
  --headers="Content-Type=application/json" \
  --message-body='{"maxRecords":2000}' \
  --time-zone="UTC" \
  --project=arkova1
```

**Verify:** tail Cloud Run logs the morning after the first firing:
```bash
gcloud logging read "resource.type=cloud_run_revision AND jsonPayload.msg=~'EDGAR Form ADV fetch complete'" --project=arkova1 --limit=5
```

## 4. Flip kill-switch off in a drill — SCRUM-929

Smoke-test the kill switch once per quarter. Matches the pentest / SOC 2 DR-tabletop cadence.

Run Section 3 of `docs/runbooks/mcp-kill-switch.md`. Expected: < 60 seconds from SQL flip to 503 at `edge.arkova.ai/mcp`.

## 5. Post-deploy smoke tests (run once)

```bash
# 1. MCP surface still serves (kill-switch default=true).
curl -s https://edge.arkova.ai/mcp/.well-known/oauth-protected-resource | jq .

# 2. Verification API still serves.
curl -I https://api.arkova.ai/api/v1/verify/ARK-DEG-ABC123

# 3. CORS preflight responds on MCP.
curl -I -X OPTIONS https://edge.arkova.ai/mcp \
  -H 'Origin: https://app.arkova.ai' \
  -H 'Access-Control-Request-Method: POST'
```

All three should return 200 / 204 / 200 respectively.

## Change log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-21 | Claude / Carson | Initial checklist for Sarah Sprint 1 four-PR rollout. |
