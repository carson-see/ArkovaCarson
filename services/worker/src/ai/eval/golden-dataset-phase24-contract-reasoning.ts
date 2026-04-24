/**
 * Golden Dataset Phase 24 - Contract Reasoning (SCRUM-861)
 *
 * Synthetic, PII-stripped reasoning entries for GME10.3. Each entry carries a
 * risk-flag rationale, concerns, and recommendation URLs constrained to the
 * contract recommendation registry.
 *
 * ID allocation:
 *   GD-5100..5699 = contract reasoning corpus
 */

import { CONTRACT_RECOMMENDATION_URL_REGISTRY } from './contract-recommendation-registry.js';
import type { GoldenDatasetEntry, GroundTruthFields } from './types.js';

export const CONTRACT_REASONING_CATEGORY_COUNTS = {
  auto_renewal: 120,
  unusual_clause: 100,
  missing_clause: 80,
  cross_document_reference: 60,
  party_authority: 60,
  jurisdictional_unenforceability: 60,
  template_deviation: 40,
  recommendation_chain: 40,
  regulatory_gap: 40,
} as const;

export const CONTRACT_REASONING_HUMAN_REVIEW_SAMPLE_SIZE = 120;

type ReasoningType = keyof typeof CONTRACT_REASONING_CATEGORY_COUNTS;

interface ReasoningProfile {
  key: ReasoningType;
  label: string;
  contractTypes: string[];
  riskFlags: string[];
  concerns: string[];
  registryIds: string[];
  issueTemplate: string;
  recommendation: string;
}

const REGISTRY_BY_ID = new Map(CONTRACT_RECOMMENDATION_URL_REGISTRY.map(entry => [entry.id, entry]));

