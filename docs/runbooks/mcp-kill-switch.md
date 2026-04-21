# MCP Kill-Switch Runbook

> **Version:** 1.0 | **Created:** 2026-04-21 | **Jira:** SCRUM-929 (MCP-SEC-10)
> **SLA:** MCP endpoint offline within 60 seconds of the flag flip.

---

## Purpose

An incident responder needs to take the MCP endpoint offline fast when:

- A zero-day is reported in any MCP tool handler.
- A compromised API key is exfiltrating data and rate-limiting is
  not enough.
- An upstream dependency (Supabase, Nessie, Gemini) is degraded in a
  way that the MCP surface amplifies (thundering-herd, retry storms).
- Maintenance or migration requires quiet traffic.

Before this runbook existed, the only options were `wrangler delete` or
a hot deploy — both carry blast-radius risk and neither is sub-60s. The
kill switch is a single row update in `switchboard_flags` that every
edge isolate observes within 30 seconds (cache TTL).

## How it works

1. `handleMcpRequest` calls `isMcpEnabled({ env })` **after** the
   CORS-preflight + `.well-known` paths but **before** the auth check.
   The auth layer itself is skipped so that cred brute-force can't race
   the kill switch.
2. `isMcpEnabled` calls the `get_flag` RPC for `ENABLE_MCP_SERVER` and
   caches the result in module scope for 30 seconds per isolate.
3. When the flag is `false`, every request (except CORS preflight + the
   well-known OAuth discovery URL) returns a 503 with:
   ```json
   { "error": "mcp_disabled", "retry_after_seconds": 60 }
   ```
4. The response carries `Retry-After: 60` so compliant clients back
   off automatically.
5. `.well-known/oauth-protected-resource` stays live so clients can
   still discover how to re-auth once the switch flips back.

## How to flip the switch

### Disable (kill)

1. Open the [Supabase dashboard](https://supabase.com/dashboard) →
   `arkova-prod` project → **SQL Editor**.
2. Run:
   ```sql
   select set_flag('ENABLE_MCP_SERVER', false, 'incident-<id> — <short reason>');
   ```
   (`set_flag` is the write-side function that mirrors `get_flag`.)
3. Wait **up to 30 seconds** for every edge isolate to pick up the
   new value on next request.
4. Confirm with `curl`:
   ```bash
   curl -i https://edge.arkova.ai/mcp -H 'X-API-Key: <any-key>'
   # Expect: HTTP/2 503
   # Expect: X-MCP-Disabled: 1 (optional future header)
   ```

### Re-enable (recovery)

1. Verify the root cause is mitigated (hot-fix deployed, credential
   rotated, upstream back to green).
2. Run:
   ```sql
   select set_flag('ENABLE_MCP_SERVER', true, 'incident-<id> — resolved');
   ```
3. Wait up to 30 seconds, then:
   ```bash
   curl -i https://edge.arkova.ai/mcp -H 'X-API-Key: <any-key>'
   # Expect: HTTP/2 401 (auth layer is back) or 200 with MCP envelope
   ```
4. Post-incident: file the incident report at
   `docs/incidents/<YYYY-MM-DD>-<id>.md` and link it in Jira.

## Decision matrix — when to use this vs other mitigations

| Situation | First response | Kill switch? |
|-----------|----------------|--------------|
| One API key abusive | rate limiter (MCP-SEC-01) + revoke key | No |
| Unknown origin hammering | origin allowlist (MCP-SEC-08) | No |
| Auth-failure burst from one IP | CF WAF block | No |
| Zero-day in tool handler | **kill switch** + hot-fix | **Yes** |
| Supabase read path down | Rely on rate-limit + retry logic | Usually no; use if MCP response times > 10s |
| Upstream Nessie / Gemini degraded | Disable the specific tool via tool-level flag (future) | No |
| Active data-exfil incident | **kill switch** + API key mass-revoke | **Yes** |

## What stays live when the switch is tripped

- `GET /.well-known/oauth-protected-resource` — so clients can keep
  their OAuth discovery working and re-auth once we re-enable.
- `OPTIONS /*` CORS preflight — so browser-based clients get the
  correct CORS answer instead of a hang.
- The worker's `/health` endpoint (defined in `index.ts` outside of
  `handleMcpRequest`).

Everything else — tool calls, session management, all MCP transport —
returns 503.

## What does NOT take down with the switch

- The frontend (`arkova-26.vercel.app`, `app.arkova.ai`) keeps serving.
- The verification API (`/api/v1/*` on the worker) keeps serving.
- Cron jobs keep running.
- Bitcoin anchoring keeps running.
- Webhook delivery keeps running.

The kill switch is intentionally narrow — MCP surface only.

## Recovery metrics to validate

After flipping the switch back on, watch:

- Sentry MCP error rate → should return to < 0.1% in 5 minutes.
- p95 MCP tool-call latency → should return to baseline in 5 minutes.
- Rate-limit hits → confirm clients respect the earlier `Retry-After`
  and are not thundering-herding on recovery.

## Change log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-21 | Claude / Carson | Initial runbook (SCRUM-929). |
