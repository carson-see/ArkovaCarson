/**
 * Narrows generated Database types so every TEXT + CHECK column gets its
 * union type instead of plain `string`. Applied at the SupabaseClient
 * generic level in db.ts so every `.from().insert()` call is type-checked
 * at compile time.
 *
 * When database.types.ts is regenerated, these overrides still apply —
 * they only touch specific fields and pass everything else through.
 *
 * Columns that use Postgres ENUMs (anchor_status, agent_status, org_tier,
 * profile_status, user_role, notification_type, etc.) are already typed
 * correctly by Supabase codegen and are NOT overridden here.
 */
import type { Database } from './database.types.js';
import type { AuditEventCategory } from './audit-event-category.js';
import type {
  AiUsageEventType,
  AtsProvider,
  ComplianceGrade,
  ConnectorProvider,
  DsrRequestType,
  EntitlementSource,
  IntegrationProvider,
  IntegrationEventStatus,
  KybProvider,
  KybEventStatus,
  NotificationSeverity,
  NotificationType,
  BillingPeriod,
  AffiliationFeeStatus,
  DomainVerificationMethod,
  IndustryTag,
  ParentApprovalStatus,
  PaymentState,
  OrgVerificationStatus,
  IdentityVerificationStatus,
  KycProvider,
  SubscriptionTier,
  SignatureFormat,
  SignatureJurisdiction,
  SignatureLevel,
  KmsProvider,
  CertificateTrustLevel,
  TokenType,
  TokenVerificationStatus,
  VerificationMethod,
  VerificationResult,
  FerpaExceptionCategory,
  InstitutionType,
} from './check-constraint-values.js';

type Orig = Database['public']['Tables'];

// ── Generic helpers ─────────────────────────────────────────────────
// NarrowField: preserves optionality of K in T while narrowing value to V.
// If K is optional in T, it stays optional; if required, it stays required.
/* eslint-disable @typescript-eslint/no-empty-object-type -- {} is the standard TS idiom for detecting optional keys */
type NarrowField<T, K extends keyof T, V> = Omit<T, K> &
  ({} extends Pick<T, K> ? { [P in K]?: V } : { [P in K]: V });
/* eslint-enable @typescript-eslint/no-empty-object-type */

// Compose multiple narrowings via chained intersection.
// Each table override rewrites Row / Insert / Update individually.

// ── audit_events ────────────────────────────────────────────────────
type AuditEventsOverride = {
  Row: NarrowField<Orig['audit_events']['Row'], 'event_category', AuditEventCategory>;
  Insert: NarrowField<Orig['audit_events']['Insert'], 'event_category', AuditEventCategory>;
  Update: NarrowField<Orig['audit_events']['Update'], 'event_category', AuditEventCategory>;
  Relationships: Orig['audit_events']['Relationships'];
};

type AuditEventsArchiveOverride = {
  Row: NarrowField<Orig['audit_events_archive']['Row'], 'event_category', AuditEventCategory>;
  Insert: NarrowField<Orig['audit_events_archive']['Insert'], 'event_category', AuditEventCategory>;
  Update: NarrowField<Orig['audit_events_archive']['Update'], 'event_category', AuditEventCategory>;
  Relationships: Orig['audit_events_archive']['Relationships'];
};

// ── ai_usage_events ─────────────────────────────────────────────────
type AiUsageEventsOverride = {
  Row: NarrowField<Orig['ai_usage_events']['Row'], 'event_type', AiUsageEventType>;
  Insert: NarrowField<Orig['ai_usage_events']['Insert'], 'event_type', AiUsageEventType>;
  Update: NarrowField<Orig['ai_usage_events']['Update'], 'event_type', AiUsageEventType>;
  Relationships: Orig['ai_usage_events']['Relationships'];
};

// ── api_keys (FERPA columns) ────────────────────────────────────────
type ApiKeysOverride = {
  Row: NarrowField<NarrowField<Orig['api_keys']['Row'],
    'ferpa_exception_category', FerpaExceptionCategory | null>,
    'institution_type', InstitutionType | null>;
  Insert: NarrowField<NarrowField<Orig['api_keys']['Insert'],
    'ferpa_exception_category', FerpaExceptionCategory | null>,
    'institution_type', InstitutionType | null>;
  Update: NarrowField<NarrowField<Orig['api_keys']['Update'],
    'ferpa_exception_category', FerpaExceptionCategory | null>,
    'institution_type', InstitutionType | null>;
  Relationships: Orig['api_keys']['Relationships'];
};

