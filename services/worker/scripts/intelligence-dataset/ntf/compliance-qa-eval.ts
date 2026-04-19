/**
 * NTF-03 (SCRUM-775) — FERPA/HIPAA/SOX compliance-Q&A eval harness.
 *
 * Structured scoring for compliance Q&A that lives above the
 * extraction-focused FCRA/HIPAA/FERPA_EVAL_50 harnesses. Each entry asks
 * one scenario and scores the model answer against expected key points,
 * expected risks, and minimum confidence. Separate track from canonical
 * citation scoring so a compliance-Q&A deployment can ship without
 * blocking on citation accuracy.
 *
 * Dataset split across five regulatory domains to match the 37 compliance
 * Q&A training examples referenced in the Jira story (Together job
 * ft-2481de56-cf03):
 *   - FERPA (10 examples)
 *   - HIPAA (10 examples)
 *   - Fraud-pattern identification (10 examples)
 *   - SOX / financial (3 examples)
 *   - International (4 examples)
 */

export type ComplianceQaDomain = 'ferpa' | 'hipaa' | 'fraud' | 'sox' | 'international';

export interface ComplianceQaEntry {
  id: string;
  domain: ComplianceQaDomain;
  query: string;
  /** At least one of these phrases should appear in the model answer. */
  expectedKeyPoints: string[];
  /** The model must surface each risk (phrase-match, token-overlap tolerant). */
  expectedRisks: string[];
  /** Minimum confidence the model should emit for this question. */
  minConfidence: number;
}

export interface ComplianceQaResult {
  id: string;
  keyPointsHit: number;
  keyPointsTotal: number;
  risksHit: number;
  risksTotal: number;
  confidenceOk: boolean;
  /** 0-1, combined score used to rank entries in the report. */
  combined: number;
}

export interface ComplianceQaReport {
  entriesScored: number;
  meanKeyPointRecall: number;
  meanRiskRecall: number;
  confidenceOkRate: number;
  byDomain: Record<ComplianceQaDomain, { n: number; keyPoint: number; risk: number }>;
  failing: ComplianceQaResult[];
}

export const COMPLIANCE_QA_SEED: ComplianceQaEntry[] = [
  // FERPA
  {
    id: 'qa-ferpa-parental-access-after-18',
    domain: 'ferpa',
    query: 'A parent of an 18-year-old college student asks for their transcript. Can the university release it?',
    expectedKeyPoints: ['eligible student', '§99.5', 'transferred to the student', 'parental access', 'dependent for tax'],
    expectedRisks: ['unauthorized disclosure under §99.31', 'loss of federal funds'],
    minConfidence: 0.8,
  },
  {
    id: 'qa-ferpa-law-enforcement-subpoena',
    domain: 'ferpa',
    query: 'A grand jury subpoena seeks student disciplinary records. What must the university do?',
    expectedKeyPoints: ['§99.31(a)(9)', 'lawfully issued subpoena', 'reasonable effort to notify', 'disclosure log'],
    expectedRisks: ['disclosure without subpoena authority is FERPA violation', 'notification requirement'],
    minConfidence: 0.78,
  },
  // HIPAA
  {
    id: 'qa-hipaa-tpo-exception',
    domain: 'hipaa',
    query: 'Can a physician share PHI with a specialist for a referral without a separate authorization?',
    expectedKeyPoints: ['§164.506', 'treatment, payment, operations', 'TPO', 'no authorization required'],
    expectedRisks: ['non-TPO disclosures require authorization', 'minimum necessary still applies'],
    minConfidence: 0.85,
  },
  {
    id: 'qa-hipaa-minimum-necessary',
    domain: 'hipaa',
    query: 'A billing department asks for the full chart when only the diagnosis and dates are needed. Is this compliant?',
    expectedKeyPoints: ['§164.502(b)', 'minimum necessary', 'role-based access', 'policy documentation'],
    expectedRisks: ['over-disclosure of PHI', 'OCR enforcement exposure'],
    minConfidence: 0.82,
  },
  // Fraud
  {
    id: 'qa-fraud-diploma-mill',
    domain: 'fraud',
    query: 'An applicant\'s degree shows a university closed before the conferral date. How should this be classified?',
    expectedKeyPoints: ['diploma mill', 'institution closure date', 'IPEDS', 'fabricated credential'],
    expectedRisks: ['fraudulent credential', 'adverse action exposure', 'duty to verify'],
    minConfidence: 0.9,
  },
  {
    id: 'qa-fraud-npi-mismatch',
    domain: 'fraud',
    query: 'A physician\'s resume claims cardiology, but NPPES lists general internal medicine. What does this signal?',
    expectedKeyPoints: ['NPI registry', 'specialty mismatch', 'NPPES', 'cross-reference'],
    expectedRisks: ['specialty misrepresentation', 'credential inflation'],
    minConfidence: 0.85,
  },
  // SOX / financial
  {
    id: 'qa-sox-segregation-of-duties',
    domain: 'sox',
    query: 'A single employee both approves and initiates vendor payments. What control finding applies?',
    expectedKeyPoints: ['segregation of duties', 'SOX §404', 'material weakness', 'compensating control'],
    expectedRisks: ['fraud risk', 'material weakness disclosure', 'Section 302 certification exposure'],
    minConfidence: 0.82,
  },
  // International
  {
    id: 'qa-intl-kenya-dpa-cross-border',
    domain: 'international',
    query: 'A Kenyan bank wants to send customer data to a US processor. What does KDPA require?',
    expectedKeyPoints: ['KDPA §48', 'cross-border transfer', 'ODPC', 'adequacy', 'explicit consent'],
    expectedRisks: ['unauthorized transfer', 'KDPA §63 penalty', '1% of turnover'],
    minConfidence: 0.8,
  },
  {
    id: 'qa-intl-popia-consent',
    domain: 'international',
    query: 'A South African employer wants to run background checks. What POPIA obligations attach?',
    expectedKeyPoints: ['POPIA §11', 'consent', 'Information Regulator', 'special personal info', 'purpose limitation'],
    expectedRisks: ['unlawful processing', 'Section 107 penalty'],
    minConfidence: 0.8,
  },
];

