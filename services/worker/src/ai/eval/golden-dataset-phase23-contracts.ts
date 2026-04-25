/**
 * Golden Dataset Phase 23 - Contracts Expert v1 (SCRUM-860)
 *
 * Synthetic, PII-stripped contract extraction entries for GME10.2.
 * Distribution follows the Jira acceptance criteria exactly; the listed counts
 * sum to 1,040, which is treated as the story's "~1,000 entries" target.
 *
 * ID allocation:
 *   GD-4000..5039 = contracts extraction corpus
 */

import type { GoldenDatasetEntry, GroundTruthFields } from './types.js';

export const CONTRACT_PHASE23_TYPE_COUNTS = {
  master_services_agreement: 100,
  statement_of_work: 80,
  nondisclosure_agreement: 80,
  employment_agreement: 80,
  sales_agreement: 60,
  commercial_lease: 80,
  residential_lease: 60,
  contractor_consultant: 60,
  ip_assignment: 40,
  software_license: 60,
  llc_partnership: 40,
  data_processing_addendum: 40,
  business_associate_agreement: 30,
  service_level_agreement: 30,
  subscription_agreement: 40,
  real_estate_purchase: 30,
  loan_promissory_note: 20,
  settlement_agreement: 20,
  franchise_agreement: 15,
  ip_license: 15,
  adversarial_fraud: 60,
} as const;

type ContractType = keyof typeof CONTRACT_PHASE23_TYPE_COUNTS;

interface ContractProfile {
  key: ContractType;
  label: string;
  category: string;
  deliverables: string[];
  paymentTerms: string[];
  liabilityCaps: string[];
  indemnification: string[];
  termination: string[];
  specialClauses: string[];
  riskFlags: string[];
}