// ── ats_integrations ────────────────────────────────────────────────
type AtsIntegrationsOverride = {
  Row: NarrowField<Orig['ats_integrations']['Row'], 'provider', AtsProvider>;
  Insert: NarrowField<Orig['ats_integrations']['Insert'], 'provider', AtsProvider>;
  Update: NarrowField<Orig['ats_integrations']['Update'], 'provider', AtsProvider>;
  Relationships: Orig['ats_integrations']['Relationships'];
};

// ── compliance_audits ───────────────────────────────────────────────
type ComplianceAuditsOverride = {
  Row: NarrowField<Orig['compliance_audits']['Row'], 'overall_grade', ComplianceGrade>;
  Insert: NarrowField<Orig['compliance_audits']['Insert'], 'overall_grade', ComplianceGrade>;
  Update: NarrowField<Orig['compliance_audits']['Update'], 'overall_grade', ComplianceGrade>;
  Relationships: Orig['compliance_audits']['Relationships'];
};

// ── compliance_scores ───────────────────────────────────────────────
type ComplianceScoresOverride = {
  Row: NarrowField<Orig['compliance_scores']['Row'], 'grade', ComplianceGrade>;
  Insert: NarrowField<Orig['compliance_scores']['Insert'], 'grade', ComplianceGrade>;
  Update: NarrowField<Orig['compliance_scores']['Update'], 'grade', ComplianceGrade>;
  Relationships: Orig['compliance_scores']['Relationships'];
};

// ── connector_subscriptions ─────────────────────────────────────────
type ConnectorSubscriptionsOverride = {
  Row: NarrowField<Orig['connector_subscriptions']['Row'], 'provider', ConnectorProvider>;
  Insert: NarrowField<Orig['connector_subscriptions']['Insert'], 'provider', ConnectorProvider>;
  Update: NarrowField<Orig['connector_subscriptions']['Update'], 'provider', ConnectorProvider>;
  Relationships: Orig['connector_subscriptions']['Relationships'];
};

// ── data_subject_requests ───────────────────────────────────────────
type DataSubjectRequestsOverride = {
  Row: NarrowField<Orig['data_subject_requests']['Row'], 'request_type', DsrRequestType>;
  Insert: NarrowField<Orig['data_subject_requests']['Insert'], 'request_type', DsrRequestType>;
  Update: NarrowField<Orig['data_subject_requests']['Update'], 'request_type', DsrRequestType>;
  Relationships: Orig['data_subject_requests']['Relationships'];
};

// ── entitlements ────────────────────────────────────────────────────
type EntitlementsOverride = {
  Row: NarrowField<Orig['entitlements']['Row'], 'source', EntitlementSource>;
  Insert: NarrowField<Orig['entitlements']['Insert'], 'source', EntitlementSource>;
  Update: NarrowField<Orig['entitlements']['Update'], 'source', EntitlementSource>;
  Relationships: Orig['entitlements']['Relationships'];
};

// ── integration_events ──────────────────────────────────────────────
type IntegrationEventsOverride = {
  Row: NarrowField<NarrowField<Orig['integration_events']['Row'],
    'provider', IntegrationProvider>,
    'status', IntegrationEventStatus>;
  Insert: NarrowField<NarrowField<Orig['integration_events']['Insert'],
    'provider', IntegrationProvider>,
    'status', IntegrationEventStatus>;
  Update: NarrowField<NarrowField<Orig['integration_events']['Update'],
    'provider', IntegrationProvider>,
    'status', IntegrationEventStatus>;
  Relationships: Orig['integration_events']['Relationships'];
};

// ── kyb_events ──────────────────────────────────────────────────────
type KybEventsOverride = {
  Row: NarrowField<NarrowField<Orig['kyb_events']['Row'],
    'provider', KybProvider>,
    'status', KybEventStatus>;
  Insert: NarrowField<NarrowField<Orig['kyb_events']['Insert'],
    'provider', KybProvider>,
    'status', KybEventStatus>;
  Update: NarrowField<NarrowField<Orig['kyb_events']['Update'],
    'provider', KybProvider>,
    'status', KybEventStatus>;
  Relationships: Orig['kyb_events']['Relationships'];
};

// ── notifications ───────────────────────────────────────────────────
type NotificationsOverride = {
  Row: NarrowField<NarrowField<Orig['notifications']['Row'],
    'severity', NotificationSeverity>,
    'type', NotificationType>;
  Insert: NarrowField<NarrowField<Orig['notifications']['Insert'],
    'severity', NotificationSeverity>,
    'type', NotificationType>;
  Update: NarrowField<NarrowField<Orig['notifications']['Update'],
    'severity', NotificationSeverity>,
    'type', NotificationType>;
  Relationships: Orig['notifications']['Relationships'];
};