const REASONING_PROFILES: ReasoningProfile[] = [
  {
    key: 'auto_renewal',
    label: 'Auto-renewal notice analysis',
    contractTypes: ['subscription_agreement', 'software_license', 'master_services_agreement'],
    riskFlags: ['short_nonrenewal_window', 'renewal_fee_escalation', 'notice_method_unclear'],
    concerns: ['Renewal notice deadline is shorter than operational approval cycles.', 'Fee escalation language is not tied to an objective cap.'],
    registryIds: ['state_contract_law_ca', 'state_contract_law_ny'],
    issueTemplate: 'The renewal clause renews automatically unless [PARTY_A_REDACTED] gives notice by a compressed deadline, while the fee schedule permits an uplift at renewal.',
    recommendation: 'Normalize the non-renewal deadline, require written reminder notice before renewal, and cap any renewal uplift in the order form.',
  },
  {
    key: 'unusual_clause',
    label: 'Unusual clause detection',
    contractTypes: ['employment_agreement', 'contractor_consultant', 'settlement_agreement'],
    riskFlags: ['nonstandard_remedy', 'overbroad_restrictive_covenant', 'one_sided_discretion'],
    concerns: ['Clause grants one party unilateral discretion without objective criteria.', 'Remedy language may be broader than the commercial risk justifies.'],
    registryIds: ['dol_independent_contractor', 'adr_commercial_rules', 'state_contract_law_ny'],
    issueTemplate: 'The draft includes a clause allowing [PARTY_A_REDACTED] to withhold all compensation for any perceived cooperation failure without cure rights.',
    recommendation: 'Route to legal review, add objective cure standards, and narrow remedies to direct losses tied to the breach.',
  },
  {
    key: 'missing_clause',
    label: 'Missing clause analysis',
    contractTypes: ['data_processing_addendum', 'business_associate_agreement', 'ip_assignment'],
    riskFlags: ['missing_required_terms', 'missing_security_exhibit', 'missing_assignment_recordation'],
    concerns: ['Required regulatory or operational terms are absent from the draft.', 'Missing exhibit prevents reliable downstream compliance review.'],
    registryIds: ['hipaa_business_associates', 'gdpr_article_28', 'uspto_assignment'],
    issueTemplate: 'The agreement references regulated data and transfer obligations but omits the required exhibit or statutory processor terms.',
    recommendation: 'Add the missing exhibit, cite the governing statutory requirements, and block signature until the missing terms are attached.',
  },
  {
    key: 'cross_document_reference',
    label: 'Cross-document reference validation',
    contractTypes: ['statement_of_work', 'service_level_agreement', 'real_estate_purchase'],
    riskFlags: ['broken_cross_reference', 'inconsistent_priority_clause', 'missing_exhibit'],
    concerns: ['Referenced exhibit is absent or points to an outdated agreement version.', 'Priority clause does not resolve conflicts between the base agreement and addendum.'],
    registryIds: ['e_sign_act', 'state_contract_law_ca'],
    issueTemplate: 'The SOW states that Exhibit C controls acceptance criteria, but the package only includes Exhibits A and B and an older order form.',
    recommendation: 'Require a document-package completeness check and add an order-of-precedence clause before approval.',
  },
  {
    key: 'party_authority',
    label: 'Party authority reasoning',
    contractTypes: ['llc_partnership', 'contractor_consultant', 'sales_agreement'],
    riskFlags: ['signatory_authority_gap', 'entity_name_mismatch', 'unauthorized_binding_power'],
    concerns: ['Signatory title does not match the authority required by the contract.', 'Counterparty entity name differs between preamble and signature block.'],
    registryIds: ['e_sign_act', 'dol_independent_contractor'],
    issueTemplate: 'The preamble names [PARTY_A_REDACTED] LLC, but the signature block uses [RELATED_ENTITY_REDACTED] Inc. and a signer title not authorized by the operating agreement.',
    recommendation: 'Request authority evidence, align legal entity names, and require an authorized officer certificate for signature.',
  },
  {
    key: 'jurisdictional_unenforceability',
    label: 'Jurisdictional enforceability reasoning',
    contractTypes: ['employment_agreement', 'residential_lease', 'commercial_lease'],
    riskFlags: ['choice_of_law_conflict', 'statutory_notice_gap', 'unenforceable_restrictive_covenant'],
    concerns: ['Chosen law may conflict with mandatory local statute.', 'Notice or fee language appears inconsistent with jurisdiction-specific protections.'],
    registryIds: ['hud_fair_housing', 'state_contract_law_ny', 'adr_commercial_rules'],
    issueTemplate: 'The lease selects a distant forum and waives statutory notice rights for a residential unit located in a different state.',
    recommendation: 'Replace the forum and notice language with jurisdiction-specific terms and escalate for local counsel review.',
  },
  {
    key: 'template_deviation',
    label: 'Template-deviation reasoning',
    contractTypes: ['master_services_agreement', 'subscription_agreement', 'ip_license'],
    riskFlags: ['template_clause_removed', 'fallback_language_changed', 'unapproved_redline'],
    concerns: ['Standard risk-control language is missing from a high-volume template.', 'Deviation is not explained by deal notes or approval metadata.'],
    registryIds: ['state_contract_law_ca', 'uspto_assignment'],
    issueTemplate: 'The executed draft removed the standard limitation-of-liability carveout for confidentiality and did not include an approval note.',
    recommendation: 'Compare against the approved template, require deviation approval, and restore the missing control clause where appropriate.',
  },
  {
    key: 'recommendation_chain',
    label: 'Recommendation-chain reasoning',
    contractTypes: ['franchise_agreement', 'business_associate_agreement', 'ip_assignment'],
    riskFlags: ['multi_step_review_required', 'external_registry_needed', 'evidence_package_incomplete'],
    concerns: ['The risk cannot be resolved by one clause edit because external filings or disclosure evidence are required.', 'Recommendation should include a sequenced checklist.'],
    registryIds: ['ftc_franchise_rule', 'ecfr_franchise_rule', 'hipaa_business_associates', 'uspto_patent_assignments'],
    issueTemplate: 'The franchise draft references a disclosure packet, but the file lacks the signed receipt, timing evidence, and state addendum.',
    recommendation: 'Create a chained recommendation: verify disclosure receipt, attach required addendum, then route to counsel before signature.',
  },
  {
    key: 'regulatory_gap',
    label: 'Regulatory-gap reasoning',
    contractTypes: ['franchise_agreement', 'loan_promissory_note', 'data_processing_addendum'],
    riskFlags: ['regulatory_terms_missing', 'consumer_notice_gap', 'privacy_transfer_gap'],
    concerns: ['Regulated transaction lacks required notices or statutory clauses.', 'Operational team needs a blocked-until-remediated signal rather than advisory-only text.'],
    registryIds: ['ftc_franchise_rule', 'cfpb_reg_z', 'gdpr_dpa', 'hipaa_privacy_rule', 'eeoc_worker_rights'],
    issueTemplate: 'The agreement creates regulated obligations but omits the disclosure, notice, or transfer terms needed for the referenced transaction type.',
    recommendation: 'Block signature, attach the required regulatory terms, and record counsel approval in the contract workspace.',
  },
];

const GOVERNING_LAWS = ['California, USA', 'New York, USA', 'Delaware, USA', 'Texas, USA', 'England and Wales'];
const NOTICE_DEADLINES = ['10 days', '15 days', '30 days', '45 days', '60 days'];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function isoDate(offset: number): string {
  const month = (offset % 12) + 1;
  const day = (offset % 27) + 1;
  return `2026-${pad(month)}-${pad(day)}`;
}

