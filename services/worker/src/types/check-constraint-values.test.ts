import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AI_USAGE_EVENT_TYPES,
  ATS_PROVIDERS,
  COMPLIANCE_GRADES,
  CONNECTOR_PROVIDERS,
  DSR_REQUEST_TYPES,
  ENTITLEMENT_SOURCES,
  INTEGRATION_PROVIDERS,
  INTEGRATION_EVENT_STATUSES,
  KYB_PROVIDERS,
  KYB_EVENT_STATUSES,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_TYPES,
  BILLING_PERIODS,
  AFFILIATION_FEE_STATUSES,
  DOMAIN_VERIFICATION_METHODS,
  INDUSTRY_TAGS,
  PARENT_APPROVAL_STATUSES,
  PAYMENT_STATES,
  ORG_VERIFICATION_STATUSES,
  IDENTITY_VERIFICATION_STATUSES,
  KYC_PROVIDERS,
  SUBSCRIPTION_TIERS,
  SIGNATURE_FORMATS,
  SIGNATURE_JURISDICTIONS,
  SIGNATURE_LEVELS,
  KMS_PROVIDERS,
  CERTIFICATE_TRUST_LEVELS,
  TOKEN_TYPES,
  TOKEN_VERIFICATION_STATUSES,
  VERIFICATION_METHODS,
  VERIFICATION_RESULTS,
  FERPA_EXCEPTION_CATEGORIES,
  INSTITUTION_TYPES,
} from './check-constraint-values.js';

const BASELINE_PATH = resolve(
  __dirname,
  '../../../../supabase/migrations/00000000000000_baseline_at_main_HEAD.sql',
);

function parseCheckConstraint(sql: string, constraintName: string): string[] {
  const pattern = new RegExp(
    `CONSTRAINT\\s+"${constraintName}"\\s+CHECK\\s*\\(.*?ARRAY\\[([^\\]]+)\\]`,
    's',
  );
  const match = sql.match(pattern);
  if (!match) return [];
  return [...match[1].matchAll(/'([^']+)'::"?text"?/g)].map((m) => m[1]);
}

const baselineSql = readFileSync(BASELINE_PATH, 'utf-8');