const CONTRACT_PROFILES: ContractProfile[] = [
  {
    key: 'master_services_agreement',
    label: 'Master Services Agreement',
    category: 'commercial_contract',
    deliverables: ['professional services', 'implementation support', 'monthly status reports'],
    paymentTerms: ['Net 30 after approved invoice', 'monthly in arrears', 'milestone billing after acceptance'],
    liabilityCaps: ['fees paid in the prior 12 months', 'one times annual fees', 'direct damages capped at USD [AMOUNT_REDACTED]'],
    indemnification: ['mutual IP infringement and third-party bodily injury claims', 'provider indemnifies for confidentiality breach', 'client indemnifies for misuse of deliverables'],
    termination: ['30 days for convenience and immediate termination for uncured material breach', '10-day cure for payment breach; 30-day cure for other breaches'],
    specialClauses: ['Order forms control only for scope and fees.', 'No exclusivity is granted to either party.', 'Change orders must be signed through the approved e-signature workflow.'],
    riskFlags: ['scope_creep', 'liability_cap_review'],
  },
  {
    key: 'statement_of_work',
    label: 'Statement of Work',
    category: 'commercial_contract',
    deliverables: ['configuration workshop', 'pilot deployment', 'acceptance test report'],
    paymentTerms: ['40 percent at kickoff, 40 percent at delivery, 20 percent at acceptance', 'fixed fee paid against milestones'],
    liabilityCaps: ['inherits MSA liability cap', 'no standalone cap; master agreement applies'],
    indemnification: ['subject to master agreement indemnities', 'no additional indemnity beyond MSA'],
    termination: ['terminates with the master agreement or on final acceptance', 'client may pause work with 10 business days notice'],
    specialClauses: ['Dependencies include timely sandbox access.', 'Acceptance occurs after five business days without written rejection.', 'Out-of-scope requests require a change order.'],
    riskFlags: ['acceptance_window', 'dependency_risk'],
  },
  {
    key: 'nondisclosure_agreement',
    label: 'Mutual Non-Disclosure Agreement',
    category: 'confidentiality_contract',
    deliverables: ['confidential evaluation discussions', 'technical diligence materials'],
    paymentTerms: ['no payment obligation', 'each party bears its own costs'],
    liabilityCaps: ['equitable remedies not capped', 'damages uncapped for willful disclosure'],
    indemnification: ['no indemnity; remedies limited to breach of confidentiality obligations', 'each party responsible for its representatives'],
    termination: ['may terminate disclosure period on written notice', 'confidentiality survives termination'],
    specialClauses: ['Residual knowledge is excluded from confidential information.', 'Return or destroy materials within 15 days after request.', 'Compelled disclosure requires prompt notice where legally permitted.'],
    riskFlags: ['residuals_clause_review', 'survival_period_review'],
  },
  {
    key: 'employment_agreement',
    label: 'Employment Agreement',
    category: 'employment_contract',
    deliverables: ['position duties', 'confidentiality obligations', 'assignment of work product'],
    paymentTerms: ['base salary paid biweekly', 'eligible bonus under company plan', 'commission plan attached as exhibit'],
    liabilityCaps: ['employee liability governed by applicable law', 'no liquidated damages except repayment of signing bonus'],
    indemnification: ['company indemnifies employee for authorized acts within scope of employment', 'employee indemnifies for intentional misconduct'],
    termination: ['at-will employment; either party may terminate at any time', 'for-cause termination after policy violation'],
    specialClauses: ['Non-solicit applies for 12 months after employment.', 'Restrictive covenants must comply with governing law.', 'Employee handbook controls benefits eligibility.'],
    riskFlags: ['restrictive_covenant_review', 'classification_review'],
  },
  {
    key: 'sales_agreement',
    label: 'Sales Agreement',
    category: 'sales_contract',
    deliverables: ['product shipment', 'invoice packet', 'warranty documentation'],
    paymentTerms: ['Net 45 from shipment date', '50 percent deposit with balance before shipment'],
    liabilityCaps: ['purchase price of affected goods', 'replacement or refund as sole remedy'],
    indemnification: ['seller indemnifies for product defect claims', 'buyer indemnifies for unauthorized resale claims'],
    termination: ['seller may suspend shipment for overdue invoices', 'buyer may cancel undelivered units before production release'],
    specialClauses: ['Title transfers on delivery to carrier.', 'Risk of loss follows Incoterms stated in the order.', 'Warranty claims require written notice within 30 days.'],
    riskFlags: ['warranty_limit_review', 'incoterms_review'],
  },
  {
    key: 'commercial_lease',
    label: 'Commercial Lease',
    category: 'real_estate_contract',
    deliverables: ['leased premises', 'common area access', 'tenant improvements'],
    paymentTerms: ['base rent due monthly in advance', 'triple-net expenses reconciled annually'],
    liabilityCaps: ['landlord liability limited to interest in the property', 'tenant responsible for premises damage'],
    indemnification: ['tenant indemnifies landlord for premises operations', 'landlord indemnifies for common-area negligence'],
    termination: ['default after 10-day rent cure or 30-day non-monetary cure', 'early termination only by written amendment'],
    specialClauses: ['Use clause limits premises to general office operations.', 'Assignment requires landlord consent not unreasonably withheld.', 'Tenant improvement allowance is capped.'],
    riskFlags: ['assignment_consent', 'cam_reconciliation'],
  },
  {
    key: 'residential_lease',
    label: 'Residential Lease',
    category: 'real_estate_contract',
    deliverables: ['dwelling unit possession', 'appliance inventory', 'community rule addendum'],
    paymentTerms: ['monthly rent due on the first day of each month', 'security deposit held under applicable law'],
    liabilityCaps: ['resident liable for damage beyond ordinary wear', 'owner remedies limited by landlord-tenant law'],
    indemnification: ['resident responsible for guest damage', 'owner responsible for habitability obligations'],
    termination: ['notice period follows state landlord-tenant statute', 'nonpayment cure period as required by law'],
    specialClauses: ['Late fees apply only as permitted by local law.', 'Pet addendum controls animal-related fees.', 'Move-out inspection must be documented.'],
    riskFlags: ['habitability_review', 'statutory_notice_review'],
  },
  {
    key: 'contractor_consultant',
    label: 'Independent Contractor Agreement',
    category: 'employment_contract',
    deliverables: ['consulting deliverables', 'weekly status updates', 'final recommendation memo'],
    paymentTerms: ['hourly fees invoiced twice monthly', 'fixed monthly retainer with capped hours'],
    liabilityCaps: ['three months of fees', 'fees paid under the statement of work'],
    indemnification: ['contractor indemnifies for tax and employment classification claims', 'client indemnifies for supplied materials'],
    termination: ['15 days notice for convenience', 'immediate termination for confidentiality breach'],
    specialClauses: ['Contractor controls means and methods of work.', 'No authority to bind client without written approval.', 'Work product assignment occurs on full payment.'],
    riskFlags: ['worker_classification', 'authority_to_bind'],
  },
  {
    key: 'ip_assignment',
    label: 'Intellectual Property Assignment',
    category: 'intellectual_property_contract',
    deliverables: ['assigned inventions', 'source materials', 'assignment recordation support'],
    paymentTerms: ['one-time assignment fee', 'consideration acknowledged as paid and sufficient'],
    liabilityCaps: ['assignor warranties limited to ownership and non-encumbrance', 'no consequential damages'],
    indemnification: ['assignor indemnifies for breach of title warranty', 'assignee indemnifies for post-assignment exploitation'],
    termination: ['assignment is irrevocable on execution', 'recordation cooperation survives execution'],
    specialClauses: ['Moral rights waived to the extent permitted by law.', 'Further assurances clause requires recordable documents.', 'Excluded background IP is listed in Exhibit B.'],
    riskFlags: ['chain_of_title', 'excluded_ip_review'],
  },
  {
    key: 'software_license',
    label: 'Software License Agreement',
    category: 'technology_contract',
    deliverables: ['licensed software access', 'documentation', 'support channel'],
    paymentTerms: ['annual license fees paid upfront', 'usage overages billed monthly'],
    liabilityCaps: ['12 months of license fees', 'super-cap for confidentiality and security claims'],
    indemnification: ['vendor indemnifies for IP infringement', 'customer indemnifies for prohibited use'],
    termination: ['nonpayment suspension after 10 days notice', 'material breach cure period of 30 days'],
    specialClauses: ['No reverse engineering or benchmarking without consent.', 'Audit rights limited to once per year.', 'Open-source notices are provided in Exhibit C.'],
    riskFlags: ['audit_rights_review', 'security_supercap_review'],
  },
  {
    key: 'llc_partnership',
    label: 'LLC Operating / Partnership Agreement',
    category: 'entity_governance_contract',
    deliverables: ['capital account schedule', 'management rights', 'distribution waterfall'],
    paymentTerms: ['capital contributions per member schedule', 'tax distributions before discretionary distributions'],
    liabilityCaps: ['member liability limited by entity law', 'manager liability limited except fraud or willful misconduct'],
    indemnification: ['company indemnifies managers for authorized acts', 'members indemnify for unauthorized commitments'],
    termination: ['dissolution by supermajority vote or statutory event', 'buy-sell trigger after member deadlock'],
    specialClauses: ['Major decisions require 75 percent member approval.', 'Transfer restrictions apply to membership interests.', 'Tax matters partner designated in Exhibit A.'],
    riskFlags: ['deadlock_review', 'transfer_restriction_review'],
  },
  {
    key: 'data_processing_addendum',
    label: 'Data Processing Addendum',
    category: 'privacy_contract',
    deliverables: ['processor obligations', 'subprocessor notice', 'security measures exhibit'],
    paymentTerms: ['included in master services fees', 'no separate payment obligations'],
    liabilityCaps: ['privacy claims subject to security super-cap', 'liability follows master agreement except statutory fines'],
    indemnification: ['processor indemnifies for unauthorized processing', 'controller indemnifies for unlawful instructions'],
    termination: ['delete or return personal data after services end', 'controller may terminate for uncured processing breach'],
    specialClauses: ['Subprocessors require notice and objection process.', 'International transfers rely on approved transfer mechanism.', 'Audit reports may satisfy audit rights.'],
    riskFlags: ['subprocessor_notice', 'transfer_mechanism_review'],
  },
  {
    key: 'business_associate_agreement',
    label: 'Business Associate Agreement',
    category: 'healthcare_contract',
    deliverables: ['permitted PHI uses', 'safeguards obligations', 'breach notice process'],
    paymentTerms: ['no separate compensation', 'fees governed by services agreement'],
    liabilityCaps: ['HIPAA violations subject to privacy super-cap', 'uncapped for willful misuse of PHI'],
    indemnification: ['business associate indemnifies covered entity for PHI misuse', 'covered entity indemnifies for unlawful instructions'],
    termination: ['terminate for material HIPAA breach if not cured', 'return or destroy PHI at termination where feasible'],
    specialClauses: ['Report security incidents without unreasonable delay.', 'Subcontractors must agree to the same restrictions.', 'Minimum necessary standard applies.'],
    riskFlags: ['phi_safeguards', 'breach_notice_review'],
  },
  {
    key: 'service_level_agreement',
    label: 'Service Level Agreement',
    category: 'technology_contract',
    deliverables: ['uptime commitment', 'support response times', 'service-credit schedule'],
    paymentTerms: ['service credits applied to future invoices', 'credits are sole financial remedy'],
    liabilityCaps: ['credits capped at monthly fees', 'SLA credits do not expand liability cap'],
    indemnification: ['no independent indemnity; master agreement controls', 'vendor responsible for subcontracted support failures'],
    termination: ['chronic failure allows termination after repeated missed SLA periods', 'scheduled maintenance excluded with notice'],
    specialClauses: ['Availability excludes customer-caused downtime.', 'Severity 1 response target is one hour.', 'Credits require claim within 30 days.'],
    riskFlags: ['sole_remedy_review', 'maintenance_exclusion_review'],
  },
  {
    key: 'subscription_agreement',
    label: 'Subscription Agreement',
    category: 'technology_contract',
    deliverables: ['SaaS subscription access', 'administrator console', 'usage reports'],
    paymentTerms: ['annual subscription prepaid', 'auto-renewal invoice 30 days before renewal'],
    liabilityCaps: ['annual fees paid for the subscription', 'data breach cap equals two times annual fees'],
    indemnification: ['vendor IP indemnity', 'customer data and use indemnity'],
    termination: ['non-renewal requires 30 days notice before renewal date', 'termination for material breach after cure period'],
    specialClauses: ['Usage limits reset each subscription year.', 'Beta features are provided without SLA.', 'Data export available for 30 days after termination.'],
    riskFlags: ['auto_renewal_notice', 'data_export_window'],
  },
  {
    key: 'real_estate_purchase',
    label: 'Real Estate Purchase Agreement',
    category: 'real_estate_contract',
    deliverables: ['property conveyance', 'title commitment', 'closing deliverables'],
    paymentTerms: ['earnest money deposit and cash at closing', 'seller financing addendum attached'],
    liabilityCaps: ['liquidated damages limited to earnest money where elected', 'seller warranties survive for stated period'],
    indemnification: ['seller indemnifies for pre-closing liens', 'buyer indemnifies for post-closing operations'],
    termination: ['inspection contingency through diligence deadline', 'financing contingency expires before closing'],
    specialClauses: ['Closing prorations use local custom.', 'Title objections due within five business days.', 'Risk of loss remains with seller until closing.'],
    riskFlags: ['contingency_deadline', 'title_objection_review'],
  },
  {
    key: 'loan_promissory_note',
    label: 'Loan / Promissory Note',
    category: 'lending_contract',
    deliverables: ['loan proceeds', 'payment schedule', 'security agreement if applicable'],
    paymentTerms: ['monthly principal and interest payments', 'interest-only period followed by amortization'],
    liabilityCaps: ['borrower liable for unpaid principal, interest, and collection costs', 'lender remedies limited by applicable law'],
    indemnification: ['borrower indemnifies for use-of-proceeds violations', 'guarantor obligations stated separately'],
    termination: ['accelerates on uncured event of default', 'prepayment permitted without penalty unless stated'],
    specialClauses: ['Default interest applies only after written notice.', 'Late charges are capped by applicable law.', 'Collateral description is incorporated by reference.'],
    riskFlags: ['usury_review', 'default_interest_review'],
  },
  {
    key: 'settlement_agreement',
    label: 'Settlement Agreement',
    category: 'dispute_resolution_contract',
    deliverables: ['release of claims', 'dismissal filing', 'settlement payment'],
    paymentTerms: ['lump-sum settlement payment by wire', 'installment settlement schedule'],
    liabilityCaps: ['payment amount is sole monetary obligation', 'no admission of liability'],
    indemnification: ['each party indemnifies for breach of confidentiality and tax representations', 'no third-party indemnity'],
    termination: ['release effective after payment clears', 'breach permits enforcement but not rescission unless stated'],
    specialClauses: ['Confidentiality exceptions include tax and legal advisors.', 'Mutual non-disparagement is limited to authorized representatives.', 'Court retains jurisdiction for enforcement.'],
    riskFlags: ['release_scope_review', 'tax_reporting_review'],
  },
  {
    key: 'franchise_agreement',
    label: 'Franchise Agreement',
    category: 'franchise_contract',
    deliverables: ['brand license', 'operations manual access', 'training program'],
    paymentTerms: ['initial franchise fee plus monthly royalty', 'marketing fund contribution due monthly'],
    liabilityCaps: ['franchisee liable for unit operations', 'brand indemnity excluded for franchisee misconduct'],
    indemnification: ['franchisee indemnifies franchisor for store operations', 'franchisor indemnifies for trademark ownership claims'],
    termination: ['default cure periods vary by breach type', 'post-termination de-identification required'],
    specialClauses: ['FDD receipt acknowledged before signing.', 'Territory rights are non-exclusive unless schedule states otherwise.', 'System standards may be updated periodically.'],
    riskFlags: ['fdd_timing_review', 'territory_exclusivity_review'],
  },
  {
    key: 'ip_license',
    label: 'Intellectual Property License',
    category: 'intellectual_property_contract',
    deliverables: ['licensed marks or patents', 'quality-control materials', 'royalty report template'],
    paymentTerms: ['running royalty based on net sales', 'minimum annual royalty'],
    liabilityCaps: ['royalties paid in prior four quarters', 'uncapped for unauthorized sublicensing'],
    indemnification: ['licensor indemnifies for ownership challenges', 'licensee indemnifies for product liability'],
    termination: ['termination for uncured royalty underpayment', 'sell-off period after expiration if allowed'],
    specialClauses: ['Sublicensing requires prior written consent.', 'Quality-control failures trigger cure rights.', 'Royalty audit limited to once per year.'],
    riskFlags: ['quality_control_review', 'royalty_audit_review'],
  },
  {
    key: 'adversarial_fraud',
    label: 'Adversarial / Fraud Contract',
    category: 'adversarial_contract',
    deliverables: ['purported services', 'vague deliverables', 'unverified exhibits'],
    paymentTerms: ['immediate prepaid fee with no refund rights', 'crypto or wire payment demanded before counter-signature'],
    liabilityCaps: ['no coherent cap stated', 'liability waived for all misconduct'],
    indemnification: ['one-sided indemnity against all claims', 'missing indemnity despite high-risk obligations'],
    termination: ['termination right omitted', 'termination requires impossible notice period'],
    specialClauses: ['Signature block has mismatched entity names.', 'Effective date is after the expiration date.', 'Governing law and venue name different countries without explanation.'],
    riskFlags: ['mismatched_party_names', 'impossible_dates', 'missing_authority', 'one_sided_terms'],
  },
];

