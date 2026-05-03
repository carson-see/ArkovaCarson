/**
 * Zod validators for Arkova
 *
 * These validators ensure data integrity before database operations.
 * They mirror and complement database-level constraints.
 */

import { z } from 'zod';
import type { Json } from '@/types/database.types';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * SHA-256 fingerprint regex (64 hex characters)
 * Accepts both uppercase and lowercase hex
 */
const FINGERPRINT_REGEX = /^[A-Fa-f0-9]{64}$/;

/**
 * Control characters regex (ASCII 0-31 and 127)
 * Used to reject filenames with control characters
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\x00-\x1F\x7F]/;

/**
 * Maximum filename length
 */
const MAX_FILENAME_LENGTH = 255;

/**
 * Maximum details length for audit events
 */
const MAX_DETAILS_LENGTH = 10000;

/**
 * Maximum label length (matches DB constraint)
 */
const MAX_LABEL_LENGTH = 500;

/**
 * Valid credential type values (matches credential_type enum)
 */
export const CREDENTIAL_TYPES = [
  'DEGREE',
  'LICENSE',
  'CERTIFICATE',
  'TRANSCRIPT',
  'PROFESSIONAL',
  'CLE',
  'BADGE',
  'ATTESTATION',
  'FINANCIAL',
  'LEGAL',
  'INSURANCE',
  'SEC_FILING',
  'PATENT',
  'REGULATION',
  'PUBLICATION',
  'CHARITY',
  'FINANCIAL_ADVISOR',
  'BUSINESS_ENTITY',
  'RESUME',
  'MEDICAL',
  'MILITARY',
  'IDENTITY',
  'OTHER',
] as const;

export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

/**
 * GRE-01: Credential sub-type taxonomy.
 * Maps each credential type to its valid sub-types.
 * Sub-types enable Gemini to make fine-grained distinctions
 * (e.g., "official undergraduate transcript" vs "transfer evaluation").
 */
export const CREDENTIAL_SUB_TYPES: Record<CredentialType, readonly string[]> = {
  DEGREE: ['associate', 'bachelor', 'master', 'doctorate', 'professional_jd', 'professional_md', 'professional_mba', 'honorary', 'postgraduate_diploma'],
  LICENSE: ['nursing_rn', 'nursing_lpn', 'nursing_np', 'law_bar_admission', 'engineering_pe', 'engineering_fe', 'real_estate', 'teaching', 'medical_md', 'medical_do', 'cpa', 'insurance_producer', 'contractor', 'cdl'],
  CERTIFICATE: ['professional_certification', 'completion_certificate', 'accreditation_certificate', 'digital_badge', 'continuing_education', 'trade_certification'],
  TRANSCRIPT: ['official_undergraduate', 'official_graduate', 'unofficial', 'transfer_evaluation', 'international_wes', 'international_ece', 'high_school', 'vocational'],
  PROFESSIONAL: ['registration', 'membership', 'designation', 'fellowship'],
  CLE: ['general_cle', 'ethics_cle', 'specialty_cle', 'new_attorney', 'federal_cle'],
  BADGE: ['comptia', 'aws', 'cisco', 'pmi_pmp', 'pmi_capm', 'shrm', 'isc2_cissp', 'cfa', 'credly_open_badge'],
  ATTESTATION: ['self_attestation', 'employer_attestation', 'notarized_attestation', 'institutional_attestation'],
  FINANCIAL: ['sec_registration', 'finra_broker', 'finra_advisor', 'cpa_license', 'audit_report', 'tax_filing', 'financial_statement'],
  LEGAL: ['court_opinion', 'court_order', 'plea_agreement', 'settlement', 'enforcement_action', 'regulatory_decision'],
  INSURANCE: ['property_casualty', 'life_health', 'surplus_lines', 'adjuster', 'reinsurance'],
  SEC_FILING: ['10k', '10q', '8k', 'def14a', 's1', 'form_adv', 'form_d'],
  PATENT: ['utility_patent', 'design_patent', 'plant_patent', 'provisional_application', 'pct_application'],
  REGULATION: ['federal_cfr', 'state_admin_code', 'executive_order', 'proposed_rule', 'final_rule', 'guidance_document'],
  PUBLICATION: ['journal_article', 'book', 'book_chapter', 'conference_paper', 'dissertation', 'preprint', 'review', 'report'],
  CHARITY: ['registered_charity', 'tax_exempt_501c3', 'foundation', 'charitable_trust'],
  FINANCIAL_ADVISOR: ['ria_registration', 'iapd_firm', 'iapd_individual', 'broker_dealer'],
  BUSINESS_ENTITY: ['articles_of_incorporation', 'certificate_of_formation', 'certificate_of_good_standing', 'annual_report', 'operating_agreement', 'amendment', 'dissolution'],
  RESUME: ['professional_resume', 'cv_academic', 'federal_resume'],
  MEDICAL: ['npi_registration', 'dea_registration', 'state_medical_license', 'board_certification', 'clinical_privilege'],
  MILITARY: ['dd214', 'service_record', 'va_disability', 'military_id'],
  IDENTITY: ['passport', 'drivers_license', 'national_id', 'birth_certificate', 'social_security'],
  OTHER: ['unclassified'],
};

