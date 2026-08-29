/**
 * Nessie capability gate — BUG-008 / BUG-027 (CTO ruling R-1 STRENGTHENED,
 * `docs/staging/fullsoak-2026-08/cto-claims-rulings-2026-08-12.md`).
 *
 * Nessie is permanently disabled by standing founder directive (2026-08-01).
 * Until this gate existed, `/api/v1/nessie/query` was mounted UNCONDITIONALLY
 * and answered **HTTP 200 with a success-shaped body** — `{"results":[],
 * "count":0}` in retrieval mode, and a fluent
 * `{"answer":"No relevant verified documents were found…","confidence":0}` in
 * context mode. A caller could not tell "this capability is off" from "it ran
 * and found nothing". That is the fail-open pattern §1.13 R-7 exists to stop,
 * and it was reachable by a *paying* caller because the route sat behind a
 * priced x402 gate.
 *
 * Two properties this module guarantees:
 *
 *  1. FAIL CLOSED. `ENABLE_NESSIE_QUERY` is an ENV flag defaulting to false,
 *     deliberately not a `switchboard_flags` row. A capability disabled by
 *     founder directive must not be re-enablable by a DB write — flipping it
 *     on requires a deploy, which is a reviewable event. (The endpoint's
 *     pre-existing `ENABLE_PUBLIC_RECORD_EMBEDDINGS` check is NOT this gate:
 *     that flag governs the public-record embedding index, is legitimately ON,
 *     and passing it is exactly how a permanently-disabled capability came to
 *     answer 200.)
 *
 *  2. EXPLICIT DISABLED RESPONSE. The body carries `enabled: false` plus a
 *     stable machine code and carries NONE of the success-shape keys
 *     (`results` / `count` / `answer` / `confidence` / `citations`). A disabled
 *     answer is separable from an empty answer on both status and shape, by a
 *     machine, without heuristics.
 *
 * 503 (not 404) is deliberate: `/api/v1/nessie/query` is a PUBLISHED surface —
 * it was listed, and priced, on `/developers`. Hiding it would leave callers
 * who already integrated with a bare "route not found". They get told.
 */

import { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** Stable machine-readable code for the disabled capability. */
export const NESSIE_DISABLED_CODE = 'nessie_disabled';

/** HTTP status used for the disabled capability (published-but-off surface). */
export const NESSIE_DISABLED_STATUS = 503;

/**
 * Is the Nessie query capability enabled?
 *
 * Env-backed and fail-closed: an unset, malformed, or absent flag is `false`.
 */
export function isNessieQueryEnabled(): boolean {
  return config.enableNessieQuery === true;
}

/**
 * The canonical disabled envelope.
 *
 * Returned fresh on every call so no caller can mutate a shared object into a
 * success shape. Deliberately carries no `results`, `count`, `answer`,
 * `confidence` or `citations` key — the ABSENCE of those keys is half the
 * contract, and `nessieCapabilityGate.test.ts` pins it.
 */
export function nessieDisabledBody(): Record<string, unknown> {
  return {
    error: 'capability_disabled',
    code: NESSIE_DISABLED_CODE,
    capability: 'nessie',
    enabled: false,
    message:
      'The Nessie intelligence query capability is disabled and is not being served. ' +
      'This is not an empty result — no query was executed.',
  };
}

/**
 * Express middleware that blocks the Nessie surface when the capability is off.
 *
 * Mount this BEFORE the payment gate. A disabled capability must never take a
 * caller's money on the way to telling them it is disabled.
 */
export function nessieCapabilityGate() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isNessieQueryEnabled()) {
      next();
      return;
    }

    logger.warn(
      { path: req.originalUrl ?? req.path, capability: 'nessie' },
      'Nessie query request rejected — capability disabled (fail closed)',
    );
    res.status(NESSIE_DISABLED_STATUS).json(nessieDisabledBody());
  };
}