export interface ComplianceQaAnswerCandidate {
  id: string;
  /** Full answer text the model returned. */
  text: string;
  /** The confidence the model emitted. */
  confidence: number;
  /** Risks array the model emitted. */
  risks: string[];
}

export function scoreComplianceQaEntry(entry: ComplianceQaEntry, answer: ComplianceQaAnswerCandidate): ComplianceQaResult {
  const lowered = answer.text.toLowerCase();
  const keyPointsHit = entry.expectedKeyPoints.filter((k) => lowered.includes(k.toLowerCase())).length;
  const keyPointsTotal = entry.expectedKeyPoints.length;
  const risksHit = entry.expectedRisks.filter((r) => {
    const rl = r.toLowerCase();
    if (answer.risks.some((x) => x.toLowerCase().includes(rl))) return true;
    return lowered.includes(rl);
  }).length;
  const risksTotal = entry.expectedRisks.length;
  const confidenceOk = answer.confidence >= entry.minConfidence;
  const kp = keyPointsTotal === 0 ? 1 : keyPointsHit / keyPointsTotal;
  const rp = risksTotal === 0 ? 1 : risksHit / risksTotal;
  const combined = (kp + rp + (confidenceOk ? 1 : 0)) / 3;
  return { id: entry.id, keyPointsHit, keyPointsTotal, risksHit, risksTotal, confidenceOk, combined };
}

export function buildComplianceQaReport(results: ComplianceQaResult[], entries: ComplianceQaEntry[]): ComplianceQaReport {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const byDomain: Record<ComplianceQaDomain, { n: number; keyPoint: number; risk: number }> = {
    ferpa: { n: 0, keyPoint: 0, risk: 0 },
    hipaa: { n: 0, keyPoint: 0, risk: 0 },
    fraud: { n: 0, keyPoint: 0, risk: 0 },
    sox: { n: 0, keyPoint: 0, risk: 0 },
    international: { n: 0, keyPoint: 0, risk: 0 },
  };
  let kpSum = 0;
  let riskSum = 0;
  let confOk = 0;
  for (const r of results) {
    const e = byId.get(r.id);
    if (!e) continue;
    byDomain[e.domain].n++;
    const kp = r.keyPointsTotal === 0 ? 1 : r.keyPointsHit / r.keyPointsTotal;
    const rp = r.risksTotal === 0 ? 1 : r.risksHit / r.risksTotal;
    byDomain[e.domain].keyPoint += kp;
    byDomain[e.domain].risk += rp;
    kpSum += kp;
    riskSum += rp;
    if (r.confidenceOk) confOk++;
  }
  for (const d of Object.keys(byDomain) as ComplianceQaDomain[]) {
    const n = byDomain[d].n;
    if (n > 0) {
      byDomain[d].keyPoint /= n;
      byDomain[d].risk /= n;
    }
  }
  return {
    entriesScored: results.length,
    meanKeyPointRecall: results.length === 0 ? 0 : kpSum / results.length,
    meanRiskRecall: results.length === 0 ? 0 : riskSum / results.length,
    confidenceOkRate: results.length === 0 ? 0 : confOk / results.length,
    byDomain,
    failing: results.filter((r) => r.combined < 0.7),
  };
}