/** All valid sub-type values (flat list for validation) */
export const ALL_SUB_TYPES = Object.values(CREDENTIAL_SUB_TYPES).flat();

/** Validate that a sub-type is valid for its credential type */
export function isValidSubType(credentialType: CredentialType, subType: string): boolean {
  const validSubTypes = CREDENTIAL_SUB_TYPES[credentialType];
  return validSubTypes?.includes(subType) ?? false;
}

// =============================================================================
// SHARED ANCHOR FIELD SCHEMAS
// =============================================================================

/** Filename: 1–255 chars, no control characters */
const filenameField = z
  .string()
  .min(1, 'Filename is required')
  .max(MAX_FILENAME_LENGTH, `Filename must be ${MAX_FILENAME_LENGTH} characters or less`)
  .refine(
    (val) => !CONTROL_CHARS_REGEX.test(val),
    'Filename must not contain control characters'
  );

/** MIME type: up to 100 chars, optional + nullable */
const fileMimeField = z
  .string()
  .max(100, 'MIME type must be 100 characters or less')
  .optional()
  .nullable();

/** Public attestation evidence metadata sent to /api/v1/attestations. */
export const AttestationEvidencePayloadSchema = z
  .array(z.object({
    evidence_type: z.string().trim().min(1, 'Evidence type is required').max(60, 'Evidence type must be 60 characters or less'),
    fingerprint: z.string().regex(FINGERPRINT_REGEX, 'Fingerprint must be a valid SHA-256 hash (64 hex characters)'),
    mime: z.string().trim().max(255, 'MIME type must be 255 characters or less').nullable(),
    size: z.number().int('File size must be an integer').nonnegative('File size must be nonnegative').nullable(),
    filename: z.string().trim().max(MAX_FILENAME_LENGTH, `Filename must be ${MAX_FILENAME_LENGTH} characters or less`).nullable().optional(),
    description: z.string().trim().max(500, 'Description must be 500 characters or less').nullable().optional(),
  }).strict())
  .max(10, 'At most 10 evidence items can be attached');

export type AttestationEvidencePayload = z.infer<typeof AttestationEvidencePayloadSchema>;

/** Label: 1–500 chars, optional + nullable */
const labelField = z
  .string()
  .min(1, 'Label is required')
  .max(MAX_LABEL_LENGTH, `Label must be ${MAX_LABEL_LENGTH} characters or less`)
  .optional()
  .nullable();

/** Credential type: one of the CREDENTIAL_TYPES enum values, optional + nullable */
const credentialTypeField = z
  .enum(CREDENTIAL_TYPES, {
    errorMap: () => ({
      message: `Credential type must be one of: ${CREDENTIAL_TYPES.join(', ')}`,
    }),
  })
  .optional()
  .nullable();

// =============================================================================
// ANCHOR SCHEMAS
// =============================================================================

/**
 * Schema for creating a new anchor
 *
 * Note: user_id and status are NOT included because:
 * - user_id is set server-side from auth.uid()
 * - status is always PENDING for new anchors
 */
