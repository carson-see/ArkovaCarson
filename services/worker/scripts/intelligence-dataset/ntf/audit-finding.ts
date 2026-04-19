/**
 * NTF-07 (SCRUM-779) — audit finding template + severity classifier.
 *
 * Structured output template that matches the format internal auditors
 * already use (condition / criteria / cause / effect / recommendation).
 * Nessie must produce these components per finding; this module both
 * validates a candidate finding and classifies its severity per COSO /
 * PCAOB terminology.
 */

export type FindingSeverity = 'CONTROL_DEFICIENCY' | 'SIGNIFICANT_DEFICIENCY' | 'MATERIAL_WEAKNESS';

export type FindingFramework = 'SOX' | 'SOC2' | 'HIPAA' | 'STATE_LICENSE' | 'PCAOB';

export interface AuditFinding {
  id: string;
  framework: FindingFramework;
  /** What the control was supposed to achieve. */
  controlObjective: string;
  /** What actually happened — the factual observation. */
  condition: string;
  /** The standard or rule the condition is measured against. */
  criteria: string;
  /** Why it happened — root cause. */
  cause: string;
  /** The impact — regulatory, operational, or financial. */
  effect: string;
  /** Actionable step ordered by priority. */
  recommendations: string[];
  /** Numeric dollar or rate exposure, if estimable. */
  quantifiedExposureUsd?: number;
  /** Severity decided per the framework. */
  severity: FindingSeverity;
  /** Priority label used when ordering remediation. */
  priority: 1 | 2 | 3;
}

/**
 * NTF-07 requirement: all six finding components must be present + non-empty.
 * Returns a list of missing component names; empty list = valid.
 */
export function validateFindingStructure(f: Partial<AuditFinding>): string[] {
  const missing: string[] = [];
  if (!f.controlObjective) missing.push('controlObjective');
  if (!f.condition) missing.push('condition');
  if (!f.criteria) missing.push('criteria');
  if (!f.cause) missing.push('cause');
  if (!f.effect) missing.push('effect');
  if (!f.recommendations || f.recommendations.length === 0) missing.push('recommendations');
  return missing;
}

export interface SeverityInput {
  framework: FindingFramework;
  /** Does the deficiency touch financial statements or material accounts? */
  financialStatementImpact: boolean;
  /** Is there at least one compensating control? */
  compensatingControl: boolean;
  /** Has the deficiency been detected in prior audits without remediation? */
  recurring: boolean;
  /** Quantified exposure — used against materiality thresholds. */
  exposureUsd?: number;
  /** Materiality threshold for this engagement. */
  materialityUsd?: number;
}

/**
 * PCAOB AS 2201 + COSO framework-aligned severity classifier.
 *
 * A material weakness requires a reasonable possibility that a material
 * misstatement will not be prevented or detected. A significant
 * deficiency is less severe but still important enough to merit
 * attention. Anything else is a control deficiency.
 */
export function classifySeverity(input: SeverityInput): FindingSeverity {
  if (input.financialStatementImpact && exceedsMateriality(input)) {
    if (!input.compensatingControl || input.recurring) return 'MATERIAL_WEAKNESS';
    return 'SIGNIFICANT_DEFICIENCY';
  }
  if (input.financialStatementImpact) {
    if (input.recurring && !input.compensatingControl) return 'SIGNIFICANT_DEFICIENCY';
    return 'CONTROL_DEFICIENCY';
  }
  if (input.recurring && !input.compensatingControl) return 'SIGNIFICANT_DEFICIENCY';
  return 'CONTROL_DEFICIENCY';
}

function exceedsMateriality(input: SeverityInput): boolean {
  if (input.exposureUsd === undefined || input.materialityUsd === undefined) return false;
  return input.exposureUsd >= input.materialityUsd;
}

/**
 * Convert severity to a 1-3 priority ranking the UI can sort by. Priority
 * 1 = fix immediately, 3 = backlog.
 */
export function priorityForSeverity(severity: FindingSeverity): 1 | 2 | 3 {
  switch (severity) {
    case 'MATERIAL_WEAKNESS': return 1;
    case 'SIGNIFICANT_DEFICIENCY': return 2;
    case 'CONTROL_DEFICIENCY': return 3;
  }
}

/**
 * Render finding in Markdown — the shape an auditor can paste into a
 * workpaper without reformatting.
 */
export function renderFinding(f: AuditFinding): string {
  const lines: string[] = [];
  lines.push(`# ${f.id} — ${f.framework} ${f.severity} (priority ${f.priority})`);
  lines.push('');
  lines.push(`**Control objective:** ${f.controlObjective}`);
  lines.push('');
  lines.push(`**Condition:** ${f.condition}`);
  lines.push('');
  lines.push(`**Criteria:** ${f.criteria}`);
  lines.push('');
  lines.push(`**Cause:** ${f.cause}`);
  lines.push('');
  lines.push(`**Effect:** ${f.effect}`);
  if (f.quantifiedExposureUsd !== undefined) {
    lines.push('');
    lines.push(`**Quantified exposure:** $${f.quantifiedExposureUsd.toLocaleString()}`);
  }
  lines.push('');
  lines.push('**Recommendations:**');
  for (const r of f.recommendations) lines.push(`- ${r}`);
  return lines.join('\n');
}

/**
 * NTF-07 target: complete (all-component) findings on ≥85% of eval cases,
 * correct severity classification on ≥80%.
 */
export const NTF07_COMPLETENESS_TARGET = 0.85;
export const NTF07_SEVERITY_TARGET = 0.8;

export interface FindingEvalEntry {
  finding: AuditFinding;
  /** Severity the expert reviewer assigned — the ground truth. */
  expectedSeverity: FindingSeverity;
  /** Severity inputs the candidate had access to. */
  severityInput: SeverityInput;
}

export interface FindingEvalReport {
  completenessRate: number;
  severityAccuracy: number;
  total: number;
  missingComponents: Array<{ id: string; missing: string[] }>;
  severityMismatches: Array<{ id: string; expected: FindingSeverity; got: FindingSeverity }>;
}

export function scoreFindings(entries: FindingEvalEntry[]): FindingEvalReport {
  const missing: Array<{ id: string; missing: string[] }> = [];
  const severity: Array<{ id: string; expected: FindingSeverity; got: FindingSeverity }> = [];
  let complete = 0;
  let severityCorrect = 0;
  for (const e of entries) {
    const m = validateFindingStructure(e.finding);
    if (m.length === 0) complete++;
    else missing.push({ id: e.finding.id, missing: m });
    const got = classifySeverity(e.severityInput);
    if (got === e.expectedSeverity) severityCorrect++;
    else severity.push({ id: e.finding.id, expected: e.expectedSeverity, got });
  }
  return {
    completenessRate: entries.length === 0 ? 0 : complete / entries.length,
    severityAccuracy: entries.length === 0 ? 0 : severityCorrect / entries.length,
    total: entries.length,
    missingComponents: missing,
    severityMismatches: severity,
  };
}
