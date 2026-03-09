/**
 * Zod validators for Ralph
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
  'OTHER',
] as const;

export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

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

  filename: z
    .string()
    .min(1, 'Filename is required')
    .max(MAX_FILENAME_LENGTH, `Filename must be ${MAX_FILENAME_LENGTH} characters or less`)
    .refine(
      (val) => !CONTROL_CHARS_REGEX.test(val),
      'Filename must not contain control characters'
    ),

  file_size: z
    .number()
    .int('File size must be an integer')
    .positive('File size must be positive')
    .optional()
    .nullable(),

  file_mime: z
    .string()
    .max(100, 'MIME type must be 100 characters or less')
    .optional()
    .nullable(),

  org_id: z
    .string()
    .uuid('Organization ID must be a valid UUID')
    .optional()
    .nullable(),

  label: z
    .string()
    .min(1, 'Label is required')
    .max(MAX_LABEL_LENGTH, `Label must be ${MAX_LABEL_LENGTH} characters or less`)
    .optional()
    .nullable(),

  credential_type: z
    .enum(CREDENTIAL_TYPES, {
      errorMap: () => ({
        message: `Credential type must be one of: ${CREDENTIAL_TYPES.join(', ')}`,
      }),
    })
    .optional()
    .nullable(),

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
  filename: z
    .string()
    .min(1, 'Filename is required')
    .max(MAX_FILENAME_LENGTH, `Filename must be ${MAX_FILENAME_LENGTH} characters or less`)
    .refine(
      (val) => !CONTROL_CHARS_REGEX.test(val),
      'Filename must not contain control characters'
    )
    .optional(),

  file_mime: z
    .string()
    .max(100, 'MIME type must be 100 characters or less')
    .optional()
    .nullable(),

  retention_until: z
    .string()
    .datetime({ message: 'retention_until must be a valid ISO datetime' })
    .optional()
    .nullable(),

  label: z
    .string()
    .min(1, 'Label is required')
    .max(MAX_LABEL_LENGTH, `Label must be ${MAX_LABEL_LENGTH} characters or less`)
    .optional()
    .nullable(),

  credential_type: z
    .enum(CREDENTIAL_TYPES, {
      errorMap: () => ({
        message: `Credential type must be one of: ${CREDENTIAL_TYPES.join(', ')}`,
      }),
    })
    .optional()
    .nullable(),

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
 * Domain regex: lowercase letters/numbers, dots, hyphens, valid TLD
 */
const DOMAIN_REGEX = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;

/**
 * Schema for updating an organization (ORG_ADMIN fields)
 */
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