function pick<T>(values: readonly T[], index: number): T {
  return values[index % values.length];
}

function registryUrls(ids: string[]): string[] {
  return ids.map(id => {
    const entry = REGISTRY_BY_ID.get(id);
    if (!entry) throw new Error(`Unknown contract recommendation registry id: ${id}`);
    return entry.url;
  });
}

function buildGroundTruth(profile: ReasoningProfile, globalIndex: number): GroundTruthFields {
  const contractType = pick(profile.contractTypes, globalIndex);
  const governingLaw = pick(GOVERNING_LAWS, globalIndex);
  const recommendationUrls = registryUrls(profile.registryIds);
  const noticeDeadline = pick(NOTICE_DEADLINES, globalIndex);

  return {
    credentialType: 'LEGAL',
    subType: contractType,
    contractType,
    contractReasoningType: profile.key,
    issuerName: '[PARTY_A_REDACTED]',
    issuedDate: isoDate(globalIndex),
    effectiveDate: isoDate(globalIndex + 2),
    parties: ['[PARTY_A_REDACTED]', '[PARTY_B_REDACTED]'],
    signatories: ['[SIGNATORY_A_REDACTED]', '[SIGNATORY_B_REDACTED]'],
    noticeDeadline,
    governingLaw,
    jurisdiction: governingLaw,
    riskFlags: profile.riskFlags,
    recommendationUrls,
    concerns: profile.concerns,
    templateDeviation: profile.key === 'template_deviation' ? 'approved template clause removed without approval metadata' : undefined,
    crossDocumentReference: profile.key === 'cross_document_reference' ? 'referenced exhibit or master agreement version is missing from package' : undefined,
    signatoryAuthority: profile.key === 'party_authority' ? 'signatory title and entity name require authority evidence' : undefined,
    regulatoryGap: profile.key === 'regulatory_gap' ? 'regulated transaction lacks required notice or statutory clause' : undefined,
    reasoning: `${profile.label}: ${profile.issueTemplate} This creates ${profile.riskFlags.join(', ')} risk for a ${contractType} governed by ${governingLaw}. Recommended action: ${profile.recommendation}`,
  };
}

function buildText(profile: ReasoningProfile, globalIndex: number): string {
  const contractType = pick(profile.contractTypes, globalIndex);
  const noticeDeadline = pick(NOTICE_DEADLINES, globalIndex);

  return [
    `CONTRACT REVIEW EXCERPT - ${profile.label}.`,
    `Document type: ${contractType}. Parties: [PARTY_A_REDACTED] and [PARTY_B_REDACTED].`,
    `Signatories: [SIGNATORY_A_REDACTED] and [SIGNATORY_B_REDACTED].`,
    `Issue: ${profile.issueTemplate}`,
    `Notice deadline: ${noticeDeadline}. Supporting exhibits and contact details are [REDACTED].`,
    `Reviewer note: ${profile.recommendation}`,
  ].join(' ');
}

function buildEntry(profile: ReasoningProfile, globalIndex: number, localIndex: number): GoldenDatasetEntry {
  const groundTruth = buildGroundTruth(profile, globalIndex);
  const humanReview = globalIndex < CONTRACT_REASONING_HUMAN_REVIEW_SAMPLE_SIZE;

  return {
    id: `GD-${5100 + globalIndex}`,
    description: `${profile.label} synthetic reasoning variation ${localIndex + 1}`,
    strippedText: buildText(profile, globalIndex),
    credentialTypeHint: 'LEGAL',
    groundTruth,
    source: 'synthetic-gme10-contract-reasoning-p24',
    category: 'contract-reasoning',
    tags: [
      'synthetic',
      'contract',
      'reasoning',
      'gme10',
      'phase24',
      profile.key,
      ...(humanReview ? ['human-review-sample'] : []),
    ],
  };
}

function buildReasoningDataset(): GoldenDatasetEntry[] {
  const entries: GoldenDatasetEntry[] = [];
  let globalIndex = 0;

  for (const profile of REASONING_PROFILES) {
    const count = CONTRACT_REASONING_CATEGORY_COUNTS[profile.key];
    for (let localIndex = 0; localIndex < count; localIndex++) {
      entries.push(buildEntry(profile, globalIndex, localIndex));
      globalIndex += 1;
    }
  }

  return entries;
}

export const GOLDEN_DATASET_PHASE24_CONTRACT_REASONING: GoldenDatasetEntry[] = buildReasoningDataset();