export const AnchorCreateSchema = z.object({
  fingerprint: z
    .string()
    .regex(FINGERPRINT_REGEX, 'Fingerprint must be a valid SHA-256 hash (64 hex characters)')
    .transform((val) => val.toLowerCase()), // Normalize to lowercase

  filename: filenameField,

  file_size: z
    .number()
    .int('File size must be an integer')
    .positive('File size must be positive')
    .optional()
    .nullable(),

  file_mime: fileMimeField,

  org_id: z
    .string()
    .uuid('Organization ID must be a valid UUID')
    .optional()
    .nullable(),

  label: labelField,

  credential_type: credentialTypeField,

  metadata: z
    .custom<Record<string, Json | undefined>>((val) => {
      if (val === null || val === undefined) return true;
      return typeof val === 'object' && !Array.isArray(val);
    }, 'Metadata must be a JSON object')
    .optional()
    .nullable(),

  parent_anchor_id: z
    .string()
    .uuid('Parent anchor ID must be a valid UUID')
    .optional()
    .nullable(),

  description: z
    .string()
    .max(500, 'Description must be 500 characters or less')
    .optional()
    .nullable(),
});

export type AnchorCreate = z.infer<typeof AnchorCreateSchema>;

/**
 * Schema for updating an anchor (user-editable fields only)
 *
 * Users cannot update:
 * - user_id (owner)
 * - status (managed by system)
 * - chain_* fields (set when secured)
 * - legal_hold (admin only)
 * - fingerprint (immutable identifier)
 */
export const AnchorUpdateSchema = z.object({
  filename: filenameField.optional(),

  file_mime: fileMimeField,

  retention_until: z
    .string()
    .datetime({ message: 'retention_until must be a valid ISO datetime' })
    .optional()
    .nullable(),

  label: labelField,

  credential_type: credentialTypeField,

  metadata: z
    .record(z.unknown())
    .optional()
    .nullable(),

  // Soft delete
  deleted_at: z
    .string()
    .datetime({ message: 'deleted_at must be a valid ISO datetime' })
    .optional()
    .nullable(),
});

export type AnchorUpdate = z.infer<typeof AnchorUpdateSchema>;

// =============================================================================
// PROFILE SCHEMAS
// =============================================================================

/**
 * Schema for updating a profile (user-editable fields only)
 *
 * Users cannot update:
 * - id (immutable)
 * - email (managed by auth)
 * - role (immutable once set)
 * - role_set_at (system managed)
 * - org_id (admin managed)
 * - requires_manual_review (admin managed)
 * - manual_review_* fields (admin managed)
 */
export const ProfileUpdateSchema = z.object({
  full_name: z
    .string()
    .max(255, 'Full name must be 255 characters or less')
    .optional()
    .nullable(),

  avatar_url: z
    .string()
    .url('Avatar URL must be a valid URL')
    .max(2048, 'Avatar URL must be 2048 characters or less')
    .optional()
    .nullable(),
});

export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;

// =============================================================================
// AUDIT EVENT SCHEMAS
// =============================================================================

/**
 * Valid audit event categories
 */
export const AUDIT_EVENT_CATEGORIES = [
  'AUTH',
  'ANCHOR',
  'PROFILE',
  'ORG',
  'ADMIN',
  'SYSTEM',
] as const;

export type AuditEventCategory = (typeof AUDIT_EVENT_CATEGORIES)[number];

/**
 * Schema for creating an audit event
 */
export const AuditEventCreateSchema = z.object({
  event_type: z
    .string()
    .min(1, 'Event type is required')
    .max(100, 'Event type must be 100 characters or less'),

  event_category: z.enum(AUDIT_EVENT_CATEGORIES, {
    errorMap: () => ({
      message: `Event category must be one of: ${AUDIT_EVENT_CATEGORIES.join(', ')}`,
    }),
  }),

  target_type: z
    .string()
    .max(50, 'Target type must be 50 characters or less')
    .optional()
    .nullable(),

  target_id: z
    .string()
    .uuid('Target ID must be a valid UUID')
    .optional()
    .nullable(),

  org_id: z
    .string()
    .uuid('Organization ID must be a valid UUID')
    .optional()
    .nullable(),

  details: z
    .string()
    .max(MAX_DETAILS_LENGTH, `Details must be ${MAX_DETAILS_LENGTH} characters or less`)
    .optional()
    .nullable(),
});

export type AuditEventCreate = z.infer<typeof AuditEventCreateSchema>;

// =============================================================================
// ORGANIZATION SCHEMAS
// =============================================================================

/**
 * EIN (Employer Identification Number) regex
 * Format: XX-XXXXXXX (2 digits, hyphen, 7 digits)
 * Standard US federal tax ID issued by the IRS.
 */
const EIN_REGEX = /^\d{2}-\d{7}$/;

/**
 * Domain regex: lowercase letters/numbers, dots, hyphens, valid TLD
 */
const DOMAIN_REGEX = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;

