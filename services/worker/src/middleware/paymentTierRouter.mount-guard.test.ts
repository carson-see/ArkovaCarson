/**
 * paymentTierRouter mount guard (SCRUM-2971 code review follow-up)
 *
 * `paymentTierRouter`'s Tier-2 stripe-metered path has a known under-billing
 * vector: `stripeMeteredRequestId()` trusts the client-supplied
 * `Idempotency-Key` header as the SOLE input to the billing_events
 * idempotency key, and a duplicate (23505) is silently swallowed as an
 * idempotent no-op while the request is still authorized. A subscriber who
 * reuses one `Idempotency-Key` value on every metered call — not just on
 * genuine retries — collapses ALL of them onto a single `billing_events`
 * row, forever. See the full writeup in the block comment above
 * `STRIPE_METERED_UNDER_BILLING_RISK_ACKED` in `paymentTierRouter.ts`.
 *
 * This is inert today only because `paymentTierRouter` is never imported or
 * mounted in `services/worker/src/index.ts` (or any other app-wiring
 * entrypoint). This test scans those entrypoints and fails loudly the
 * instant a mount is introduced without `STRIPE_METERED_UNDER_BILLING_RISK_ACKED`
 * having been explicitly flipped to `true` — so mounting this middleware
 * without addressing (or consciously, visibly accepting) the gap can never
 * pass CI silently.
 */

import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// paymentTierRouter.ts imports ../utils/db.js, which validates the full
// worker env config (Zod) at import time — irrelevant to this guard, and
// unset in a bare test run. Mock the same way paymentTierRouter.test.ts
// does so importing the module for its exported flag doesn't blow up on
// missing SUPABASE_URL/STRIPE_SECRET_KEY/etc.
vi.mock('../utils/db.js', () => ({
  db: { rpc: vi.fn(), from: vi.fn() },
}));
vi.mock('../config.js', () => ({
  config: { nodeEnv: 'development' },
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { STRIPE_METERED_UNDER_BILLING_RISK_ACKED } from './paymentTierRouter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// services/worker/src/middleware/ -> services/worker/src/
const WORKER_SRC = resolve(__dirname, '..');

// Known app-wiring entrypoints, checked for a paymentTierRouter reference.
// Add new entrypoints here if the worker's Express app setup ever moves.
const ENTRYPOINT_CANDIDATES = ['index.ts', 'app.ts', 'server.ts'];

describe('paymentTierRouter mount guard (SCRUM-2971)', () => {
  it('is not referenced from any app entrypoint without an explicit risk acknowledgement', () => {
    const mountSites = ENTRYPOINT_CANDIDATES
      .map((file) => resolve(WORKER_SRC, file))
      .filter((path) => existsSync(path))
      .filter((path) => {
        const text = readFileSync(path, 'utf8');
        // Match an actual reference to the router (import or call), not this
        // guard test's own file path appearing in some unrelated string.
        return /paymentTierRouter/.test(text);
      });

    if (mountSites.length === 0) {
      // Still unmounted — nothing to enforce yet.
      expect(mountSites).toHaveLength(0);
      return;
    }

    expect(
      STRIPE_METERED_UNDER_BILLING_RISK_ACKED,
      `paymentTierRouter is now referenced from ${mountSites.join(', ')} but the ` +
        'known Tier-2 under-billing vector (client-controlled Idempotency-Key ' +
        'header is the SOLE idempotency-key input for stripe-metered billing — ' +
        'see the comment above STRIPE_METERED_UNDER_BILLING_RISK_ACKED in ' +
        'paymentTierRouter.ts) has not been fixed or explicitly acknowledged. ' +
        'Either rebind the idempotency key to a server-derived component that ' +
        'bounds a replayed header to one collapse window, or flip the flag with ' +
        'a dated, named sign-off in that comment before mounting.',
    ).toBe(true);
  });
});