// ── org_integrations ────────────────────────────────────────────────
type OrgIntegrationsOverride = {
  Row: NarrowField<Orig['org_integrations']['Row'], 'provider', IntegrationProvider>;
  Insert: NarrowField<Orig['org_integrations']['Insert'], 'provider', IntegrationProvider>;
  Update: NarrowField<Orig['org_integrations']['Update'], 'provider', IntegrationProvider>;
  Relationships: Orig['org_integrations']['Relationships'];
};

// ── org_tier_entitlements ───────────────────────────────────────────
type OrgTierEntitlementsOverride = {
  Row: NarrowField<Orig['org_tier_entitlements']['Row'], 'billing_period', BillingPeriod>;
  Insert: NarrowField<Orig['org_tier_entitlements']['Insert'], 'billing_period', BillingPeriod>;
  Update: NarrowField<Orig['org_tier_entitlements']['Update'], 'billing_period', BillingPeriod>;
  Relationships: Orig['org_tier_entitlements']['Relationships'];
};

// ── organizations ───────────────────────────────────────────────────
type OrganizationsOverride = {
  Row: NarrowField<NarrowField<NarrowField<NarrowField<NarrowField<NarrowField<NarrowField<
    Orig['organizations']['Row'],
    'affiliation_fee_status', AffiliationFeeStatus | null>,
    'domain_verification_method', DomainVerificationMethod | null>,
    'industry_tag', IndustryTag | null>,
    'kyb_provider', KybProvider | null>,
    'parent_approval_status', ParentApprovalStatus | null>,
    'payment_state', PaymentState | null>,
    'verification_status', OrgVerificationStatus>;
  Insert: NarrowField<NarrowField<NarrowField<NarrowField<NarrowField<NarrowField<NarrowField<
    Orig['organizations']['Insert'],
    'affiliation_fee_status', AffiliationFeeStatus | null>,
    'domain_verification_method', DomainVerificationMethod | null>,
    'industry_tag', IndustryTag | null>,
    'kyb_provider', KybProvider | null>,
    'parent_approval_status', ParentApprovalStatus | null>,
    'payment_state', PaymentState | null>,
    'verification_status', OrgVerificationStatus>;
  Update: NarrowField<NarrowField<NarrowField<NarrowField<NarrowField<NarrowField<NarrowField<
    Orig['organizations']['Update'],
    'affiliation_fee_status', AffiliationFeeStatus | null>,
    'domain_verification_method', DomainVerificationMethod | null>,
    'industry_tag', IndustryTag | null>,
    'kyb_provider', KybProvider | null>,
    'parent_approval_status', ParentApprovalStatus | null>,
    'payment_state', PaymentState | null>,
    'verification_status', OrgVerificationStatus>;
  Relationships: Orig['organizations']['Relationships'];
};

// ── plans ───────────────────────────────────────────────────────────
type PlansOverride = {
  Row: NarrowField<Orig['plans']['Row'], 'billing_period', BillingPeriod>;
  Insert: NarrowField<Orig['plans']['Insert'], 'billing_period', BillingPeriod>;
  Update: NarrowField<Orig['plans']['Update'], 'billing_period', BillingPeriod>;
  Relationships: Orig['plans']['Relationships'];
};

// ── profiles ────────────────────────────────────────────────────────
type ProfilesOverride = {
  Row: NarrowField<NarrowField<NarrowField<
    Orig['profiles']['Row'],
    'identity_verification_status', IdentityVerificationStatus | null>,
    'kyc_provider', KycProvider | null>,
    'subscription_tier', SubscriptionTier>;
  Insert: NarrowField<NarrowField<NarrowField<
    Orig['profiles']['Insert'],
    'identity_verification_status', IdentityVerificationStatus | null>,
    'kyc_provider', KycProvider | null>,
    'subscription_tier', SubscriptionTier>;
  Update: NarrowField<NarrowField<NarrowField<
    Orig['profiles']['Update'],
    'identity_verification_status', IdentityVerificationStatus | null>,
    'kyc_provider', KycProvider | null>,
    'subscription_tier', SubscriptionTier>;
  Relationships: Orig['profiles']['Relationships'];
};

// ── signatures ──────────────────────────────────────────────────────
type SignaturesOverride = {
  Row: NarrowField<NarrowField<NarrowField<
    Orig['signatures']['Row'],
    'format', SignatureFormat>,
    'jurisdiction', SignatureJurisdiction | null>,
    'level', SignatureLevel>;
  Insert: NarrowField<NarrowField<NarrowField<
    Orig['signatures']['Insert'],
    'format', SignatureFormat>,
    'jurisdiction', SignatureJurisdiction | null>,
    'level', SignatureLevel>;
  Update: NarrowField<NarrowField<NarrowField<
    Orig['signatures']['Update'],
    'format', SignatureFormat>,
    'jurisdiction', SignatureJurisdiction | null>,
    'level', SignatureLevel>;
  Relationships: Orig['signatures']['Relationships'];
};

