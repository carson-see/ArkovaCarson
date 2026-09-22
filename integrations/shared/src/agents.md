# integrations/shared/src/agents.md

Shared utilities used across all Arkova integrations (Bullhorn, Clio, Zapier).

## Files
- **`constants.ts`** — `ARKOVA_DEFAULT_URL`: default Arkova API base URL for all integrations.
  **2026-09-21 (SCRUM-3888):** value moved from the raw Cloud Run revision host to the public API
  gateway `https://api.arkova.ai` — the raw host has no Cloudflare origin guard in front of it, and
  SCRUM-3888 enforces that guard and will 403 direct requests to it. Same-day sibling fixes:
  `integrations/zapier/src/constants.ts` (own copy, zapier is a standalone package with its own
  lockfile — cannot depend on this dependency-free tree the way clio/bullhorn do), `packages/sdk`,
  `packages/embed`.
- **`fingerprint.ts`** — `computeFingerprint(data)`: SHA-256 fingerprint via Web Crypto API. Identical algorithm to `arkova`. Works in browsers and Node.js 16+.
- **`constant-time.ts`** — `constantTimeEqual(a, b)`: byte-wise equality with no early exit on content, for authenticating inbound webhooks. Used by Bullhorn (`x-arkova-webhook-secret`) and Clio (HMAC-SHA256 body signature). Length is compared first and leaks, exactly as Node's `timingSafeEqual` does; content timing does not. Tested in `constant-time.test.ts`.

## Conventions
- Keep this package dependency-free (Web Crypto only).
- Fingerprint algorithm must stay in sync with `arkova` and the frontend `generateFingerprint`.


## Testing
`vitest.config.ts` (added 2026-09-05) picks up `src/**/*.test.ts`. This directory has no
`package.json` on purpose — it stays a bare, dependency-free source tree, and vitest resolves from
the repo-root install the way `sdks/langchain-ts` does. Run with `npx vitest run` from
`integrations/shared/`.

## 2026-09-05 — `constantTimeEqual` moved here from Bullhorn (PR #2589 review)

It lived as a private copy in `integrations/bullhorn/src/webhook-handler.ts`. Clio's signature check
needed the same primitive, and a second hand-written copy of a timing-safe compare is a second
chance to get the no-early-exit property wrong. Bullhorn now imports it from here and re-exports the
name so its existing importers and its test are unaffected.

The PR-review finding paired with this one — that lines 7 and 11 still named the retired
`@carsonarkova/sdk` scoped package — was **already satisfied at PR head 5bd5f754b**: both lines read
`arkova`, the unscoped name from the 2026-08-18 CTO ruling. Verified with
`git show 5bd5f754b:integrations/shared/src/agents.md`; no edit was needed. The remaining
`@carsonarkova/sdk` strings in `packages/sdk/agents.md` and `sdks/agents.md` are deliberate,
explicitly-labelled npm-name history and were left alone.
