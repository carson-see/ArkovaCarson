/**
 * NTF-05 (SCRUM-777) — credential portability knowledge + analyzer.
 *
 * Structured data for major interstate compacts plus a deterministic
 * analyzer that decides whether a specific credential in a source state
 * transfers to a target state as: FULL_PORTABILITY, ENDORSEMENT,
 * RECIPROCITY, or FULL_REAPPLICATION. Compact coverage is the v1 seed —
 * add more as scenarios require.
 */

export type PortabilityOutcome =
  | 'FULL_PORTABILITY'
  | 'ENDORSEMENT'
  | 'RECIPROCITY'
  | 'FULL_REAPPLICATION';

export interface InterstateCompact {
  id: string;
  name: string;
  profession: string;
  memberStates: string[];
  /** Years compact has been in force (for caveat: new-compact transitional rules). */
  effectiveSince: number;
  /** Short description of the privilege granted. */
  privilege: string;
}

/**
 * Professions that typically support endorsement in non-compact pairings.
 * Sourced from FSMB, NCSBN, and NABP endorsement-policy summaries (2025).
 */
const ENDORSEMENT_ELIGIBLE_PROFESSIONS = ['physician', 'rn', 'lpn', 'nurse practitioner', 'pharmacist'] as const;

export const INTERSTATE_COMPACTS: InterstateCompact[] = [
  {
    id: 'nlc',
    name: 'Nurse Licensure Compact',
    profession: 'RN / LPN',
    memberStates: ['AL', 'AZ', 'AR', 'CO', 'DE', 'FL', 'GA', 'ID', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MS', 'MO', 'MT', 'NE', 'NH', 'NJ', 'NM', 'NC', 'ND', 'OH', 'OK', 'SC', 'SD', 'TN', 'TX', 'UT', 'VA', 'WV', 'WI', 'WY'],
    effectiveSince: 2018,
    privilege: 'Multi-state license in the nurse\'s home state automatically grants practice privilege in every other compact state without separate application',
  },
  {
    id: 'imlc',
    name: 'Interstate Medical Licensure Compact',
    profession: 'Physician',
    memberStates: ['AL', 'AZ', 'CO', 'DC', 'IA', 'IL', 'KS', 'KY', 'LA', 'ME', 'MD', 'MI', 'MN', 'MS', 'MT', 'NE', 'NV', 'NH', 'ND', 'OK', 'PA', 'SD', 'TN', 'UT', 'VT', 'WA', 'WV', 'WI', 'WY', 'VA'],
    effectiveSince: 2017,
    privilege: 'Expedited multi-state licensure — separate license still issued in each state but via a fast-track process once eligibility is verified in the State of Principal License',
  },
  {
    id: 'aswb',
    name: 'ASWB Social Work Licensure Compact',
    profession: 'Social Worker',
    memberStates: ['AL', 'FL', 'GA', 'KS', 'KY', 'MO', 'SC', 'UT', 'VA', 'WA'],
    effectiveSince: 2024,
    privilege: 'Multi-state practice privilege for licensed social workers in compact states',
  },
  {
    id: 'psypact',
    name: 'Psychology Interjurisdictional Compact',
    profession: 'Psychologist',
    memberStates: ['AL', 'AZ', 'AR', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA', 'ID', 'IL', 'IN', 'KS', 'KY', 'ME', 'MD', 'MI', 'MN', 'MS', 'MO', 'NE', 'NV', 'NH', 'NJ', 'NC', 'OH', 'OK', 'PA', 'RI', 'SC', 'TN', 'TX', 'UT', 'VA', 'WA', 'WV', 'WI', 'WY'],
    effectiveSince: 2020,
    privilege: 'Telepsychology + temporary in-person practice across compact states',
  },
  {
    id: 'pt-compact',
    name: 'Physical Therapy Licensure Compact',
    profession: 'Physical Therapist / PT Assistant',
    memberStates: ['AZ', 'CO', 'DE', 'GA', 'IA', 'ID', 'IL', 'IN', 'KS', 'KY', 'LA', 'ME', 'MD', 'MI', 'MO', 'MS', 'MT', 'NH', 'NJ', 'NC', 'ND', 'NV', 'OH', 'OK', 'OR', 'PA', 'SC', 'TN', 'TX', 'UT', 'VA', 'WA', 'WV', 'WY'],
    effectiveSince: 2018,
    privilege: 'Compact privilege to practice in member states without separate license application',
  },
];

export interface PortabilityQuery {
  profession: string;
  sourceState: string;
  targetState: string;
  /** Informational — conditional/suspended flips portability off. */
  licenseStatus: 'ACTIVE' | 'CONDITIONAL' | 'SUSPENDED' | 'TEMPORARY';
}

export interface PortabilityAnalysis {
  outcome: PortabilityOutcome;
  /** Compact or authority controlling the result, if any. */
  compactId: string | null;
  /** Plain-language explanation, suitable for model training data. */
  explanation: string;
  /** Caveats that must appear in the model answer. */
  caveats: string[];
  /** Estimated timeline in days, null if re-application route. */
  estimatedDays: number | null;
}

export function analyzePortability(q: PortabilityQuery): PortabilityAnalysis {
  if (q.licenseStatus === 'SUSPENDED') {
    return {
      outcome: 'FULL_REAPPLICATION',
      compactId: null,
      explanation: 'Suspended licenses do not qualify for compact privileges and cannot be endorsed. The practitioner must resolve the underlying suspension before any portability analysis.',
      caveats: ['suspension resolution is a precondition', 'disclosure obligations in target state'],
      estimatedDays: null,
    };
  }
  if (q.licenseStatus === 'CONDITIONAL' || q.licenseStatus === 'TEMPORARY') {
    return {
      outcome: 'FULL_REAPPLICATION',
      compactId: null,
      explanation: `A ${q.licenseStatus.toLowerCase()} license does not carry compact privileges and typically cannot be endorsed. Target state will treat this as a new application.`,
      caveats: ['status flag must be disclosed', 'target state may require unrestricted license first'],
      estimatedDays: null,
    };
  }

  const compact = INTERSTATE_COMPACTS.find(
    (c) =>
      c.profession.toLowerCase().includes(q.profession.toLowerCase()) &&
      c.memberStates.includes(q.sourceState) &&
      c.memberStates.includes(q.targetState),
  );
  if (compact) {
    return {
      outcome: 'FULL_PORTABILITY',
      compactId: compact.id,
      explanation: `${compact.name} applies: ${compact.privilege}.`,
      caveats: [`must comply with ${q.targetState} practice standards`, `continued eligibility requires unrestricted license in ${q.sourceState}`],
      estimatedDays: 7,
    };
  }

  // Non-compact professions fall into the endorsement / reciprocity / full
  // reapplication bucket. Heuristic: assume endorsement is available for
  // physicians and RNs in non-compact pairings (most states), otherwise
  // full reapplication.
  const loweredProfession = q.profession.toLowerCase();
  const endorsementEligible = ENDORSEMENT_ELIGIBLE_PROFESSIONS.some((p) => loweredProfession.includes(p));
  if (endorsementEligible) {
    return {
      outcome: 'ENDORSEMENT',
      compactId: null,
      explanation: `${q.targetState} accepts endorsement from ${q.sourceState} for this profession. Expect document review, primary-source verification, and application fee (typically $100–$500).`,
      caveats: ['CE/CME gap may disqualify', 'in-person practice only after license issued'],
      estimatedDays: 60,
    };
  }

  return {
    outcome: 'FULL_REAPPLICATION',
    compactId: null,
    explanation: `${q.profession} in ${q.targetState} requires a fresh application. Compact + endorsement routes do not apply.`,
    caveats: ['jurisprudence exam may be required', 'experience minimums apply'],
    estimatedDays: null,
  };
}

/**
 * NTF-05 target: 90%+ portability-determination accuracy on the eval set.
 */
export const NTF05_ACCURACY_TARGET = 0.9;

export interface PortabilityEvalEntry {
  query: PortabilityQuery;
  expectedOutcome: PortabilityOutcome;
}

export function scorePortabilityAccuracy(entries: PortabilityEvalEntry[]): {
  accuracy: number;
  correct: number;
  total: number;
  failing: Array<{ query: PortabilityQuery; expected: PortabilityOutcome; got: PortabilityOutcome }>;
} {
  let correct = 0;
  const failing: Array<{ query: PortabilityQuery; expected: PortabilityOutcome; got: PortabilityOutcome }> = [];
  for (const e of entries) {
    const r = analyzePortability(e.query);
    if (r.outcome === e.expectedOutcome) correct++;
    else failing.push({ query: e.query, expected: e.expectedOutcome, got: r.outcome });
  }
  return {
    accuracy: entries.length === 0 ? 0 : correct / entries.length,
    correct,
    total: entries.length,
    failing,
  };
}
