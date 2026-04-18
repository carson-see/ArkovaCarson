/**
 * Org-level Compliance Audit (NCA-03)
 *
 * Aggregates per-(jurisdiction, industry) scoring + gap detection into a
 * single org-level audit result. Built on top of the existing
 * score-calculator (NCE-07) and gap-detector (NCE-08) — the novelty here
 * is multi-jurisdiction rollup, NVI quarantine surfacing, and a stable
 * result shape for the compliance_audits table + scorecard UI.
 *
 * Jira: SCRUM-758 (NCA-03)
 */

import {
  calculateComplianceScore,
  computeGrade,
  type JurisdictionRule,
  type OrgAnchor,
  type ComplianceScoreResult,
} from './score-calculator.js';
import {
  getQuarantineStatus,
  type QuarantineEntry,
} from '../ai/nessie-quarantine.js';
import {
  buildRecommendations,
  type BuildRecommendationsResult,
} from './recommendation-engine.js';

export interface JurisdictionPair {
  jurisdiction_code: string;
  industry_code: string;
}

export interface OrgAuditInput {
  orgId: string;
  /** Every (jurisdiction, industry) tuple the org is registered in. */
  jurisdictions: JurisdictionPair[];
  /** All jurisdiction_rules rows for the jurisdictions above. */
  rules: JurisdictionRule[];
  /** Every SECURED anchor belonging to the org. */
  anchors: OrgAnchor[];
  /** Regulations whose intelligence models are in use for recommendations. */
  activeRegulations?: Array<{ regulation: string; version: string }>;
}

export type GapCategory =
  | 'MISSING'
  | 'EXPIRED'
  | 'EXPIRING_SOON'
  | 'INSUFFICIENT';

export interface AuditGap {
  type: string;
  category: GapCategory;
  requirement: string;
  jurisdiction_code: string;
  industry_code: string;
  regulatory_reference: string | null;
  severity: 'critical' | 'high' | 'medium' | 'low';
  remediation_hint: string;
  days_remaining?: number;
  anchor_id?: string;
}

export interface PerJurisdictionResult {
  jurisdiction_code: string;
  industry_code: string;
  score: number;
  grade: string;
  total_required: number;
  total_present: number;
  rule_count: number;
}

export interface AuditQuarantineCaveat {
  regulation: string;
  version: string;
  status: QuarantineEntry['status'];
  caveat: string;
  tracking: string;
}

export interface OrgAuditResult {
  overall_score: number;
  overall_grade: string;
  per_jurisdiction: PerJurisdictionResult[];
  gaps: AuditGap[];
  quarantines: AuditQuarantineCaveat[];
  /** NCA-05 prioritised recommendations derived from gaps. */
  recommendations: BuildRecommendationsResult;
}

/** Severity weights per credential type — informs gap severity labels. */
const SEVERITY_BY_TYPE: Record<string, AuditGap['severity']> = {
  LICENSE: 'critical',
  PROFESSIONAL: 'critical',
  ATTESTATION: 'high',
  CERTIFICATE: 'high',
  CONTINUING_EDUCATION: 'medium',
  DEGREE: 'medium',
  TRANSCRIPT: 'low',
  OTHER: 'low',
};

function severityFor(type: string): AuditGap['severity'] {
  return SEVERITY_BY_TYPE[type] ?? 'medium';
}

function remediationHint(type: string): string {
  switch (type) {
    case 'LICENSE': return 'Upload the current professional license issued by the regulating board.';
    case 'PROFESSIONAL': return 'Add the relevant professional credential + issuing body.';
    case 'CONTINUING_EDUCATION': return 'Record the CE/CLE cycle completion with provider + hours.';
    case 'CERTIFICATE': return 'Provide the industry-specific certificate (e.g. BLS, CORI attestation).';
    case 'ATTESTATION': return 'Attach an attestation document signed by an authorized person.';
    case 'DEGREE': return 'Upload the academic transcript or degree certificate.';
    case 'TRANSCRIPT': return 'Upload an official transcript.';
    default: return `Upload a document of type ${type}.`;
  }
}

function groupRulesByJurisdiction(
  rules: JurisdictionRule[],
): Map<string, JurisdictionRule[]> {
  const map = new Map<string, JurisdictionRule[]>();
  for (const r of rules) {
    const key = `${r.jurisdiction_code}::${r.industry_code}`;
    const bucket = map.get(key) ?? [];
    bucket.push(r);
    map.set(key, bucket);
  }
  return map;
}

function anchorsByType(anchors: OrgAnchor[]): Map<string, OrgAnchor> {
  const map = new Map<string, OrgAnchor>();
  for (const a of anchors) {
    if (a.status !== 'SECURED') continue;
    if (!map.has(a.credential_type)) map.set(a.credential_type, a);
  }
  return map;
}

