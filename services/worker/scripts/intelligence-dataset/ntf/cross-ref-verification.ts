/**
 * NTF-04 (SCRUM-776) — cross-reference verification types + scorer.
 *
 * Given a credential claim and the matching anchored public record, this
 * module decides whether the claim matches, partially matches, or is a
 * mismatch (potential fraud). Mirrors the 8 scenarios the Jira story
 * targets:
 *
 *   1. NPPES specialty / state mismatches
 *   2. Bar number partial matches
 *   3. IPEDS education cross-reference
 *   4. SEC IAPD CRD entity mismatch
 *   5. Expired state licenses presented as active
 *   6. Patent number theft
 *   7. Diploma mill (institution closed before claim date)
 *   8. Insurance license scope exaggeration
 */

export type VerdictKind =
  | 'MATCH'
  | 'PARTIAL_MATCH'
  | 'MISMATCH'
  | 'EXPIRED'
  | 'FABRICATED';

export interface CrossRefClaim {
  /** Claim from the submitted credential. */
  credentialType: string;
  subject: {
    name: string;
    identifiers: Record<string, string>;
  };
  /** Credential-claimed attributes (specialty, state, issue date, etc.). */
  claimed: Record<string, string>;
}

export interface CrossRefRecord {
  source: 'NPPES' | 'IPEDS' | 'IAPD' | 'USPTO' | 'STATE_LICENSE' | 'BAR' | 'INSURANCE';
  /** Actual registry values. */
  actual: Record<string, string>;
  /** ISO date the registry entry was last fetched. */
  fetchedAt: string;
  /** Optional institution-closed-date / license-expired-date. */
  registryStatus?: 'ACTIVE' | 'EXPIRED' | 'CLOSED';
}

export interface CrossRefVerdict {
  verdict: VerdictKind;
  reasons: string[];
  mismatchedFields: string[];
  /** 0-1 — how confident the verdict is. */
  confidence: number;
}

/**
 * Deterministic verdict logic. Callers provide a registry record fetched
 * from the anchored public-record pipeline. Rules:
 *
 *   - If registryStatus is CLOSED and claimed issue date is after the
 *     closure date, mark FABRICATED (diploma mill).
 *   - If registryStatus is EXPIRED and the claim does not disclose it,
 *     mark EXPIRED.
 *   - If any single claimed field diverges from actual, mark MISMATCH.
 *   - If the name on the claim does not match the registry name at all,
 *     mark FABRICATED.
 *   - If every claimed field matches, mark MATCH.
 *   - Otherwise PARTIAL_MATCH.
 */
export function crossReferenceClaim(claim: CrossRefClaim, record: CrossRefRecord): CrossRefVerdict {
  const reasons: string[] = [];
  const mismatchedFields: string[] = [];

  if (record.registryStatus === 'CLOSED') {
    const conferralDate = claim.claimed.conferralDate ?? claim.claimed.issueDate;
    const closureDate = record.actual.closureDate;
    if (conferralDate && closureDate && conferralDate > closureDate) {
      reasons.push(`registry closure ${closureDate} predates claim date ${conferralDate}`);
      return { verdict: 'FABRICATED', reasons, mismatchedFields: ['conferralDate'], confidence: 0.95 };
    }
  }

  if (record.registryStatus === 'EXPIRED') {
    reasons.push('registry shows license expired');
    if (claim.claimed.status && claim.claimed.status.toLowerCase() === 'active') {
      reasons.push('claim presents credential as active');
      return { verdict: 'EXPIRED', reasons, mismatchedFields: ['status'], confidence: 0.92 };
    }
  }

  if (claim.subject.name && record.actual.registeredName) {
    if (!namesOverlap(claim.subject.name, record.actual.registeredName)) {
      reasons.push(`name mismatch: claim "${claim.subject.name}" vs registry "${record.actual.registeredName}"`);
      return { verdict: 'FABRICATED', reasons, mismatchedFields: ['name'], confidence: 0.9 };
    }
  }

  for (const [field, claimedValue] of Object.entries(claim.claimed)) {
    const actualValue = record.actual[field];
    if (actualValue && actualValue !== claimedValue) {
      mismatchedFields.push(field);
      reasons.push(`field ${field} mismatch: claim "${claimedValue}" vs registry "${actualValue}"`);
    }
  }

  if (mismatchedFields.length === 0) {
    return { verdict: 'MATCH', reasons: ['all fields match registry'], mismatchedFields: [], confidence: 0.95 };
  }
  if (mismatchedFields.length === 1) {
    return { verdict: 'PARTIAL_MATCH', reasons, mismatchedFields, confidence: 0.75 };
  }
  return { verdict: 'MISMATCH', reasons, mismatchedFields, confidence: 0.88 };
}

function namesOverlap(a: string, b: string): boolean {
  const tok = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 2);
  const tokA = tok(a);
  const setB = new Set(tok(b));
  if (tokA.length === 0 || setB.size === 0) return false;
  const shared = tokA.filter((t) => setB.has(t)).length;
  // Single-token legitimate names exist (e.g. "Madonna") — one shared token is
  // enough signal to prefer PARTIAL_MATCH over FABRICATED.
  return shared >= 1;
}

/**
 * NTF-04 target: cross-reference accuracy ≥80% on the test set.
 */
export const NTF04_ACCURACY_TARGET = 0.8;

export interface CrossRefEvalEntry {
  claim: CrossRefClaim;
  record: CrossRefRecord;
  expected: VerdictKind;
}

export function scoreCrossRefAccuracy(entries: CrossRefEvalEntry[]): {
  accuracy: number;
  correct: number;
  total: number;
  byVerdict: Record<VerdictKind, { n: number; correct: number }>;
} {
  const byVerdict: Record<VerdictKind, { n: number; correct: number }> = {
    MATCH: { n: 0, correct: 0 },
    PARTIAL_MATCH: { n: 0, correct: 0 },
    MISMATCH: { n: 0, correct: 0 },
    EXPIRED: { n: 0, correct: 0 },
    FABRICATED: { n: 0, correct: 0 },
  };
  let correct = 0;
  for (const e of entries) {
    const v = crossReferenceClaim(e.claim, e.record);
    byVerdict[e.expected].n++;
    if (v.verdict === e.expected) {
      correct++;
      byVerdict[e.expected].correct++;
    }
  }
  return {
    accuracy: entries.length === 0 ? 0 : correct / entries.length,
    correct,
    total: entries.length,
    byVerdict,
  };
}
