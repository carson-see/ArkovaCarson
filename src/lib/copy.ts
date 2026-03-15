/**
 * UI Copy Strings for Arkova
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
  REVOCATION_REASON: 'Reason for Revocation',
  REVOCATION_REASON_PLACEHOLDER: 'Describe why this record is being revoked (optional)',
  CREDENTIAL_TYPE: 'Credential Type',
  CREDENTIAL_TYPE_PLACEHOLDER: 'Select a credential type',
  LABEL: 'Label',
  LABEL_PLACEHOLDER: 'Enter a descriptive label for this credential',
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
// TOAST NOTIFICATIONS
// =============================================================================

export const TOAST = {
  // Profile
  PROFILE_UPDATED: 'Profile updated successfully.',
  PROFILE_UPDATE_FAILED: 'Failed to update profile. Please try again.',

  // Organization
  ORG_UPDATED: 'Organization updated successfully.',
  ORG_UPDATE_FAILED: 'Failed to update organization. Please try again.',

  // Anchoring
  ANCHOR_SUBMITTED: 'Your document has been submitted for securing.',
  ANCHOR_FAILED: 'Failed to secure document. Please try again.',

  // Records fetch
  RECORDS_FETCH_FAILED: 'Failed to load records. Please try again.',

  // Credentials
  CREDENTIAL_ISSUED: 'Credential issued successfully.',
  CREDENTIAL_ISSUE_FAILED: 'Failed to issue credential. Please try again.',

  // Credential templates
  TEMPLATE_CREATED: 'Template created successfully.',
  TEMPLATE_CREATE_FAILED: 'Failed to create template. Please try again.',
  TEMPLATE_UPDATED: 'Template updated successfully.',
  TEMPLATE_UPDATE_FAILED: 'Failed to update template. Please try again.',
  TEMPLATE_DELETED: 'Template deleted successfully.',
  TEMPLATE_DELETE_FAILED: 'Failed to delete template. Please try again.',

  // Revoke
  ANCHOR_REVOKED: 'Record revoked successfully.',
  ANCHOR_REVOKE_FAILED: 'Failed to revoke record. Please try again.',

  // Members
  MEMBER_INVITED: 'Invitation sent successfully.',
  MEMBER_INVITE_FAILED: 'Failed to send invitation. Please try again.',

  // Bulk upload
  BULK_COMPLETE: 'Bulk upload complete — {created} records created.',
  BULK_PARTIAL: 'Bulk upload finished with issues — {created} created, {failed} failed.',
  BULK_FAILED: 'Bulk upload failed. Please try again.',
  BULK_CANCELLED: 'Bulk upload cancelled.',
  BULK_QUOTA_EXCEEDED: 'Upload exceeds your plan limit.',
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
// PUBLIC VERIFICATION PAGE
// =============================================================================

export const VERIFICATION_LABELS = {
  // Page
  PAGE_TITLE: 'Verify a Credential',
  PAGE_SUBTITLE: 'Check if a credential has been secured with Arkova. Upload the file or enter its fingerprint to verify authenticity.',
  FORM_TITLE: 'Credential Verification',
  FORM_SUBTITLE: 'Verify that a document matches a secured record',

  // Status badges
  STATUS_ACTIVE: 'Active',
  STATUS_REVOKED: 'Revoked',
  STATUS_EXPIRED: 'Expired',
  STATUS_SUPERSEDED: 'Superseded',

  // Section headings
  SECTION_STATUS: 'Verification Status',
  SECTION_CREDENTIAL: 'Credential Details',
  SECTION_TIMELINE: 'Timeline',
  SECTION_PROOF: 'Network Proof',
  SECTION_DOCUMENT: 'Document Information',

  // Field labels
  ISSUER: 'Issuer',
  RECIPIENT_ID: 'Recipient Identifier',
  CREDENTIAL_TYPE: 'Credential Type',
  JURISDICTION: 'Jurisdiction',
  ISSUED_DATE: 'Issued',
  EXPIRY_DATE: 'Expires',
  ANCHOR_TIMESTAMP: 'Network Observed Time',
  NETWORK_RECEIPT: 'Network Receipt',
  PROOF_FINGERPRINT: 'Merkle Proof',
  RECORD_URI: 'Verification Link',
  FINGERPRINT: 'Document Fingerprint (SHA-256)',
  FILENAME: 'Filename',
  FILE_SIZE: 'File Size',
  VERIFICATION_ID: 'Verification ID',

  // Status descriptions
  ACTIVE_DESC: 'This credential has been verified and is currently active.',
  REVOKED_DESC: 'This credential has been revoked and is no longer valid.',
  EXPIRED_DESC: 'This credential has passed its expiration date.',
  SUPERSEDED_DESC: 'This credential has been replaced by a newer version.',
  NOT_FOUND_TITLE: 'Verification Failed',
  NOT_FOUND_DESC: 'The credential you are looking for may not exist or has not been verified yet.',

  // Footer
  SECURED_BY: 'Secured by Arkova',
  RECIPIENT_HASH_NOTE: 'Hashed for privacy — not the original identifier.',
} as const;

// =============================================================================
// RECORDS LIST — SEARCH & PAGINATION
// =============================================================================

export const RECORDS_LIST_LABELS = {
  SEARCH_PLACEHOLDER: 'Search by filename or fingerprint...',
  FILTER_ALL: 'All Statuses',
  FILTER_PENDING: 'Pending',
  FILTER_SECURED: 'Secured',
  FILTER_REVOKED: 'Revoked',
  FILTER_EXPIRED: 'Expired',
  SHOWING_RESULTS: 'Showing {start}–{end} of {total} records',
  NO_RESULTS: 'No records match your search',
  NO_RESULTS_DESC: 'Try adjusting your search or filter criteria.',
  PAGE_SIZE_LABEL: 'per page',
} as const;

// =============================================================================
// ONBOARDING STEPPER
// =============================================================================

export const ONBOARDING_LABELS = {
  STEP_ROLE: 'Account Type',
  STEP_ORG: 'Organization',
  STEP_CONFIRM: 'Confirmation',
  STEP_ROLE_DESC: 'Choose your account type',
  STEP_ORG_DESC: 'Set up your organization',
  STEP_CONFIRM_DESC: 'Review and confirm',
  STEPPER_ARIA_LABEL: 'Onboarding progress',
} as const;

export const ONBOARDING_STEPS = [
  { label: ONBOARDING_LABELS.STEP_ROLE, description: ONBOARDING_LABELS.STEP_ROLE_DESC },
  { label: ONBOARDING_LABELS.STEP_ORG, description: ONBOARDING_LABELS.STEP_ORG_DESC },
  { label: ONBOARDING_LABELS.STEP_CONFIRM, description: ONBOARDING_LABELS.STEP_CONFIRM_DESC },
] as const;

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
// BILLING
// =============================================================================

export const BILLING_LABELS = {
  PAGE_TITLE: 'Billing & Plans',
  PAGE_DESCRIPTION: 'Manage your subscription and view available plans.',
  CHOOSE_PLAN: 'Choose a Plan',
  CHANGE_PLAN: 'Change Plan',
  PLAN_DESCRIPTION: 'Select the plan that best fits your needs. You can change plans at any time.',
  CHECKOUT_SUCCESS_TITLE: 'Subscription Activated',
  CHECKOUT_SUCCESS_DESC: 'Your subscription has been successfully set up. You can now access all features included in your plan.',
  LOADING_SUBSCRIPTION: 'Setting up your subscription...',
  YOUR_PLAN: 'Your Plan',
  GO_TO_DASHBOARD: 'Go to Dashboard',
  VIEW_BILLING: 'View Billing Details',
  CHECKOUT_CANCEL_TITLE: 'Checkout Cancelled',
  CHECKOUT_CANCEL_DESC: 'Your checkout was cancelled. No charges were made. You can try again whenever you are ready.',
  BACK_TO_PRICING: 'Back to Plans',
  MANAGE_SUBSCRIPTION: 'Manage Subscription',
  PLAN_CHANGE_VIA_PORTAL: 'To change or cancel your plan, you will be redirected to our secure billing portal.',
  CURRENT_PLAN_BADGE: 'Current Plan',
  DOWNGRADE_NOTE: 'Changes take effect at the end of your current billing period.',
  CANCELLATION_SCHEDULED: 'Your subscription is set to cancel at the end of the current period.',
} as const;

// =============================================================================
// API KEYS (P4.5 — deferred post-launch)
// =============================================================================

export const API_KEY_LABELS = {
  PAGE_TITLE: 'API Keys',
  PAGE_DESCRIPTION: 'Manage API keys for programmatic access to the Verification API.',
  COMING_SOON: 'Coming soon — the Verification API and API key management will be available after launch.',
} as const;

// =============================================================================
// ENTITLEMENTS / QUOTA
// =============================================================================

export const ENTITLEMENT_LABELS = {
  QUOTA_REACHED_TITLE: 'Monthly Limit Reached',
  QUOTA_REACHED_DESCRIPTION: 'You have used all of your records for this billing period. Upgrade your plan to continue securing documents.',
  QUOTA_NEAR_LIMIT: 'You are approaching your monthly limit.',
  UPGRADE_CTA: 'Upgrade Plan',
  RECORDS_REMAINING: 'records remaining this period',
  RECORDS_USED: 'records used',
  UNLIMITED: 'Unlimited',
  QUOTA_CHECK_FAILED: 'Unable to check your plan quota. Please try again.',
  BULK_EXCEEDS_QUOTA: 'This upload would exceed your monthly limit. You have {remaining} records remaining but are trying to create {requested}.',
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
