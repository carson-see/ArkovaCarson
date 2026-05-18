/**
 * TypeScript unions for every TEXT + CHECK constraint column in the schema.
 * Must stay in sync with the Postgres CHECK constraints in the baseline
 * migration. The test file validates this at CI time.
 *
 * Columns that already use Postgres ENUMs (anchor_status, agent_status, etc.)
 * are typed correctly by Supabase codegen and are NOT listed here.
 */

// ── audit_events ─────────────────────────────────────────────────────
// (also exported from audit-event-category.ts for backward compat)
export { AUDIT_EVENT_CATEGORIES, type AuditEventCategory } from './audit-event-category.js';

// ── ai_usage_events ──────────────────────────────────────────────────
export const AI_USAGE_EVENT_TYPES = ['extraction', 'embedding', 'fraud_check'] as const;
export type AiUsageEventType = (typeof AI_USAGE_EVENT_TYPES)[number];

// ── ats_integrations / ats_webhook_nonces ────────────────────────────
export const ATS_PROVIDERS = ['greenhouse', 'lever', 'generic'] as const;
export type AtsProvider = (typeof ATS_PROVIDERS)[number];

// ── compliance_audits / compliance_scores ────────────────────────────
export const COMPLIANCE_GRADES = ['A', 'B', 'C', 'D', 'F'] as const;
export type ComplianceGrade = (typeof COMPLIANCE_GRADES)[number];

// ── connector_subscriptions ──────────────────────────────────────────
export const CONNECTOR_PROVIDERS = ['google_drive', 'microsoft_graph'] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

// ── data_subject_requests ────────────────────────────────────────────
export const DSR_REQUEST_TYPES = ['export', 'correction', 'erasure', 'restriction', 'portability'] as const;
export type DsrRequestType = (typeof DSR_REQUEST_TYPES)[number];

// ── entitlements ─────────────────────────────────────────────────────
export const ENTITLEMENT_SOURCES = ['subscription', 'manual', 'trial', 'promo'] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