// ── signing_certificates ────────────────────────────────────────────
type SigningCertificatesOverride = {
  Row: NarrowField<NarrowField<Orig['signing_certificates']['Row'],
    'kms_provider', KmsProvider>,
    'trust_level', CertificateTrustLevel>;
  Insert: NarrowField<NarrowField<Orig['signing_certificates']['Insert'],
    'kms_provider', KmsProvider>,
    'trust_level', CertificateTrustLevel>;
  Update: NarrowField<NarrowField<Orig['signing_certificates']['Update'],
    'kms_provider', KmsProvider>,
    'trust_level', CertificateTrustLevel>;
  Relationships: Orig['signing_certificates']['Relationships'];
};

// ── timestamp_tokens ────────────────────────────────────────────────
type TimestampTokensOverride = {
  Row: NarrowField<NarrowField<Orig['timestamp_tokens']['Row'],
    'token_type', TokenType>,
    'verification_status', TokenVerificationStatus | null>;
  Insert: NarrowField<NarrowField<Orig['timestamp_tokens']['Insert'],
    'token_type', TokenType>,
    'verification_status', TokenVerificationStatus | null>;
  Update: NarrowField<NarrowField<Orig['timestamp_tokens']['Update'],
    'token_type', TokenType>,
    'verification_status', TokenVerificationStatus | null>;
  Relationships: Orig['timestamp_tokens']['Relationships'];
};

// ── verification_events ─────────────────────────────────────────────
type VerificationEventsOverride = {
  Row: NarrowField<NarrowField<Orig['verification_events']['Row'],
    'method', VerificationMethod>,
    'result', VerificationResult>;
  Insert: NarrowField<NarrowField<Orig['verification_events']['Insert'],
    'method', VerificationMethod>,
    'result', VerificationResult>;
  Update: NarrowField<NarrowField<Orig['verification_events']['Update'],
    'method', VerificationMethod>,
    'result', VerificationResult>;
  Relationships: Orig['verification_events']['Relationships'];
};

// ── Assembled TypeSafeDatabase ──────────────────────────────────────

type OverriddenTableNames =
  | 'audit_events'
  | 'audit_events_archive'
  | 'ai_usage_events'
  | 'api_keys'
  | 'ats_integrations'
  | 'compliance_audits'
  | 'compliance_scores'
  | 'connector_subscriptions'
  | 'data_subject_requests'
  | 'entitlements'
  | 'integration_events'
  | 'kyb_events'
  | 'notifications'
  | 'org_integrations'
  | 'org_tier_entitlements'
  | 'organizations'
  | 'plans'
  | 'profiles'
  | 'signatures'
  | 'signing_certificates'
  | 'timestamp_tokens'
  | 'verification_events';

export type TypeSafeDatabase = Omit<Database, 'public'> & {
  public: Omit<Database['public'], 'Tables'> & {
    Tables: Omit<Orig, OverriddenTableNames> & {
      audit_events: AuditEventsOverride;
      audit_events_archive: AuditEventsArchiveOverride;
      ai_usage_events: AiUsageEventsOverride;
      api_keys: ApiKeysOverride;
      ats_integrations: AtsIntegrationsOverride;
      compliance_audits: ComplianceAuditsOverride;
      compliance_scores: ComplianceScoresOverride;
      connector_subscriptions: ConnectorSubscriptionsOverride;
      data_subject_requests: DataSubjectRequestsOverride;
      entitlements: EntitlementsOverride;
      integration_events: IntegrationEventsOverride;
      kyb_events: KybEventsOverride;
      notifications: NotificationsOverride;
      org_integrations: OrgIntegrationsOverride;
      org_tier_entitlements: OrgTierEntitlementsOverride;
      organizations: OrganizationsOverride;
      plans: PlansOverride;
      profiles: ProfilesOverride;
      signatures: SignaturesOverride;
      signing_certificates: SigningCertificatesOverride;
      timestamp_tokens: TimestampTokensOverride;
      verification_events: VerificationEventsOverride;
    };
  };
};

// ── Type-safe helper re-exports ─────────────────────────────────────
// These use TypeSafeDatabase instead of Database, so they respect the
// narrowed column types. Import from here instead of database.types.js.
type SafeTables = TypeSafeDatabase['public']['Tables'];

export type TypeSafeTablesUpdate<T extends keyof SafeTables> =
  SafeTables[T] extends { Update: infer U } ? U : never;

export type TypeSafeTablesInsert<T extends keyof SafeTables> =
  SafeTables[T] extends { Insert: infer I } ? I : never;

export type TypeSafeTablesRow<T extends keyof SafeTables> =
  SafeTables[T] extends { Row: infer R } ? R : never;