describe('check-constraint-values', () => {
  describe('no duplicates in any const array', () => {
    const allArrays: Record<string, readonly string[]> = {
      AI_USAGE_EVENT_TYPES,
      ATS_PROVIDERS,
      COMPLIANCE_GRADES,
      CONNECTOR_PROVIDERS,
      DSR_REQUEST_TYPES,
      ENTITLEMENT_SOURCES,
      INTEGRATION_PROVIDERS,
      INTEGRATION_EVENT_STATUSES,
      KYB_PROVIDERS,
      KYB_EVENT_STATUSES,
      NOTIFICATION_SEVERITIES,
      NOTIFICATION_TYPES,
      BILLING_PERIODS,
      AFFILIATION_FEE_STATUSES,
      DOMAIN_VERIFICATION_METHODS,
      INDUSTRY_TAGS,
      PARENT_APPROVAL_STATUSES,
      PAYMENT_STATES,
      ORG_VERIFICATION_STATUSES,
      IDENTITY_VERIFICATION_STATUSES,
      KYC_PROVIDERS,
      SUBSCRIPTION_TIERS,
      SIGNATURE_FORMATS,
      SIGNATURE_JURISDICTIONS,
      SIGNATURE_LEVELS,
      KMS_PROVIDERS,
      CERTIFICATE_TRUST_LEVELS,
      TOKEN_TYPES,
      TOKEN_VERIFICATION_STATUSES,
      VERIFICATION_METHODS,
      VERIFICATION_RESULTS,
      FERPA_EXCEPTION_CATEGORIES,
      INSTITUTION_TYPES,
    };

    for (const [name, arr] of Object.entries(allArrays)) {
      it(`${name} has no duplicate values`, () => {
        expect(new Set(arr).size).toBe(arr.length);
      });
    }
  });

  describe('matches baseline CHECK constraints', () => {
    const cases: Array<{
      name: string;
      constraint: string;
      tsArray: readonly string[];
      extra?: readonly string[];
    }> = [
      { name: 'ai_usage_events.event_type', constraint: 'ai_usage_events_event_type_check', tsArray: AI_USAGE_EVENT_TYPES },
      { name: 'ats_integrations.provider', constraint: 'ats_integrations_provider_check', tsArray: ATS_PROVIDERS },
      { name: 'connector_subscriptions.provider', constraint: 'connector_subscriptions_provider_check', tsArray: CONNECTOR_PROVIDERS },
      { name: 'data_subject_requests.request_type', constraint: 'data_subject_requests_request_type_check', tsArray: DSR_REQUEST_TYPES },
      { name: 'entitlements.source', constraint: 'entitlements_source_check', tsArray: ENTITLEMENT_SOURCES },
      { name: 'integration_events.status', constraint: 'integration_events_status_check', tsArray: INTEGRATION_EVENT_STATUSES },
      { name: 'kyb_events.provider', constraint: 'kyb_events_provider_check', tsArray: KYB_PROVIDERS },
      { name: 'kyb_events.status', constraint: 'kyb_events_status_check', tsArray: KYB_EVENT_STATUSES },
      { name: 'notifications.severity', constraint: 'notifications_severity_check', tsArray: NOTIFICATION_SEVERITIES },
      { name: 'organizations.verification_status', constraint: 'organizations_verification_status_valid', tsArray: ORG_VERIFICATION_STATUSES },
      { name: 'profiles.identity_verification_status', constraint: 'profiles_identity_verification_status_check', tsArray: IDENTITY_VERIFICATION_STATUSES },
      { name: 'profiles.kyc_provider', constraint: 'profiles_kyc_provider_check', tsArray: KYC_PROVIDERS },
      { name: 'signatures.format', constraint: 'signatures_format_check', tsArray: SIGNATURE_FORMATS },
      { name: 'signatures.jurisdiction', constraint: 'signatures_jurisdiction_check', tsArray: SIGNATURE_JURISDICTIONS },
      { name: 'signatures.level', constraint: 'signatures_level_check', tsArray: SIGNATURE_LEVELS },
      { name: 'signing_certificates.kms_provider', constraint: 'signing_certificates_kms_provider_check', tsArray: KMS_PROVIDERS },
      { name: 'signing_certificates.trust_level', constraint: 'signing_certificates_trust_level_check', tsArray: CERTIFICATE_TRUST_LEVELS },
      { name: 'timestamp_tokens.token_type', constraint: 'timestamp_tokens_token_type_check', tsArray: TOKEN_TYPES },
      { name: 'timestamp_tokens.verification_status', constraint: 'timestamp_tokens_verification_status_check', tsArray: TOKEN_VERIFICATION_STATUSES },
      { name: 'verification_events.method', constraint: 'verification_events_method_check', tsArray: VERIFICATION_METHODS },
      { name: 'verification_events.result', constraint: 'verification_events_result_check', tsArray: VERIFICATION_RESULTS },
      { name: 'api_keys.ferpa_exception_category', constraint: 'chk_ferpa_exception_valid', tsArray: FERPA_EXCEPTION_CATEGORIES },
      { name: 'api_keys.institution_type', constraint: 'chk_institution_type_valid', tsArray: INSTITUTION_TYPES },
    ];

    for (const { name, constraint, tsArray } of cases) {
      it(`${name} matches ${constraint}`, () => {
        const dbValues = parseCheckConstraint(baselineSql, constraint);
        expect(dbValues.length, `Constraint not found in baseline: ${constraint}`).toBeGreaterThan(0);
        const tsSet = new Set(tsArray);
        const dbSet = new Set(dbValues);
        expect([...tsSet].sort()).toEqual([...dbSet].sort());
      });
    }
  });
});
