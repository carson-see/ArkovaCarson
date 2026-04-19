/**
 * NTF-06 (SCRUM-778) — regulatory preemption + conflict analyzer.
 *
 * Deterministic conflict-resolution engine. Given a federal rule, a state
 * rule, and the "floor vs ceiling" preemption posture of the federal
 * statute, this module decides which rule controls. Plays the role the
 * trained model will eventually play — so the eval harness has a
 * reference answer that is defensible in every case.
 */

export type PreemptionPosture = 'FLOOR' | 'CEILING' | 'EXPRESS' | 'FIELD' | 'NONE';

/**
 * FLOOR — federal rule sets a minimum; more-stringent state rules survive.
 * CEILING — federal rule is both floor and ceiling; state cannot exceed.
 * EXPRESS — statute expressly preempts conflicting state law.
 * FIELD — Congress occupied the entire field; no state regulation.
 * NONE — no preemption; coexistence is fine.
 */

export type ConflictOutcome =
  | 'FEDERAL_CONTROLS'
  | 'STATE_CONTROLS'
  | 'BOTH_APPLY'
  | 'STATE_INVALID'
  | 'CONCURRENT_COMPLIANCE';

export interface ConflictQuery {
  /** Short label — "HIPAA §164.524 access right". */
  federalRule: string;
  federalPosture: PreemptionPosture;
  /** Short label — "CA CMIA patient access right (shorter 15-day turnaround)". */
  stateRule: string;
  /** Is the state rule more stringent than the federal rule? */
  stateMoreStringent: boolean;
  /** Is compliance with both simultaneously possible? */
  dualComplianceFeasible: boolean;
}

export interface ConflictAnalysis {
  outcome: ConflictOutcome;
  /** Reasoning chain. */
  reasoning: string[];
  /** Citation anchors the model should emit. */
  citations: string[];
}

export function resolveConflict(q: ConflictQuery): ConflictAnalysis {
  const reasoning: string[] = [];
  const citations: string[] = [];
  reasoning.push(`federal rule: ${q.federalRule} (posture: ${q.federalPosture})`);
  reasoning.push(`state rule: ${q.stateRule} (more stringent: ${q.stateMoreStringent})`);

  if (q.federalPosture === 'FIELD') {
    reasoning.push('Congress occupied the field — state regulation is preempted regardless of stringency');
    return { outcome: 'STATE_INVALID', reasoning, citations };
  }
  if (q.federalPosture === 'EXPRESS') {
    reasoning.push('statute expressly preempts state law in this area');
    return { outcome: q.stateMoreStringent ? 'STATE_INVALID' : 'FEDERAL_CONTROLS', reasoning, citations };
  }
  if (q.federalPosture === 'CEILING') {
    if (q.stateMoreStringent) {
      reasoning.push('state law exceeds the federal ceiling — the state rule is invalid to the extent it exceeds');
      return { outcome: 'STATE_INVALID', reasoning, citations };
    }
    reasoning.push('state law is at or below the federal ceiling — both can apply');
    return { outcome: 'BOTH_APPLY', reasoning, citations };
  }
  if (q.federalPosture === 'FLOOR') {
    if (q.stateMoreStringent && q.dualComplianceFeasible) {
      reasoning.push('floor preemption: state rule is more stringent and dual compliance is feasible — state controls in practice; federal provides the backstop');
      return { outcome: 'STATE_CONTROLS', reasoning, citations };
    }
    if (q.stateMoreStringent && !q.dualComplianceFeasible) {
      reasoning.push('floor preemption: conflict cannot be dual-complied — impossibility preemption applies, federal wins');
      return { outcome: 'FEDERAL_CONTROLS', reasoning, citations };
    }
    reasoning.push('state rule is at or below the federal floor — federal minimum controls');
    return { outcome: 'FEDERAL_CONTROLS', reasoning, citations };
  }
  // NONE
  reasoning.push('no preemption identified — both rules apply; comply concurrently');
  return { outcome: 'CONCURRENT_COMPLIANCE', reasoning, citations };
}

/**
 * NTF-06 target: 85%+ correct conflict resolution across the eval set.
 */
export const NTF06_ACCURACY_TARGET = 0.85;

export interface ConflictEvalEntry {
  query: ConflictQuery;
  expectedOutcome: ConflictOutcome;
}

export function scoreConflictAccuracy(entries: ConflictEvalEntry[]): {
  accuracy: number;
  correct: number;
  total: number;
  byOutcome: Record<ConflictOutcome, { n: number; correct: number }>;
} {
  const byOutcome: Record<ConflictOutcome, { n: number; correct: number }> = {
    FEDERAL_CONTROLS: { n: 0, correct: 0 },
    STATE_CONTROLS: { n: 0, correct: 0 },
    BOTH_APPLY: { n: 0, correct: 0 },
    STATE_INVALID: { n: 0, correct: 0 },
    CONCURRENT_COMPLIANCE: { n: 0, correct: 0 },
  };
  let correct = 0;
  for (const e of entries) {
    const r = resolveConflict(e.query);
    byOutcome[e.expectedOutcome].n++;
    if (r.outcome === e.expectedOutcome) {
      correct++;
      byOutcome[e.expectedOutcome].correct++;
    }
  }
  return {
    accuracy: entries.length === 0 ? 0 : correct / entries.length,
    correct,
    total: entries.length,
    byOutcome,
  };
}
