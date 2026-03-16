# Crawler DNS Rebinding Mitigation

_Last updated: 2026-03-16 | Story: INJ-03_

## Overview

The Arkova institution crawler (`services/edge/src/cloudflare-crawler.ts`, P8-S7) fetches
public university websites to build the `institution_ground_truth` table. This creates a
potential Server-Side Request Forgery (SSRF) vector via DNS rebinding.

## Current Mitigations

### 1. Input Validation (`isValidDomain`)

The crawler validates domain format before fetching:

- Rejects domains containing `/`, `:`, `@` (no protocols, ports, or auth)
- Requires at least one dot (valid TLD)
- Blocks direct IPs and private ranges: `localhost`, `127.0.0.1`, `0.0.0.0`,
  `169.254.*`, `10.*`, `172.16.*`, `192.168.*`
- Regex validates alphanumeric domain format with valid TLD

### 2. Cloudflare Workers Sandbox (Primary Defense)

The crawler runs as a **Cloudflare Worker**, which provides strong network isolation:

- Workers execute in V8 isolates with **no access to local networks or private IPs**.
- The `fetch()` API in Workers is proxied through Cloudflare's edge network.
- Requests to private IP ranges (RFC 1918) are **blocked at the runtime level**.
- This is the primary mitigation against DNS rebinding: even if a domain resolves
  to `192.168.x.x` after the initial DNS check, the Workers runtime will refuse
  the connection.

### 3. Batch Size Limiting

Crawl requests are limited to 20 domains per batch to prevent abuse.

## DNS Rebinding Attack Scenario

1. Attacker registers `evil.example.com` with a short TTL.
2. First DNS resolution returns a public IP (passes `isValidDomain` check).
3. Between the check and the fetch, DNS changes to resolve to `192.168.1.1`.
4. The crawler fetches `https://evil.example.com` which now resolves to internal IP.

**Mitigation:** Cloudflare Workers block this at step 4 — the runtime refuses
connections to private IPs regardless of DNS resolution.

## Residual Risk

| Risk | Severity | Mitigation |
|------|----------|------------|
| DNS rebinding to private IPs | **LOW** | Workers sandbox blocks private IP connections |
| DNS rebinding to other Cloudflare services | **LOW** | Workers `fetch()` includes `CF-Worker` header, most services reject |
| Exfiltration via DNS resolution itself | **VERY LOW** | Crawler only processes HTTP responses, not DNS metadata |

## Recommendations for Production Hardening

If the crawler is ever moved out of Cloudflare Workers (e.g., to the Express worker):

1. **Add post-resolution IP validation** — Resolve DNS before fetching and check
   the resolved IP against private ranges (using `dns.resolve()` or `net.isIP()`).
2. **Use `ssrf-req-filter`** or similar SSRF protection library.
3. **Apply the webhook delivery SSRF protection** pattern from
   `services/worker/src/webhooks/delivery.ts` (already has a private IP blocklist).
4. **Set a strict DNS resolver timeout** (2s) to limit rebinding window.

## Related Security Controls

- Webhook delivery SSRF protection: `services/worker/src/webhooks/delivery.ts`
- SSRF protection tests: `services/worker/src/webhooks/ssrf-protection.test.ts`
- Security audit finding: `docs/security/launch_readiness_security_audit.md` (INJ-03)
