/**
 * Shared HIPAA constants — used by hipaa-audit.ts, emergency-access.ts, verify.ts.
 * Single source of truth for HIPAA-related enum values.
 */

/** Credential types that trigger HIPAA controls (MFA enforcement, audit logging, emergency access) */
export const HIPAA_HEALTHCARE_TYPES = [
  'INSURANCE', 'MEDICAL', 'MEDICAL_LICENSE', 'IMMUNIZATION',
] as const;

/** Maximum emergency access grant duration in hours */
export const EMERGENCY_ACCESS_MAX_HOURS = 4;
