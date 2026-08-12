/**
 * Cross-tenant assertion evaluators — DEG-4 (SOAK-PREMORTEM-SOC2-2026-08-11 §4).
 *
 * Pure verdict logic for e2e/cross-tenant.spec.ts, extracted so the exact
 * failure semantics are unit-testable without a browser
 * (tests/infra/cross-tenant-assertions.test.ts — same pattern as
 * soaking-ref-guard.ts). The spec's Playwright helpers observe the page and
 * feed a RecordPageObservation in; every verdict here is deterministic.
 *
 * The defect this closes: the old `expectRecordBlocked()` waited for
 * `window.location.pathname !== recordPath` and treated ANY navigation away —
 * including a redirect to /login from an expired accessor session — as
 * "blocked". Since the daily run of the cross-tenant spec is the G4 (CC6.1)
 * evidence for the SOC 2 Type 2 soak, an expired Org B session on Day 4 made
 * all isolation tests pass while proving nothing.
 *
 * Hardened semantics:
 *  - "Blocked" means EXACTLY: still on the record path AND the explicit
 *    `Record Not Found` heading rendered AND the record content did not.
 *  - Any navigation away (login redirect, dashboard bounce, onboarding
 *    gate...) is NOT evidence of isolation and fails with a reason naming
 *    where the browser went.
 *  - A positive-access precondition verdict exists so every isolation test
 *    first proves the ACCESSING session can read its own data; its failure
 *    message is the distinct `precondition: <label> session not authenticated`
 *    so a dead session is instantly distinguishable from an isolation failure.
 */

export const LOGIN_PATH = '/login';
/** Heading RecordDetailPage renders when the query returns no row (RLS denial / missing). */
export const RECORD_BLOCKED_HEADING = 'Record Not Found';
/** Heading RecordDetailPage renders when the record content loaded. */
export const RECORD_DETAILS_HEADING = 'Record Details';

export interface RecordPageObservation {
  /** Pathname of the record under test, e.g. `/records/<id>`. */
  recordPath: string;
  /** Pathname where the browser actually ended up. */
  finalPath: string;
  /** Whether the explicit blocked heading (`Record Not Found`) is visible. */
  notFoundHeadingVisible: boolean;
  /** Whether the record content heading (`Record Details`) is visible. */
  detailsHeadingVisible: boolean;
}

export type BlockedVerdict = { blocked: true } | { blocked: false; reason: string };

export type PositiveAccessVerdict =
  | { authenticated: true }
  | { authenticated: false; reason: string };

function isLoginPath(path: string): boolean {
  return path === LOGIN_PATH || path.startsWith(`${LOGIN_PATH}/`) || path.startsWith(`${LOGIN_PATH}?`);
}

/**
 * Decide whether a cross-tenant record access was EXPLICITLY blocked.
 *
 * Only one observation passes: still on the record path, `Record Not Found`
 * rendered, record content absent. Everything else fails with a diagnostic
 * reason — including the old spec's hollow-pass case (redirect to /login).
 */
export function evaluateRecordBlocked(obs: RecordPageObservation): BlockedVerdict {
  if (obs.finalPath !== obs.recordPath) {
    const loginNote = isLoginPath(obs.finalPath)
      ? ' A /login redirect means the ACCESSING session is unauthenticated or expired — the exact DEG-4 hollow-pass this helper exists to reject.'
      : '';
    return {
      blocked: false,
      reason:
        `navigated away from ${obs.recordPath} to ${obs.finalPath}; a redirect is NOT evidence of tenant ` +
        `isolation — only the explicit '${RECORD_BLOCKED_HEADING}' state on the record path counts.${loginNote}`,
    };
  }

  if (obs.detailsHeadingVisible) {
    return {
      blocked: false,
      reason:
        `record content ('${RECORD_DETAILS_HEADING}') rendered at ${obs.recordPath} — the cross-tenant read ` +
        'SUCCEEDED. This is a tenant-isolation failure, not a test defect.',
    };
  }

  if (obs.notFoundHeadingVisible) {
    return { blocked: true };
  }

  return {
    blocked: false,
    reason:
      `no explicit blocked state: the page stayed on ${obs.recordPath} but the '${RECORD_BLOCKED_HEADING}' ` +
      'heading never rendered within budget. An indeterminate page is not blocked.',
  };
}

/**
 * Positive-access precondition: the ACCESSING session must render its OWN
 * record before any assertion that it cannot render someone else's. A failure
 * always carries the distinct `precondition:` prefix so it can never be
 * mistaken for (or silently converted into) an isolation result.
 */
export function evaluatePositiveAccess(
  obs: RecordPageObservation,
  sessionLabel: string,
): PositiveAccessVerdict {
  if (obs.finalPath !== obs.recordPath) {
    return {
      authenticated: false,
      reason:
        `precondition: ${sessionLabel} session not authenticated — navigated to ${obs.finalPath} instead of ` +
        `rendering its own record at ${obs.recordPath}. Isolation assertions for this session would be hollow; failing the test instead.`,
    };
  }

  if (obs.detailsHeadingVisible) {
    return { authenticated: true };
  }

  if (obs.notFoundHeadingVisible) {
    return {
      authenticated: false,
      reason:
        `precondition: ${sessionLabel} session cannot read its OWN record at ${obs.recordPath} ` +
        `('${RECORD_BLOCKED_HEADING}' rendered). The session is live but the fixture/session pairing is wrong — ` +
        'isolation assertions would be meaningless.',
    };
  }

  return {
    authenticated: false,
    reason:
      `precondition: ${sessionLabel} session did not render its own record at ${obs.recordPath} within budget ` +
      '(neither the record content nor an error state appeared).',
  };
}