const JURISDICTIONS = [
  { law: 'California, USA', venue: 'state or federal courts in San Francisco County, California', arbitration: 'AAA commercial arbitration in San Francisco' },
  { law: 'New York, USA', venue: 'state or federal courts in New York County, New York', arbitration: 'JAMS arbitration in New York' },
  { law: 'Delaware, USA', venue: 'Delaware Court of Chancery where available', arbitration: 'AAA arbitration in Wilmington' },
  { law: 'Texas, USA', venue: 'state or federal courts in Travis County, Texas', arbitration: 'AAA arbitration in Austin' },
  { law: 'England and Wales', venue: 'courts of England and Wales', arbitration: 'LCIA arbitration in London' },
];

const TERM_LENGTHS = ['12 months', '24 months', '36 months', 'project term', 'initial term plus renewals'];
const AUTO_RENEWALS = [
  'renews for successive one-year terms unless either party gives 30 days notice',
  'does not auto-renew',
  'renews monthly after the initial term unless canceled before the renewal date',
  'renews annually with 60 days written non-renewal notice',
];
const CONFIDENTIALITY_TERMS = ['3 years after disclosure', '5 years after termination', 'trade secrets protected while they remain trade secrets', 'survives for the agreement term plus 2 years'];
const NOTICE_DEADLINES = ['10 business days', '15 days', '30 days', '45 days', '60 days'];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function isoDate(offset: number, year = 2026): string {
  const month = (offset % 12) + 1;
  const day = (offset % 27) + 1;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function pick<T>(values: readonly T[], index: number): T {
  return values[index % values.length];
}

function buildText(profile: ContractProfile, index: number, effectiveDate: string, expiryDate: string): string {
  const jurisdiction = pick(JURISDICTIONS, index);
  const autoRenewal = pick(AUTO_RENEWALS, index);
  const noticeDeadline = pick(NOTICE_DEADLINES, index);
  const signatoryB = profile.key === 'adversarial_fraud' && index % 3 === 0
    ? '[SIGNATORY_ENTITY_MISMATCH_REDACTED]'
    : '[SIGNATORY_B_REDACTED]';

  return [
    `${profile.label.toUpperCase()}.`,
    `Effective Date: ${effectiveDate}. Expiration Date: ${expiryDate}.`,
    'Parties: [PARTY_A_REDACTED] and [PARTY_B_REDACTED].',
    `Signatories: [SIGNATORY_A_REDACTED] and ${signatoryB}.`,
    `Deliverables: ${profile.deliverables.join(', ')}.`,
    `Payment Terms: ${pick(profile.paymentTerms, index)}.`,
    `Term: ${pick(TERM_LENGTHS, index)}. Auto Renewal: ${autoRenewal}. Notice Deadline: ${noticeDeadline}.`,
    `Liability Cap: ${pick(profile.liabilityCaps, index)}.`,
    `Indemnification: ${pick(profile.indemnification, index)}.`,
    `Termination Rights: ${pick(profile.termination, index)}.`,
    `Governing Law: ${jurisdiction.law}. Venue: ${jurisdiction.venue}. Arbitration: ${jurisdiction.arbitration}.`,
    `Confidentiality Term: ${pick(CONFIDENTIALITY_TERMS, index)}.`,
    pick(profile.specialClauses, index),
    'Contact details, taxpayer IDs, account numbers, and addresses are [REDACTED].',
  ].join(' ');
}

function buildGroundTruth(profile: ContractProfile, globalIndex: number, localIndex: number): GroundTruthFields {
  const jurisdiction = pick(JURISDICTIONS, globalIndex);
  const effectiveDate = isoDate(globalIndex);
  const expiryDate = isoDate(globalIndex + 7, 2027);
  const isFraud = profile.key === 'adversarial_fraud';
  const fraudSignals = isFraud
    ? ['mismatched_party_names', 'impossible_dates', 'missing_signature_authority', 'one_sided_waiver']
    : [];

  return {
    credentialType: 'LEGAL',
    subType: profile.key,
    contractType: profile.key,
    issuerName: '[PARTY_A_REDACTED]',
    issuedDate: effectiveDate,
    effectiveDate,
    expiryDate,
    parties: ['[PARTY_A_REDACTED]', '[PARTY_B_REDACTED]'],
    signatories: ['[SIGNATORY_A_REDACTED]', isFraud && localIndex % 3 === 0 ? '[SIGNATORY_ENTITY_MISMATCH_REDACTED]' : '[SIGNATORY_B_REDACTED]'],
    termLength: pick(TERM_LENGTHS, globalIndex),
    autoRenewalTerms: pick(AUTO_RENEWALS, globalIndex),
    noticeDeadline: pick(NOTICE_DEADLINES, globalIndex),
    paymentTerms: pick(profile.paymentTerms, globalIndex),
    deliverables: profile.deliverables,
    liabilityCap: pick(profile.liabilityCaps, globalIndex),
    indemnificationScope: pick(profile.indemnification, globalIndex),
    terminationRights: pick(profile.termination, globalIndex),
    governingLaw: jurisdiction.law,
    jurisdiction: jurisdiction.law,
    venue: jurisdiction.venue,
    arbitrationClause: jurisdiction.arbitration,
    confidentialityTerm: pick(CONFIDENTIALITY_TERMS, globalIndex),
    fraudSignals,
    riskFlags: [...profile.riskFlags],
    reasoning: `${profile.label} entry ${localIndex + 1} includes parties, signatories, dates, commercial terms, remedies, dispute forum, and risk markers for contract-field extraction.`
  };
}

function buildEntry(profile: ContractProfile, globalIndex: number, localIndex: number): GoldenDatasetEntry {
  const groundTruth = buildGroundTruth(profile, globalIndex, localIndex);
  const effectiveDate = groundTruth.effectiveDate ?? isoDate(globalIndex);
  const expiryDate = groundTruth.expiryDate ?? isoDate(globalIndex + 7, 2027);
  const isFraud = profile.key === 'adversarial_fraud';

  return {
    id: `GD-${4000 + globalIndex}`,
    description: `${profile.label} synthetic contract variation ${localIndex + 1}`,
    strippedText: buildText(profile, globalIndex, effectiveDate, expiryDate),
    credentialTypeHint: 'LEGAL',
    groundTruth,
    source: 'synthetic-gme10-contracts-p23',
    category: profile.category,
    tags: [
      'synthetic',
      'contract',
      'gme10',
      'phase23',
      profile.key,
      ...(isFraud ? ['adversarial', 'fraud', 'suspicious'] : ['clean']),
    ],
  };
}

function buildContractDataset(): GoldenDatasetEntry[] {
  const entries: GoldenDatasetEntry[] = [];
  let globalIndex = 0;

  for (const profile of CONTRACT_PROFILES) {
    const count = CONTRACT_PHASE23_TYPE_COUNTS[profile.key];
    for (let localIndex = 0; localIndex < count; localIndex++) {
      entries.push(buildEntry(profile, globalIndex, localIndex));
      globalIndex += 1;
    }
  }

  return entries;
}

function buildFieldHistogram(entries: GoldenDatasetEntry[]): Record<string, number> {
  const histogram: Record<string, number> = {};

  for (const entry of entries) {
    for (const [field, value] of Object.entries(entry.groundTruth)) {
      const present = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== '';
      if (present) histogram[field] = (histogram[field] ?? 0) + 1;
    }
  }

  return histogram;
}

export const GOLDEN_DATASET_PHASE23_CONTRACTS: GoldenDatasetEntry[] = buildContractDataset();
export const CONTRACT_PHASE23_FIELD_HISTOGRAM = buildFieldHistogram(GOLDEN_DATASET_PHASE23_CONTRACTS);