// ── integration_events / org_integrations ────────────────────────────
export const INTEGRATION_PROVIDERS = ['google_drive', 'microsoft_graph', 'docusign', 'adobe_sign'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

// ── integration_events ───────────────────────────────────────────────
export const INTEGRATION_EVENT_STATUSES = ['success', 'warning', 'error'] as const;
export type IntegrationEventStatus = (typeof INTEGRATION_EVENT_STATUSES)[number];

// ── kyb_events / organizations.kyb_provider ──────────────────────────
export const KYB_PROVIDERS = ['middesk', 'manual'] as const;
export type KybProvider = (typeof KYB_PROVIDERS)[number];

// ── kyb_events ───────────────────────────────────────────────────────
export const KYB_EVENT_STATUSES = ['submitted', 'pending', 'verified', 'requires_input', 'rejected', 'error'] as const;
export type KybEventStatus = (typeof KYB_EVENT_STATUSES)[number];

// ── notifications ────────────────────────────────────────────────────
export const NOTIFICATION_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export const NOTIFICATION_TYPES = ['REGULATORY_CHANGE', 'AUDIT_COMPLETED', 'BREACH_ALERT'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// ── org_tier_entitlements / plans ────────────────────────────────────
export const BILLING_PERIODS = ['month', 'year', 'custom'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

// ── organizations ────────────────────────────────────────────────────
export const AFFILIATION_FEE_STATUSES = ['ACTIVE', 'GRACE', 'LAPSED'] as const;
export type AffiliationFeeStatus = (typeof AFFILIATION_FEE_STATUSES)[number];

export const DOMAIN_VERIFICATION_METHODS = ['email', 'dns'] as const;
export type DomainVerificationMethod = (typeof DOMAIN_VERIFICATION_METHODS)[number];

export const INDUSTRY_TAGS = [
  'higher_ed', 'legal_tech', 'fintech', 'healthcare', 'government',
  'insurance', 'real_estate', 'accounting', 'human_resources', 'cybersecurity',
  'energy', 'manufacturing', 'retail', 'media', 'nonprofit',
  'consulting', 'aerospace', 'biotech', 'other',
] as const;
export type IndustryTag = (typeof INDUSTRY_TAGS)[number];

export const PARENT_APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REVOKED'] as const;
export type ParentApprovalStatus = (typeof PARENT_APPROVAL_STATUSES)[number];

export const PAYMENT_STATES = ['grace', 'suspended', 'ok'] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const ORG_VERIFICATION_STATUSES = ['UNVERIFIED', 'PENDING', 'VERIFIED'] as const;
export type OrgVerificationStatus = (typeof ORG_VERIFICATION_STATUSES)[number];

// ── profiles ─────────────────────────────────────────────────────────
export const IDENTITY_VERIFICATION_STATUSES = ['unstarted', 'pending', 'verified', 'requires_input', 'canceled'] as const;
export type IdentityVerificationStatus = (typeof IDENTITY_VERIFICATION_STATUSES)[number];

export const KYC_PROVIDERS = ['stripe_identity', 'dev_bypass'] as const;
export type KycProvider = (typeof KYC_PROVIDERS)[number];

export const SUBSCRIPTION_TIERS = [
  'free', 'starter', 'professional', 'enterprise', 'individual',
  'organization', 'verified_individual', 'org_free', 'small_business', 'medium_business',
] as const;
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

// ── signatures ───────────────────────────────────────────────────────
export const SIGNATURE_FORMATS = ['XAdES', 'PAdES', 'CAdES'] as const;
export type SignatureFormat = (typeof SIGNATURE_FORMATS)[number];

export const SIGNATURE_JURISDICTIONS = ['EU', 'US', 'UK', 'CH', 'INTL'] as const;
export type SignatureJurisdiction = (typeof SIGNATURE_JURISDICTIONS)[number];

export const SIGNATURE_LEVELS = ['B-B', 'B-T', 'B-LT', 'B-LTA'] as const;
export type SignatureLevel = (typeof SIGNATURE_LEVELS)[number];

// ── signing_certificates ─────────────────────────────────────────────
export const KMS_PROVIDERS = ['aws_kms', 'gcp_kms'] as const;
export type KmsProvider = (typeof KMS_PROVIDERS)[number];

export const CERTIFICATE_TRUST_LEVELS = ['BASIC', 'ADVANCED', 'QUALIFIED'] as const;
export type CertificateTrustLevel = (typeof CERTIFICATE_TRUST_LEVELS)[number];

// ── timestamp_tokens ─────────────────────────────────────────────────
export const TOKEN_TYPES = ['SIGNATURE', 'ARCHIVE', 'CONTENT'] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];

export const TOKEN_VERIFICATION_STATUSES = ['UNVERIFIED', 'VALID', 'INVALID', 'EXPIRED'] as const;
export type TokenVerificationStatus = (typeof TOKEN_VERIFICATION_STATUSES)[number];

// ── verification_events ──────────────────────────────────────────────
export const VERIFICATION_METHODS = ['web', 'api', 'embed', 'qr'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export const VERIFICATION_RESULTS = ['verified', 'revoked', 'not_found', 'error'] as const;
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

// ── api_keys (FERPA) ─────────────────────────────────────────────────
export const FERPA_EXCEPTION_CATEGORIES = [
  '99.31(a)(1)', '99.31(a)(2)', '99.31(a)(3)', '99.31(a)(4)',
  '99.31(a)(5)', '99.31(a)(6)', '99.31(a)(7)', '99.31(a)(8)',
  '99.31(a)(9)', '99.31(a)(10)', '99.31(a)(11)', '99.31(a)(12)',
  'other', 'not_applicable',
] as const;
export type FerpaExceptionCategory = (typeof FERPA_EXCEPTION_CATEGORIES)[number];

export const INSTITUTION_TYPES = [
  'k12_school', 'university', 'community_college', 'employer',
  'government', 'accreditor', 'financial_aid', 'research',
  'legal', 'healthcare', 'other',
] as const;
export type InstitutionType = (typeof INSTITUTION_TYPES)[number];
