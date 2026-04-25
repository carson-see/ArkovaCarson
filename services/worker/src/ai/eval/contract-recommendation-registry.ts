/**
 * SCRUM-861 / GME10.3 recommendation URL registry.
 *
 * The reasoning golden set references only these vetted URLs. This mirrors the
 * GME8.3 recommendation-registry constraint without adding runtime dependencies
 * to the evaluator.
 */

export interface ContractRecommendationRegistryEntry {
  id: string;
  label: string;
  url: string;
  category: string;
  appliesTo: string[];
}

export const CONTRACT_RECOMMENDATION_URL_REGISTRY: ContractRecommendationRegistryEntry[] = [
  {
    id: 'state_contract_law_ca',
    label: 'California Courts contract basics',
    url: 'https://selfhelp.courts.ca.gov/contracts',
    category: 'state_contract_law',
    appliesTo: ['auto_renewal', 'missing_clause', 'template_deviation'],
  },
  {
    id: 'state_contract_law_ny',
    label: 'New York courts contract actions overview',
    url: 'https://www.nycourts.gov/courthelp/goingtocourt/contractCases.shtml',
    category: 'state_contract_law',
    appliesTo: ['jurisdictional_unenforceability', 'unusual_clause'],
  },
  {
    id: 'ftc_franchise_rule',
    label: 'FTC Franchise Rule',
    url: 'https://www.ftc.gov/legal-library/browse/rules/franchise-rule',
    category: 'franchise',
    appliesTo: ['regulatory_gap', 'recommendation_chain'],
  },
  {
    id: 'ecfr_franchise_rule',
    label: 'eCFR 16 CFR Part 436',
    url: 'https://www.ecfr.gov/current/title-16/chapter-I/subchapter-D/part-436',
    category: 'franchise',
    appliesTo: ['regulatory_gap', 'recommendation_chain'],
  },
  {
    id: 'hipaa_privacy_rule',
    label: 'HHS HIPAA Privacy Rule',
    url: 'https://www.hhs.gov/hipaa/for-professionals/privacy/index.html',
    category: 'healthcare',
    appliesTo: ['missing_clause', 'regulatory_gap'],
  },
  {
    id: 'hipaa_business_associates',
    label: 'HHS business associate contracts',
    url: 'https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html',
    category: 'healthcare',
    appliesTo: ['missing_clause', 'regulatory_gap', 'recommendation_chain'],
  },
  {
    id: 'gdpr_dpa',
    label: 'GDPR.eu data processing agreement overview',
    url: 'https://gdpr.eu/data-processing-agreement/',
    category: 'privacy',
    appliesTo: ['missing_clause', 'regulatory_gap'],
  },
  {
    id: 'gdpr_article_28',
    label: 'GDPR Article 28 processor terms',
    url: 'https://gdpr-info.eu/art-28-gdpr/',
    category: 'privacy',
    appliesTo: ['missing_clause', 'regulatory_gap', 'recommendation_chain'],
  },
  {
    id: 'uspto_assignment',
    label: 'USPTO assignment recordation',
    url: 'https://www.uspto.gov/ip-policy/assignment-recordation-branch',
    category: 'intellectual_property',
    appliesTo: ['missing_clause', 'template_deviation', 'recommendation_chain'],
  },
  {
    id: 'uspto_patent_assignments',
    label: 'USPTO patent assignments',
    url: 'https://www.uspto.gov/patents/apply/applying-online/assignment-center',
    category: 'intellectual_property',
    appliesTo: ['missing_clause', 'recommendation_chain'],
  },
  {
    id: 'dol_independent_contractor',
    label: 'DOL independent contractor guidance',
    url: 'https://www.dol.gov/agencies/whd/flsa/misclassification',
    category: 'employment',
    appliesTo: ['party_authority', 'regulatory_gap', 'unusual_clause'],
  },
  {
    id: 'eeoc_worker_rights',
    label: 'EEOC small business employee rights',
    url: 'https://www.eeoc.gov/employers/small-business/employee-rights',
    category: 'employment',
    appliesTo: ['missing_clause', 'regulatory_gap'],
  },
  {
    id: 'hud_fair_housing',
    label: 'HUD Fair Housing Act overview',
    url: 'https://www.hud.gov/program_offices/fair_housing_equal_opp/fair_housing_act_overview',
    category: 'real_estate',
    appliesTo: ['jurisdictional_unenforceability', 'regulatory_gap'],
  },
  {
    id: 'cfpb_reg_z',
    label: 'CFPB Regulation Z',
    url: 'https://www.consumerfinance.gov/rules-policy/regulations/1026/',
    category: 'lending',
    appliesTo: ['missing_clause', 'regulatory_gap'],
  },
  {
    id: 'adr_commercial_rules',
    label: 'AAA commercial arbitration rules',
    url: 'https://www.adr.org/Rules',
    category: 'dispute_resolution',
    appliesTo: ['jurisdictional_unenforceability', 'unusual_clause'],
  },
  {
    id: 'e_sign_act',
    label: 'E-SIGN Act overview',
    url: 'https://www.ftc.gov/business-guidance/resources/electronic-signatures-global-national-commerce-act',
    category: 'esignature',
    appliesTo: ['party_authority', 'cross_document_reference'],
  },
];