/**
 * Schema for updating an organization (ORG_ADMIN fields)
 */
/** Validates that a URL uses https:// protocol only (prevents javascript: XSS) */
const safeUrlSchema = z
  .string()
  .url('Must be a valid URL')
  .refine((val) => /^https?:\/\//i.test(val), 'URL must use https:// or http://')
  .optional()
  .nullable();

/**
 * Schema for validating an EIN (Employer Identification Number)
 * Accepts XX-XXXXXXX format (e.g., 12-3456789)
 */
export const EinSchema = z
  .string()
  .regex(EIN_REGEX, 'EIN must be in XX-XXXXXXX format (e.g., 12-3456789)')
  .optional()
  .nullable();

export type Ein = z.infer<typeof EinSchema>;

/**
 * Validate an EIN string, returning normalized value or null if invalid/empty
 */
export function validateEin(ein: string | null | undefined): string | null {
  if (!ein) return null;
  const trimmed = ein.trim();
  if (!EIN_REGEX.test(trimmed)) return null;
  return trimmed;
}

export const OrganizationUpdateSchema = z.object({
  display_name: z
    .string()
    .min(1, 'Display name is required')
    .max(255, 'Display name must be 255 characters or less')
    .optional(),

  domain: z
    .string()
    .regex(DOMAIN_REGEX, 'Domain must be a valid lowercase domain (e.g., example.com)')
    .optional()
    .nullable(),

  description: z.string().max(2000).optional().nullable(),
  website_url: safeUrlSchema,
  linkedin_url: safeUrlSchema,
  twitter_url: safeUrlSchema,
  logo_url: safeUrlSchema,
  location: z.string().max(255).optional().nullable(),
  founded_date: z.string().optional().nullable(),
  org_type: z.string().optional().nullable(),
  industry_tag: z.string().optional().nullable(),
});

export type OrganizationUpdate = z.infer<typeof OrganizationUpdateSchema>;

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

/**
 * Validate and parse anchor creation data
 * @throws ZodError if validation fails
 */
export function validateAnchorCreate(data: unknown): AnchorCreate {
  return AnchorCreateSchema.parse(data);
}

/**
 * Validate and parse profile update data
 * @throws ZodError if validation fails
 */
export function validateProfileUpdate(data: unknown): ProfileUpdate {
  return ProfileUpdateSchema.parse(data);
}

/**
 * Validate a SHA-256 fingerprint
 * Returns normalized lowercase fingerprint or null if invalid
 */
export function normalizeFingerprint(fingerprint: string): string | null {
  if (!FINGERPRINT_REGEX.test(fingerprint)) {
    return null;
  }
  return fingerprint.toLowerCase();
}

/**
 * Check if a filename is valid
 */
export function isValidFilename(filename: string): boolean {
  if (!filename || filename.length > MAX_FILENAME_LENGTH) {
    return false;
  }
  if (CONTROL_CHARS_REGEX.test(filename)) {
    return false;
  }
  return true;
}

// =============================================================================
// METADATA VALIDATION (UF-05)
// =============================================================================

interface TemplateFieldDef {
  key: string;
  label: string;
  type: 'text' | 'date' | 'number' | 'select';
  required?: boolean;
  options?: string[];
}

/** Validate a single field value by type. Returns error message or null. */
function validateFieldType(value: string, field: TemplateFieldDef): string | null {
  switch (field.type) {
    case 'number':
      return Number.isNaN(Number(value)) ? `${field.label} must be a number` : null;
    case 'date':
      return Number.isNaN(Date.parse(value)) ? `${field.label} must be a valid date` : null;
    case 'select':
      if (field.options && !field.options.includes(value)) {
        return `${field.label} must be one of: ${field.options.join(', ')}`;
      }
      return null;
    default:
      return null;
  }
}

/**
 * Validate metadata values against a template's field definitions.
 * Returns a map of field key → error message for invalid fields.
 * Empty map means all valid.
 */
export function validateMetadataAgainstTemplate(
  values: Record<string, string>,
  fields: TemplateFieldDef[],
): Record<string, string> {
  const errors: Record<string, string> = {};

  for (const field of fields) {
    const value = values[field.key]?.trim() ?? '';

    if (field.required && !value) {
      errors[field.key] = `${field.label} is required`;
      continue;
    }

    if (!value) continue;

    const typeError = validateFieldType(value, field);
    if (typeError) errors[field.key] = typeError;
  }

  return errors;
}