export function calculateOrgAudit(input: OrgAuditInput): OrgAuditResult {
  const rulesByPair = groupRulesByJurisdiction(input.rules);
  const perJurisdiction: PerJurisdictionResult[] = [];
  const gaps: AuditGap[] = [];

  // Per-jurisdiction scoring.
  let weightedScoreSum = 0;
  let weightSum = 0;
  for (const pair of input.jurisdictions) {
    const key = `${pair.jurisdiction_code}::${pair.industry_code}`;
    const pairRules = rulesByPair.get(key) ?? [];
    if (pairRules.length === 0) {
      // No rules = nothing to score; skip but record.
      perJurisdiction.push({
        jurisdiction_code: pair.jurisdiction_code,
        industry_code: pair.industry_code,
        score: 100,
        grade: 'A',
        total_required: 0,
        total_present: 0,
        rule_count: 0,
      });
      continue;
    }
    const result: ComplianceScoreResult = calculateComplianceScore({
      rules: pairRules,
      anchors: input.anchors,
    });
    perJurisdiction.push({
      jurisdiction_code: pair.jurisdiction_code,
      industry_code: pair.industry_code,
      score: result.score,
      grade: result.grade,
      total_required: result.total_required,
      total_present: result.total_present,
      rule_count: pairRules.length,
    });
    // Weight each jurisdiction by its requirement count so a single-rule
    // jurisdiction doesn't outweigh a 50-rule jurisdiction in the overall.
    const weight = Math.max(1, result.total_required);
    weightedScoreSum += result.score * weight;
    weightSum += weight;

    // Emit gaps for this jurisdiction.
    for (const miss of result.missing_documents) {
      gaps.push({
        type: miss.type,
        category: 'MISSING',
        requirement: miss.requirement,
        jurisdiction_code: pair.jurisdiction_code,
        industry_code: pair.industry_code,
        regulatory_reference: miss.regulatory_reference,
        severity: severityFor(miss.type),
        remediation_hint: remediationHint(miss.type),
      });
    }
    for (const exp of result.expiring_documents) {
      gaps.push({
        type: exp.type,
        category: 'EXPIRING_SOON',
        requirement: `Renew ${exp.type}`,
        jurisdiction_code: pair.jurisdiction_code,
        industry_code: pair.industry_code,
        regulatory_reference: null,
        severity: exp.days_remaining <= 30 ? 'high' : 'medium',
        remediation_hint: remediationHint(exp.type),
        days_remaining: exp.days_remaining,
        anchor_id: exp.anchor_id,
      });
    }
  }

  // Detect EXPIRED: present anchors whose expiry is in the past.
  const now = Date.now();
  const typeMap = anchorsByType(input.anchors);
  for (const [type, anchor] of typeMap) {
    if (!anchor.expiry_date) continue;
    const days = Math.ceil((new Date(anchor.expiry_date).getTime() - now) / 86_400_000);
    if (days <= 0) {
      gaps.push({
        type,
        category: 'EXPIRED',
        requirement: `Renew expired ${type}`,
        // Expired credentials are not jurisdiction-specific — attribute to
        // the first jurisdiction where the type is required.
        jurisdiction_code: input.jurisdictions[0]?.jurisdiction_code ?? 'unknown',
        industry_code: input.jurisdictions[0]?.industry_code ?? 'unknown',
        regulatory_reference: null,
        severity: severityFor(type) === 'low' ? 'medium' : severityFor(type),
        remediation_hint: remediationHint(type),
        days_remaining: days,
        anchor_id: anchor.id,
      });
    }
  }

  // Detect INSUFFICIENT: anchor has fraud flags.
  for (const a of input.anchors) {
    if (a.status !== 'SECURED') continue;
    if (!a.fraud_flags?.length) continue;
    gaps.push({
      type: a.credential_type,
      category: 'INSUFFICIENT',
      requirement: `Re-verify ${a.credential_type} (fraud flags raised)`,
      jurisdiction_code: input.jurisdictions[0]?.jurisdiction_code ?? 'unknown',
      industry_code: input.jurisdictions[0]?.industry_code ?? 'unknown',
      regulatory_reference: null,
      severity: 'critical',
      remediation_hint: `Fraud flags: ${a.fraud_flags.join(', ')}. Replace with a clean re-verification.`,
      anchor_id: a.id,
    });
  }

  // Quarantine caveats for the regulations used.
  const quarantines: AuditQuarantineCaveat[] = [];
  for (const r of input.activeRegulations ?? []) {
    const entry = getQuarantineStatus(r.regulation, r.version);
    if (entry.status === 'CLEAR') continue;
    quarantines.push({
      regulation: entry.regulation,
      version: entry.version,
      status: entry.status,
      caveat: entry.caveat,
      tracking: entry.tracking,
    });
  }

  const overall = weightSum > 0 ? Math.round(weightedScoreSum / weightSum) : 100;
  // Sort gaps: critical first, then by severity, then EXPIRED before MISSING before others.
  const severityOrder: Record<AuditGap['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const categoryOrder: Record<GapCategory, number> = { EXPIRED: 0, INSUFFICIENT: 1, MISSING: 2, EXPIRING_SOON: 3 };
  gaps.sort((a, b) => {
    const sev = severityOrder[a.severity] - severityOrder[b.severity];
    if (sev !== 0) return sev;
    return categoryOrder[a.category] - categoryOrder[b.category];
  });

  const recommendations = buildRecommendations({
    gaps,
    // Penalty risk is informed by the overall severity of each jurisdiction's
    // regulator. Values >1 push a jurisdiction up the priority order.
    jurisdictionPenaltyRisk: JURISDICTION_PENALTY_RISK,
  });

  return {
    overall_score: overall,
    overall_grade: computeGrade(overall),
    per_jurisdiction: perJurisdiction,
    gaps,
    quarantines,
    recommendations,
  };
}

/**
 * Relative penalty risk per jurisdiction — informs NCA-05 recommendation
 * priority. Higher = harsher regulator / larger fines. Keep in sync with
 * `docs/confluence/12_identity_access.md` when tuning.
 */
const JURISDICTION_PENALTY_RISK: Record<string, number> = {
  // US federal
  'US-FEDERAL': 1.8,
  'US-CA': 1.5,
  'US-NY': 1.5,
  'US-TX': 1.2,
  // EU
  'EU': 2.0,
  'UK': 1.6,
  // International high-risk
  'SG': 1.6,
  'AU': 1.4,
  'CA': 1.3,
  'BR': 1.5,
  'ZA': 1.2,
  // Intl tier 2 (introduced 2026-04-17)
  'CO': 1.1,
  'TH': 1.3,
  'MY': 1.3,
};
