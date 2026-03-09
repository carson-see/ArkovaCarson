/**
 * UI Copy Strings for Ralph
 *
 * This file centralizes all user-facing copy to enforce terminology guidelines.
 *
 * TERMINOLOGY RULES:
 * - UI must NOT use: Wallet, Gas, Hash, Block, Transaction, Crypto
 * - UI must use: Vault, Anchor, Fingerprint, Record, Secure, Verify
 *
 * Internal DB/code may use technical names, but UI renders approved terms only.
 */

// =============================================================================
// ANCHOR STATUS
// =============================================================================

export const ANCHOR_STATUS_LABELS = {
  PENDING: 'Pending',
  SECURED: 'Secured',
  REVOKED: 'Revoked',
  EXPIRED: 'Expired',
} as const;

export const ANCHOR_STATUS_DESCRIPTIONS = {
  PENDING: 'Your record is being secured. This typically completes within a few minutes.',
  SECURED: 'Your record has been permanently secured with cryptographic verification.',
  REVOKED: 'This record has been revoked and is no longer active.',
  EXPIRED: 'This record has passed its expiration date.',
} as const;

// =============================================================================
// LIFECYCLE TIMELINE
// =============================================================================

export const LIFECYCLE_LABELS = {
  TITLE: 'Record Lifecycle',
  CREATED: 'Created',
  ISSUED: 'Issued',
  SECURED: 'Secured',
  REVOKED: 'Revoked',
  EXPIRED: 'Expired',
  REVOCATION_REASON: 'Reason',
  EXPIRES_ON: 'Expires',
} as const;

// =============================================================================
// CREDENTIAL TYPES
// =============================================================================

export const CREDENTIAL_TYPE_LABELS = {
  DEGREE: 'Degree',
  LICENSE: 'License',
  CERTIFICATE: 'Certificate',
  TRANSCRIPT: 'Transcript',
  PROFESSIONAL: 'Professional Credential',
  OTHER: 'Other',
} as const;

export const CREDENTIAL_TYPE_DESCRIPTIONS = {
  DEGREE: 'Academic degree (e.g., Bachelor\'s, Master\'s, Doctorate)',
  LICENSE: 'Professional or occupational license',
  CERTIFICATE: 'Certificate of completion or achievement',
  TRANSCRIPT: 'Academic transcript or record of courses',
  PROFESSIONAL: 'Professional certification or accreditation',
  OTHER: 'Other credential type',
} as const;

// =============================================================================
// USER ROLES
// =============================================================================

export const USER_ROLE_LABELS = {
  INDIVIDUAL: 'Individual',
  ORG_ADMIN: 'Organization Administrator',
} as const;

export const USER_ROLE_DESCRIPTIONS = {
  INDIVIDUAL: 'Personal account for securing your documents.',
  ORG_ADMIN: 'Administrator account with access to organization records.',
} as const;

// =============================================================================
// IDENTITY
// =============================================================================

export const IDENTITY_LABELS = {
  USER_ID: 'User ID',
  USER_ID_DESC: 'Your unique identifier. Share this instead of your name to stay anonymous.',
  ORG_ID: 'Organization ID',
  ORG_ID_DESC: 'Your organization\'s unique identifier for searchable verification.',
} as const;

// =============================================================================
// ACTIONS
// =============================================================================

export const ACTION_LABELS = {
  CREATE_ANCHOR: 'Secure Document',
  VIEW_ANCHOR: 'View Record',
  VERIFY_ANCHOR: 'Verify Record',
  REVOKE_ANCHOR: 'Revoke Record',
  DOWNLOAD_PROOF: 'Download Proof',
} as const;

// =============================================================================
// NAVIGATION
// =============================================================================

export const NAV_LABELS = {
  DASHBOARD: 'Dashboard',
  MY_RECORDS: 'My Records',
  ORGANIZATION: 'Organization',
  SETTINGS: 'Settings',
  HELP: 'Help',
} as const;

// =============================================================================
// FORM LABELS
// =============================================================================

export const FORM_LABELS = {
  FILE_SELECT: 'Select Document',
  FILE_DRAG: 'Drag and drop your document here',
  FINGERPRINT: 'Document Fingerprint',
  FILENAME: 'File Name',
  FILE_SIZE: 'File Size',
  CREATED_AT: 'Created',
  SECURED_AT: 'Secured',
  ISSUED_AT: 'Issued',
  REVOKED_AT: 'Revoked',
  EXPIRES_AT: 'Expires',
} as const;

// =============================================================================
// MESSAGES
// =============================================================================

export const MESSAGES = {
  // Success
  ANCHOR_CREATED: 'Your document has been submitted for securing.',
  ANCHOR_SECURED: 'Your document has been permanently secured.',
  ANCHOR_VERIFIED: 'Document verification successful.',

  // Errors
  ANCHOR_FAILED: 'Failed to secure document. Please try again.',
  VERIFICATION_FAILED: 'Document verification failed. The fingerprint does not match.',
  UPLOAD_ERROR: 'Failed to process document. Please ensure it is a valid file.',

  // Info
  PROCESSING: 'Processing your document...',
  FINGERPRINT_INFO: 'A unique fingerprint is calculated from your document. Your document never leaves your device.',
  SECURE_INFO: 'Securing creates a permanent, tamper-proof record of your document.',
} as const;

// =============================================================================
// EMPTY STATES
// =============================================================================

export const EMPTY_STATES = {
  NO_RECORDS: 'No records yet',
  NO_RECORDS_DESC: 'Secure your first document to create a permanent record.',
  NO_ORG_RECORDS: 'No organization records',
  NO_ORG_RECORDS_DESC: 'Your organization has no secured documents yet.',
} as const;

// =============================================================================
// TOOLTIPS
// =============================================================================

export const TOOLTIPS = {
  FINGERPRINT: 'A cryptographic fingerprint uniquely identifies your document without storing its contents.',
  SECURED: 'This record has been permanently anchored with cryptographic verification.',
  LEGAL_HOLD: 'This record is under legal hold and cannot be deleted.',
  VERIFICATION: 'Verify that a document matches a secured record.',
} as const;

// =============================================================================
// FORBIDDEN TERMS (for lint script)
// =============================================================================

/**
 * Terms that should NEVER appear in UI copy.
 * The lint:copy script checks for these.
 */
export const FORBIDDEN_TERMS = [
  'wallet',
  'gas',
  'hash',
  'block',
  'transaction',
  'crypto',
  'cryptocurrency',
  'bitcoin',
  'blockchain',
  'mining',
  'token',
] as const;

/**
 * Approved replacement terms.
 */
export const TERM_REPLACEMENTS: Record<string, string> = {
  wallet: 'vault',
  gas: '(remove or rephrase)',
  hash: 'fingerprint',
  block: 'record',
  transaction: 'record',
  crypto: 'secure',
  cryptocurrency: '(remove)',
  bitcoin: '(remove)',
  blockchain: '(remove or rephrase)',
  mining: '(remove)',
  token: '(remove or rephrase)',
};
