/**
 * NVI-15 — Nessie endpoint quarantine (SCRUM-819)
 *
 * When an intelligence-model endpoint is trained on a dataset whose
 * citations have not passed NVI verification (NVI-01..04), we must NOT
 * silently route customer traffic to it as if its citations were
 * trustworthy. But we also don't take the endpoint offline — the model
 * still provides useful regulatory context, just with a caveat.
 *
 * Policy (see docs/runbooks/nvi-quarantine-2026-04-17.md):
 *   - v27.x FCRA    : UNDER_REVIEW (FCRA is the designated single-domain
 *                     mastery target — NVI gate applies to it first)
 *   - v28.x HIPAA   : QUARANTINED (served, but UI surfaces a caveat,
 *                     confidence is downgraded by 0.1, and the audit
 *                     metadata records the quarantine status)
 *   - v29.x FERPA   : QUARANTINED (same treatment as HIPAA)
 *   - v30+ (new regulation): DISABLED until NVI gate passes on FCRA
 *
 * Consumers:
 *   - nessie.ts / nessie-domain-router.ts — consults status before response
 *     shaping and attaches `quarantine` field to the response
 *   - UI (compliance scorecard, intelligence answers) — surfaces the
 *     human-readable caveat string
 *   - /api/v1/compliance/audit — flags quarantined regulations in the
 *     audit result so org admins see the caveat in the scorecard
 *
 * This module is PURE (no DB / no env reads outside the explicit
 * environment override) so it is safe to unit test and safe to call from
 * anywhere in the request path.
 */

export type QuarantineStatus =
  /** Endpoint is fully trusted — NVI verification passes. */
  | 'CLEAR'
  /** Actively under NVI review; not yet cleared. */
  | 'UNDER_REVIEW'
  /** Endpoint remains in production but results MUST carry a caveat. */
  | 'QUARANTINED'
  /** Endpoint is NOT available to customer-facing code paths. */
  | 'DISABLED';

export interface QuarantineEntry {
  /** Regulation short-code ("FCRA", "HIPAA", "FERPA", etc). */
  regulation: string;
  /** Endpoint / model version (e.g. "v28.0"). */
  version: string;
  status: QuarantineStatus;
  /** Human-readable explanation surfaced to UI caveats. */
  caveat: string;
  /** Confidence downgrade applied to responses from this endpoint (0-0.5). */
  confidenceDowngrade: number;
  /** Jira ticket tracking the review / clearance. */
  tracking: string;
  /** ISO date quarantine was placed. */
  quarantinedAt: string;
}

/**
 * Current quarantine roster. Update this when a regulation passes NVI or
 * a new regulation is added.
 *
 * Kept in code rather than a migration because (a) this is a policy
 * decision the worker must honor on every request — no DB round-trip —
 * and (b) PR review is the right audit trail for quarantine changes.
 */
export const NESSIE_QUARANTINE: QuarantineEntry[] = [
  {
    regulation: 'FCRA',
    version: 'v27.x',
    status: 'UNDER_REVIEW',
    caveat:
      'FCRA compliance intelligence is undergoing citation verification (NVI-01..04). ' +
      'Cited statutes, cases, and agency bulletins are being independently checked — some answers may be revised.',
    confidenceDowngrade: 0.05,
    tracking: 'SCRUM-804 (NVI)',
    quarantinedAt: '2026-04-16',
  },
  {
    regulation: 'HIPAA',
    version: 'v28.x',
    status: 'QUARANTINED',
    caveat:
      'HIPAA intelligence answers are based on a training dataset that has NOT passed full citation verification. ' +
      'Do not rely on quoted statute/agency text without independent review — verify against 45 CFR §164 directly.',
    confidenceDowngrade: 0.1,
    tracking: 'SCRUM-819 (NVI-15)',
    quarantinedAt: '2026-04-16',
  },
  {
    regulation: 'FERPA',
    version: 'v29.x',
    status: 'QUARANTINED',
    caveat:
      'FERPA intelligence answers are based on a training dataset that has NOT passed full citation verification. ' +
      'Do not rely on quoted statute/agency text without independent review — verify against 20 U.S.C. §1232g and 34 CFR Part 99 directly.',
    confidenceDowngrade: 0.1,
    tracking: 'SCRUM-819 (NVI-15)',
    quarantinedAt: '2026-04-16',
  },
];

/**
 * Look up the quarantine entry for a (regulation, version) pair. Version
 * matches by prefix (e.g. "v28.0" matches "v28.x"). Unknown pairs default
 * to CLEAR.
 */
export function getQuarantineStatus(
  regulation: string,
  version: string,
): QuarantineEntry {
  const reg = regulation.toUpperCase();
  for (const entry of NESSIE_QUARANTINE) {
    if (entry.regulation !== reg) continue;
    if (matchesVersion(version, entry.version)) return entry;
  }
  return {
    regulation: reg,
    version,
    status: 'CLEAR',
    caveat: '',
    confidenceDowngrade: 0,
    tracking: '',
    quarantinedAt: '',
  };
}

/**
 * Returns true iff a customer-facing request is permitted to use an
 * endpoint with the given status. QUARANTINED endpoints are permitted
 * (with a caveat); DISABLED endpoints are not.
 */
export function isCustomerRoutable(status: QuarantineStatus): boolean {
  return status !== 'DISABLED';
}

/**
 * Apply the quarantine confidence downgrade to a raw confidence score.
 * Never pushes below 0 or above 1.
 */
export function applyConfidenceDowngrade(rawConfidence: number, entry: QuarantineEntry): number {
  if (entry.status === 'CLEAR') return rawConfidence;
  return Math.max(0, Math.min(1, rawConfidence - entry.confidenceDowngrade));
}

function matchesVersion(actual: string, pattern: string): boolean {
  // "v28.x" matches "v28.0", "v28.1", "v28.10". "v28.0" (exact) matches only "v28.0".
  if (pattern.endsWith('.x')) {
    const prefix = pattern.slice(0, -1); // "v28."
    return actual.startsWith(prefix);
  }
  return actual === pattern;
}
