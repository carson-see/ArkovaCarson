# Rate Limiting — Single-Instance Limitation

_Last updated: 2026-03-16 | Story: AUTH-05_

## Overview

Arkova's rate limiter uses an **in-memory `Map`** (`services/worker/src/utils/rateLimit.ts`).
This is simple, zero-dependency, and correct for a single-instance deployment. It does **not**
share state across multiple worker instances.

## Current Configuration

| Limiter | Limit | Window | Scope |
|---------|-------|--------|-------|
| `stripeWebhook` | 100 req/min | 60 s | Global |
| `checkout` | 10 req/min | 60 s | Per IP |
| `api` | 60 req/min | 60 s | Per IP |
| `auth` | 5 req/min | 60 s | Per IP (skip failed) |
| `quotaCheck` | 10 req/min | 60 s | Per IP |

### Public API Limits (Constitution 1.10)

| Endpoint | Limit | Scope |
|----------|-------|-------|
| `/api/v1/*` (anonymous) | 100 req/min | Per IP |
| `/api/v1/*` (API key) | 1,000 req/min | Per key |
| `/api/v1/verify/batch` | 10 req/min | Per API key |
| AI operations | 30 req/min | Per user |

These public API limits are enforced via the API key middleware in `services/worker/src/api/v1/router.ts`.

## Limitation: Multi-Instance Deployments

If the worker is scaled to N instances behind a load balancer, each instance maintains
its own in-memory rate limit counters. Consequences:

- **Effective limit = N x configured limit** (per instance, not global).
- A client could bypass limits by having requests distributed across instances.
- Window resets are per-instance, not synchronized.

### When This Matters

- **Single Cloud Run instance (current production):** Not an issue. The single instance
  holds all state correctly.
- **Auto-scaled Cloud Run (future):** Rate limits become approximate. Clients may get
  2-3x the configured limit depending on instance count and load balancer stickiness.
- **Multi-region deployment:** Each region's instances are fully independent.

### When To Upgrade

Upgrade to a shared store (Redis/Memorystore) when:

1. The worker is scaled beyond 1 instance, **AND**
2. Rate limiting precision is security-critical (e.g., auth brute force protection).

For general API rate limiting, approximate enforcement (2-3x headroom) is acceptable
until traffic justifies the infrastructure cost.

## Recommended Migration Path

1. **Add `@upstash/ratelimit` or `ioredis`** as a dependency.
2. Replace `Map<string, RateLimitEntry>` with Redis `INCR` + `EXPIRE` commands.
3. Configure GCP Memorystore (Redis) or Upstash Redis in the project.
4. Update `rateLimit.ts` to accept a pluggable store interface.
5. Keep the in-memory implementation as a fallback for local development.

## Test Coverage

18 tests in `services/worker/src/utils/rateLimit.test.ts` cover window management,
limit enforcement, headers, key generation, `skipFailedRequests`, and cleanup. These
tests use the in-memory store and remain valid for any backend.
