/**
 * scripts/staging/ai-eval/rate.ts — pure rate-control + identity-sharding helpers
 * for the AI soak harness. Kept side-effect-free so the logic is unit-testable
 * without a live clock or network.
 */

import type { WorkerIdentity } from './ai-client.js';

/** Per-user cap enforced by the worker's aiRateLimiter (30 req/min/user). */
export const PER_USER_LIMIT_PER_MIN = 30;
/** Per-IP anon cap (AI calls carry no API key → anon bucket = 100 req/min/IP). */
export const PER_IP_LIMIT_PER_MIN = 100;

/**
 * Even inter-request interval (ms) for a target requests-per-hour. A steady rate
 * beats bursts: it keeps p95 latency honest and avoids self-inflicted 429s.
 */
export function intervalMsForRatePerHour(ratePerHour: number): number {
  if (ratePerHour <= 0) throw new Error(`ratePerHour must be positive; received ${ratePerHour}`);
  return Math.floor(3_600_000 / ratePerHour);
}

/**
 * Minimum number of distinct Supabase users needed to sustain a target rate
 * without any single user tripping the 30 req/min per-user limiter, with a
 * safety headroom factor (default 1.0 = exactly at the limit; the CLI defaults
 * higher). 5,000/hr ÷ 30/min = 2.78 → ceil = 3 users bare-minimum.
 */
export function minUsersForRatePerHour(ratePerHour: number, headroom = 1): number {
  if (ratePerHour <= 0) throw new Error(`ratePerHour must be positive; received ${ratePerHour}`);
  if (headroom <= 0) throw new Error(`headroom must be positive; received ${headroom}`);
  const perUserPerHour = PER_USER_LIMIT_PER_MIN * 60; // 1800/hr/user
  return Math.max(1, Math.ceil((ratePerHour * headroom) / perUserPerHour));
}

/**
 * Given a target rate and a pool of identities, report whether the pool is big
 * enough and what the resulting per-user rate would be. Fail-loud on an
 * undersized pool so the operator can add JWTs before the soak (not discover
 * 429 storms mid-run).
 */
export interface RatePlan {
  ratePerHour: number;
  intervalMs: number;
  userCount: number;
  minUsers: number;
  perUserPerMin: number;
  sufficient: boolean;
  warning?: string;
}

export function planRate(ratePerHour: number, identities: WorkerIdentity[], headroom = 1.3): RatePlan {
  const minUsers = minUsersForRatePerHour(ratePerHour, headroom);
  const userCount = identities.length;
  const perUserPerMin = userCount > 0 ? ratePerHour / 60 / userCount : Infinity;
  const sufficient = userCount >= minUsers && perUserPerMin <= PER_USER_LIMIT_PER_MIN;
  let warning: string | undefined;
  if (userCount === 0) {
    warning = 'No identities supplied — every AI call would be unauthenticated (401).';
  } else if (!sufficient) {
    warning =
      `Undersized identity pool: ${userCount} user(s) for ${ratePerHour}/hr implies ` +
      `${perUserPerMin.toFixed(1)} req/min/user (> ${PER_USER_LIMIT_PER_MIN} limit). ` +
      `Supply >= ${minUsers} distinct Supabase JWTs (headroom ${headroom}x).`;
  }
  return {
    ratePerHour,
    intervalMs: intervalMsForRatePerHour(ratePerHour),
    userCount,
    minUsers,
    perUserPerMin,
    sufficient,
    warning,
  };
}

/** Deterministic round-robin identity picker (keeps per-user pacing even). */
export function pickIdentity(identities: WorkerIdentity[], sequence: number): WorkerIdentity {
  if (identities.length === 0) throw new Error('Cannot pick from an empty identity pool.');
  return identities[sequence % identities.length];
}
