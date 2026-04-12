/**
 * Compliance Score Calculator (NCE-07)
 *
 * Calculates a 0-100 compliance score by comparing an org's SECURED anchors
 * against jurisdiction rule requirements. Produces grade, missing documents,
 * expiring documents, and present documents breakdown.
 *
 * Jira: SCRUM-597
 */

export interface JurisdictionRule {
  id: string;
  jurisdiction_code: string;
  industry_code: string;
  rule_name: string;
  required_credential_types: string[];
  optional_credential_types: string[];
  regulatory_reference: string | null;
  details: Record<string, unknown>;
}

export interface OrgAnchor {
  id: string;
  credential_type: string;
  status: string;
  integrity_score: number | null;
  fraud_flags: string[];
  expiry_date: string | null;
  title: string | null;
}

export interface ComplianceScoreInput {
  rules: JurisdictionRule[];
  anchors: OrgAnchor[];
}

export interface PresentDocument {
  type: string;
  anchor_id: string;
  status: string;
  title: string | null;
  integrity_score: number | null;
  expiry_date: string | null;
}

export interface MissingDocument {
  type: string;
  requirement: string;
  regulatory_reference: string | null;
  score_impact: number;
}

export interface ExpiringDocument {
  type: string;
  anchor_id: string;
  title: string | null;
  expiry_date: string;
  days_remaining: number;
}

export interface ComplianceScoreResult {
  score: number;
  grade: string;
  present_documents: PresentDocument[];
  missing_documents: MissingDocument[];
  expiring_documents: ExpiringDocument[];
  total_required: number;
  total_present: number;
}

/** Weight by credential type importance */
const TYPE_WEIGHTS: Record<string, number> = {
  LICENSE: 30,
  PROFESSIONAL: 25,
  DEGREE: 20,
  CERTIFICATE: 15,
  CONTINUING_EDUCATION: 15,
  TRANSCRIPT: 10,
  OTHER: 10,
};

const INTEGRITY_BONUS_THRESHOLD = 0.85;
const INTEGRITY_BONUS_POINTS = 5;
const EXPIRED_PENALTY = 10;
const FRAUD_FLAG_PENALTY = 15;

export function computeGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export function calculateComplianceScore(input: ComplianceScoreInput): ComplianceScoreResult {
  const { rules, anchors } = input;

  // Collect all required credential types across rules
  const allRequired = new Set<string>();
  for (const rule of rules) {
    for (const type of rule.required_credential_types) {
      allRequired.add(type);
    }
  }

  // If no requirements, org is fully compliant
  if (allRequired.size === 0) {
    return {
      score: 100,
      grade: 'A',
      present_documents: [],
      missing_documents: [],
      expiring_documents: [],
      total_required: 0,
      total_present: 0,
    };
  }

  // Build anchor lookup by credential type (best anchor per type)
  const anchorByType = new Map<string, OrgAnchor>();
  for (const anchor of anchors) {
    if (anchor.status !== 'SECURED') continue;
    const existing = anchorByType.get(anchor.credential_type);
    if (!existing) {
      anchorByType.set(anchor.credential_type, anchor);
    }
  }

  const now = Date.now();
  const present: PresentDocument[] = [];
  const missing: MissingDocument[] = [];
  const expiring: ExpiringDocument[] = [];

  let totalWeightedPoints = 0;
  let earnedWeightedPoints = 0;
  let bonusPoints = 0;
  let penaltyPoints = 0;

  for (const type of allRequired) {
    const weight = TYPE_WEIGHTS[type] ?? TYPE_WEIGHTS.OTHER;
    totalWeightedPoints += weight;

    const anchor = anchorByType.get(type);
    if (!anchor) {
      // Find the rule referencing this type for the regulatory citation
      const ruleRef = rules.find(r => r.required_credential_types.includes(type));
      missing.push({
        type,
        requirement: `Required: ${type}`,
        regulatory_reference: ruleRef?.regulatory_reference ?? null,
        score_impact: Math.round((weight / totalWeightedPoints) * 100),
      });
      continue;
    }

    // Document is present
    earnedWeightedPoints += weight;

    present.push({
      type,
      anchor_id: anchor.id,
      status: anchor.status,
      title: anchor.title,
      integrity_score: anchor.integrity_score,
      expiry_date: anchor.expiry_date,
    });

    // Bonus for high integrity
    if (anchor.integrity_score != null && anchor.integrity_score > INTEGRITY_BONUS_THRESHOLD) {
      bonusPoints += INTEGRITY_BONUS_POINTS;
    }

    // Penalty for expired documents
    if (anchor.expiry_date) {
      const expiryTime = new Date(anchor.expiry_date).getTime();
      const daysRemaining = Math.ceil((expiryTime - now) / 86_400_000);

      if (daysRemaining <= 0) {
        penaltyPoints += EXPIRED_PENALTY;
      }

      if (daysRemaining > 0 && daysRemaining <= 90) {
        expiring.push({
          type,
          anchor_id: anchor.id,
          title: anchor.title,
          expiry_date: anchor.expiry_date,
          days_remaining: daysRemaining,
        });
      }
    }

    // Penalty for fraud flags
    if (anchor.fraud_flags && anchor.fraud_flags.length > 0) {
      penaltyPoints += FRAUD_FLAG_PENALTY;
    }
  }

  // Calculate raw score as percentage of weighted points earned
  const baseScore = totalWeightedPoints > 0
    ? (earnedWeightedPoints / totalWeightedPoints) * 100
    : 100;

  // Penalties reduce from base score; bonus only applies to base (never exceeds 100)
  const rawScore = Math.min(baseScore, 100) - penaltyPoints + Math.min(bonusPoints, 100 - baseScore);
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  // Recalculate score_impact for missing docs now that we know totals
  for (const doc of missing) {
    const weight = TYPE_WEIGHTS[doc.type] ?? TYPE_WEIGHTS.OTHER;
    doc.score_impact = totalWeightedPoints > 0
      ? Math.round((weight / totalWeightedPoints) * 100)
      : 0;
  }

  return {
    score,
    grade: computeGrade(score),
    present_documents: present,
    missing_documents: missing,
    expiring_documents: expiring,
    total_required: allRequired.size,
    total_present: present.length,
  };
}
