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
  SUBMITTED: 'Awaiting Confirmation',
  SECURED: 'Secured',
  REVOKED: 'Revoked',
  EXPIRED: 'Expired',
} as const;

export const ANCHOR_STATUS_DESCRIPTIONS = {
  PENDING: 'Your record is being secured. This typically completes within a few minutes.',
  SUBMITTED: 'Your record has been submitted to the network and is awaiting confirmation.',
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
  SUBMITTED: 'Submitted to Network',
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
  CLE: 'CLE Credit',
  BADGE: 'Digital Badge',
  ATTESTATION: 'Attestation',
  FINANCIAL: 'Financial Document',
  LEGAL: 'Legal Document',
  INSURANCE: 'Insurance Certificate',
  SEC_FILING: 'SEC Filing',
  PATENT: 'Patent',
  REGULATION: 'Regulation',
  PUBLICATION: 'Publication',
  CHARITY: 'Charity',
  FINANCIAL_ADVISOR: 'Financial Advisor',
  BUSINESS_ENTITY: 'Business Entity',
  RESUME: 'Resume / CV',
  MEDICAL: 'Medical Record',
  MILITARY: 'Military Record',
  IDENTITY: 'Identity Document',
  OTHER: 'Other',
} as const;

/** Map raw credential_type DB value to display label with fallback to title case. */
export function formatCredentialType(raw: string | null | undefined): string {
  if (!raw) return '—';
  const upper = raw.replace(/-/g, '_').toUpperCase();
  if (upper in CREDENTIAL_TYPE_LABELS) return CREDENTIAL_TYPE_LABELS[upper as keyof typeof CREDENTIAL_TYPE_LABELS];
  return raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export const CREDENTIAL_TYPE_DESCRIPTIONS = {
  DEGREE: 'Academic degree (e.g., Bachelor\'s, Master\'s, Doctorate)',
  LICENSE: 'Professional or occupational license',
  CERTIFICATE: 'Certificate of completion or achievement',
  TRANSCRIPT: 'Academic transcript or record of courses',
  PROFESSIONAL: 'Professional certification or accreditation',
  CLE: 'Continuing Legal Education credit',
  BADGE: 'Digital badge or micro-credential (e.g., Credly, Acclaim)',
  ATTESTATION: 'Employment verification, reference letter, or sworn attestation',
  FINANCIAL: 'Financial statement, audit report, or tax document',
  LEGAL: 'Contract, court order, legal brief, or agreement',
  INSURANCE: 'Certificate of insurance, bond, or policy document',
  SEC_FILING: 'SEC regulatory filing (10-K, 8-K, DEF 14A, etc.)',
  PATENT: 'Intellectual property patent',
  REGULATION: 'Government regulation or notice',
  PUBLICATION: 'Academic publication or research paper',
  CHARITY: 'Registered charity or nonprofit organization',
  FINANCIAL_ADVISOR: 'Financial advisor registration or license',
  BUSINESS_ENTITY: 'Business registration or entity record',
  RESUME: 'Resume, CV, or professional profile',
  MEDICAL: 'Medical record, lab result, or health document',
  MILITARY: 'Military service record or discharge document',
  IDENTITY: 'Government-issued ID, passport, or identity verification',
  OTHER: 'Unclassified document',
} as const;

/**
 * Anonymized template descriptions for public-facing anchor metadata.
 * These replace raw file details with privacy-safe summaries.
 */
export const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  DEGREE: 'Verified Academic Credential',
  LICENSE: 'Verified Professional License',
  CERTIFICATE: 'Verified Certificate of Achievement',
  TRANSCRIPT: 'Verified Academic Record',
  PROFESSIONAL: 'Verified Professional Credential',
  CLE: 'Verified Continuing Education Credit',
  BADGE: 'Verified Digital Badge',
  ATTESTATION: 'Verified Attestation Document',
  FINANCIAL: 'Verified Financial Document',
  LEGAL: 'Verified Legal Document',
  INSURANCE: 'Verified Insurance Certificate',
  SEC_FILING: 'Public Regulatory Filing',
  PATENT: 'Verified Intellectual Property Record',
  REGULATION: 'Public Government Record',
  PUBLICATION: 'Verified Academic Publication',
  CHARITY: 'Verified Nonprofit Record',
  FINANCIAL_ADVISOR: 'Verified Financial Advisor Record',
  BUSINESS_ENTITY: 'Verified Business Entity Record',
  RESUME: 'Verified Professional History Document',
  MEDICAL: 'Verified Health Record',
  MILITARY: 'Verified Service Record',
  IDENTITY: 'Verified Identity Document',
  OTHER: 'General Record',
} as const;

/** Get anonymized template description for a credential type */
export function getTemplateDescription(credentialType: string | null | undefined): string {
  if (!credentialType) return 'General Record';
  const upper = credentialType.replace(/-/g, '_').toUpperCase();
  return TEMPLATE_DESCRIPTIONS[upper] ?? 'General Record';
}

/** Standardized industry tag labels for organization profiles */
export const INDUSTRY_TAG_LABELS: Record<string, string> = {
  higher_ed: 'Higher Ed',
  legal_tech: 'Legal Tech',
  fintech: 'FinTech',
  healthcare: 'Healthcare',
  government: 'Government',
  insurance: 'Insurance',
  real_estate: 'Real Estate',
  accounting: 'Accounting',
  human_resources: 'Human Resources',
  cybersecurity: 'Cybersecurity',
  energy: 'Energy',
  manufacturing: 'Manufacturing',
  retail: 'Retail',
  media: 'Media',
  nonprofit: 'Nonprofit',
  consulting: 'Consulting',
  aerospace: 'Aerospace',
  biotech: 'Biotech',
  other: 'Other',
} as const;

/** Industry tag options for select inputs */
export const INDUSTRY_TAG_OPTIONS = Object.entries(INDUSTRY_TAG_LABELS).map(
  ([value, label]) => ({ value, label }),
);

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
  DOCUMENTS: 'Documents',
  MY_RECORDS: 'My Records',
  ORGANIZATION: 'Organization',
  DIRECTORY: 'Directory',
  SETTINGS: 'Settings',
  HELP: 'Help',
  SEARCH: 'Search',
  TREASURY: 'Treasury',
  COMPLIANCE: 'Compliance',
} as const;

export const DOCUMENTS_PAGE_LABELS = {
  PAGE_TITLE: 'Documents',
  PAGE_SUBTITLE: 'All your records, credentials, and attestations in one place.',
  TAB_ALL: 'All',
  TAB_RECORDS: 'My Records',
  TAB_CREDENTIALS: 'Issued to Me',
  TAB_ATTESTATIONS: 'Attestations',
  EMPTY_TITLE: 'No documents yet',
  EMPTY_DESC: 'Secure your first document, receive a credential, or create an attestation to get started.',
  SECURE_DOCUMENT: 'Secure Document',
  NO_MATCHING: 'No results found',
  NO_MATCHING_DESC: 'No documents match your current search or filter. Try adjusting your criteria.',
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
  FILTER_SUBMITTED: 'Awaiting Confirmation',
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
  STEP_PLAN: 'Choose Plan',
  STEP_CONFIRM: 'Confirmation',
  STEP_ROLE_DESC: 'Choose your account type',
  STEP_ORG_DESC: 'Set up your organization',
  STEP_PLAN_DESC: 'Select your subscription plan',
  STEP_CONFIRM_DESC: 'Review and confirm',
  STEPPER_ARIA_LABEL: 'Onboarding progress',
  WELCOME_TITLE: 'Welcome to Arkova',
  ORG_MEMBERSHIP_DESC: 'Organization membership',
  CHOOSE_PLAN_DESC: 'Choose your plan',
  FOUND_ORG_DESC: 'We found your organization',
  CHOOSE_ROLE_DESC: 'Choose how you\'ll use the platform',
  ERROR_GENERIC: 'Something went wrong. Please try again.',
  ERROR_ONBOARDING: 'Something went wrong during onboarding. Please try again.',
} as const;

export const ONBOARDING_STEPS = [
  { label: ONBOARDING_LABELS.STEP_ROLE, description: ONBOARDING_LABELS.STEP_ROLE_DESC },
  { label: ONBOARDING_LABELS.STEP_ORG, description: ONBOARDING_LABELS.STEP_ORG_DESC },
  { label: ONBOARDING_LABELS.STEP_PLAN, description: ONBOARDING_LABELS.STEP_PLAN_DESC },
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
  CREATE_KEY: 'Create API Key',
  KEY_NAME_LABEL: 'Key Name',
  KEY_NAME_PLACEHOLDER: 'e.g., Production, Staging',
  SCOPES_LABEL: 'Permissions',
  EXPIRY_LABEL: 'Expires In (days)',
  EXPIRY_PLACEHOLDER: 'Never (leave blank)',
  KEY_CREATED_TITLE: 'API Key Created',
  KEY_CREATED_WARNING: 'Copy this key now. It will not be shown again.',
  REVOKE_KEY: 'Revoke',
  DELETE_KEY: 'Delete',
  CONFIRM_REVOKE: 'Are you sure you want to revoke this key? It will immediately stop working.',
  CONFIRM_DELETE: 'Are you sure you want to permanently delete this key? This cannot be undone.',
  NO_KEYS: 'No API keys yet. Create one to get started with the Verification API.',
  ACTIVE: 'Active',
  REVOKED: 'Revoked',
  EXPIRED: 'Expired',
  LAST_USED: 'Last used',
  NEVER_USED: 'Never used',
  FETCH_ERROR: 'Unable to load API keys. Ensure the worker service is running.',
  SCOPE_VERIFY: 'Verify',
  SCOPE_BATCH: 'Batch',
  SCOPE_USAGE: 'Usage',
  USAGE_TITLE: 'API Usage',
  USAGE_DESCRIPTION: 'Monitor your Verification API usage for the current billing period.',
  REQUESTS_USED: 'requests used',
  REQUESTS_REMAINING: 'requests remaining',
  MONTHLY_LIMIT: 'Monthly Limit',
  UNLIMITED_TIER: 'Unlimited',
  RESET_DATE: 'Resets on',
  PER_KEY_BREAKDOWN: 'Usage by Key',
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
// CREDENTIAL RENDERER
// =============================================================================

export const CREDENTIAL_RENDERER_LABELS = {
  CREDENTIAL_DETAILS: 'Credential Details',
  DOCUMENT_RECORD: 'Document Record',
  NO_TEMPLATE: 'Record Details',
  ISSUED_BY: 'Issued by',
  ISSUED_ON: 'Issued',
  EXPIRES_ON: 'Expires',
  STATUS: 'Status',
  FINGERPRINT_LABEL: 'Document Fingerprint',
  FINGERPRINT_TOOLTIP: 'This is the document\'s unique digital fingerprint — a cryptographic proof that identifies this exact file.',
  NO_METADATA: 'No additional details available for this record.',
  COPY_FINGERPRINT: 'Copy fingerprint',
  COPIED: 'Copied',
} as const;

// =============================================================================
// SECURE DOCUMENT DIALOG
// =============================================================================

export const SECURE_DIALOG_LABELS = {
  TITLE: 'Secure Document',
  DESCRIPTION: 'Create a permanent, tamper-proof record of your document.',
  READY_TO_SECURE: 'Ready to Secure',
  DOCUMENT_LABEL: 'Document',
  SIZE_LABEL: 'Size',
  SECURITY_NOTICE: 'Your document will be secured with cryptographic verification. This creates a permanent record that can be verified at any time.',
  SECURING_LOADING: 'Securing your document...',
  VERIFICATION_LINK: 'Verification Link',
  SECURING_FAILED: 'Securing Failed',
  CANCEL: 'Cancel',
  CONTINUE: 'Continue',
  BACK: 'Back',
  SECURE_BUTTON: 'Secure Document',
  TRY_AGAIN: 'Try Again',
  COPY_LINK_ARIA: 'Copy verification link',
  AI_FIELDS: 'AI Fields',
  SKIP_AI_ANALYSIS: 'Skip AI Analysis',
} as const;

// =============================================================================
// ISSUE CREDENTIAL FORM
// =============================================================================

export const ISSUE_CREDENTIAL_LABELS = {
  TITLE: 'Issue Credential',
  DESCRIPTION: 'Create a verifiable credential record for your organization.',
  PENDING_NOTICE: 'The credential will be created with Pending status and assigned a unique verification ID immediately.',
  ISSUING_LOADING: 'Issuing...',
  ISSUE_BUTTON: 'Issue Credential',
  VERIFICATION_LINK: 'Verification Link',
  COPY_LINK_ARIA: 'Copy verification link',
} as const;

// =============================================================================
// PUBLIC VERIFICATION DISPLAY
// =============================================================================

export const PUBLIC_VERIFICATION_LABELS = {
  VERIFICATION_FAILED: 'Verification Failed',
  UNABLE_TO_VERIFY: 'Unable to verify this document',
  NOT_FOUND_DESC: 'The document you are looking for may not exist or has not been verified yet.',
  RECORD_REVOKED: 'Record Revoked',
  RECORD_EXPIRED: 'Record Expired',
  DOCUMENT_VERIFIED: 'Document Verified',
  REVOKED_DESC: 'This record has been revoked by the issuing organization',
  EXPIRED_DESC: 'This record has passed its expiration date',
  VERIFIED_DESC: 'This document has been permanently secured',
  CRYPTOGRAPHIC_PROOF: 'Cryptographic Proof',
  FINGERPRINT_SHA256: 'Fingerprint (SHA-256)',
  NETWORK_RECEIPT: 'Network Receipt',
  NETWORK_RECORD: 'Network Record',
  OBSERVED_TIME: 'Observed Time',
  LIFECYCLE: 'Lifecycle',
  SECURED_BY: 'Secured by Arkova',
  COPY_FINGERPRINT_ARIA: 'Copy document fingerprint',
  COPY_RECEIPT_ARIA: 'Copy network receipt',
  REPORT_ISSUE: 'Report an Issue',
  REPORT_ISSUE_SUBJECT: 'Issue with credential',
} as const;

// =============================================================================
// ANCHORING STATUS (UF-04)
// =============================================================================

export const ANCHORING_STATUS_LABELS = {
  PENDING_TITLE: 'Anchoring In Progress',
  PENDING_SUBTITLE: 'Your document has been submitted for anchoring. This typically takes 5\u201315 minutes.',
  PENDING_PUBLIC_TITLE: 'Record Found \u2014 Anchoring In Progress',
  PENDING_PUBLIC_SUBTITLE: 'This record has been submitted and is being permanently secured. Anchoring is not yet complete.',
  PENDING_BADGE: 'Processing',
  PENDING_SINCE: 'Submitted {time} ago',
  SHARE_LINK_NOTE: 'You can share this verification link now \u2014 verifiers will see the current anchoring status.',
  SUCCESS_TITLE: 'Document Submitted',
  SUCCESS_SUBTITLE: 'Your document has been submitted for anchoring.',
  SUCCESS_PROCESSING: 'Anchoring in progress \u2014 you\u2019ll see the network receipt shortly. Status updates appear on your dashboard in real time.',
  COPY_LINK: 'Copy Verification Link',
  LINK_COPIED: 'Verification link copied to clipboard',
  VIEW_RECORD: 'View Record',
  ISSUE_ANOTHER: 'Issue Another',
  DONE: 'Done',
} as const;

// =============================================================================
// METADATA FIELD RENDERER (UF-05)
// =============================================================================

export const METADATA_FIELD_LABELS = {
  SECTION_TITLE: 'Credential Details',
  REQUIRED_MARKER: '*',
  OPTIONAL: '(optional)',
  SELECT_PLACEHOLDER: 'Select...',
  FILE_PREVIEW_TITLE: 'Document Preview',
  FILE_NAME: 'Filename',
  FILE_SIZE: 'Size',
  FINGERPRINT_PREVIEW: 'Fingerprint',
  NO_TEMPLATE: 'No template found for this credential type. Metadata fields will be available after a template is created.',
  LOADING_TEMPLATE: 'Loading template fields...',
  RECIPIENT_EMAIL: 'Recipient Email',
  RECIPIENT_EMAIL_PLACEHOLDER: 'recipient@example.com',
  RECIPIENT_EMAIL_DESCRIPTION: 'The recipient will be able to view this credential in their inbox.',
} as const;

// =============================================================================
// PUBLIC SEARCH (UF-02)
// =============================================================================

export const SEARCH_LABELS = {
  PAGE_TITLE: 'Search Credentials',
  PAGE_SUBTITLE: 'Find verified credentials by issuer, verification ID, or document fingerprint.',
  SEARCH_PLACEHOLDER: 'Search by issuer name or verification ID...',
  SEARCH_BY_ID: 'Verification ID',
  SEARCH_BY_ISSUER: 'Issuer',
  SEARCH_BY_FINGERPRINT: 'Fingerprint',
  FINGERPRINT_PLACEHOLDER: 'Paste a 64-character document fingerprint...',
  SEARCH_BUTTON: 'Search',
  NO_RESULTS: 'No credentials found',
  NO_RESULTS_DESC: 'No public credentials match your search.',
  NO_ISSUERS: 'No issuers found',
  NO_ISSUERS_DESC: 'No public issuers match your search.',
  ISSUER_REGISTRY_TITLE: 'Issuer Registry',
  CREDENTIALS_COUNT: '{count} verified credentials',
  VIEW_REGISTRY: 'View Credentials',
  VERIFY_LINK: 'Verify',
  ISSUED_ON: 'Issued',
  SEARCH_TYPE: 'Search Type',
  RECIPIENT_COMING_SOON: 'Recipient search coming soon',
  LOADING: 'Searching...',
  FINGERPRINT_VERIFIED: 'Document Verified',
  FINGERPRINT_VERIFIED_DESC: 'This document has been secured with Arkova.',
  FINGERPRINT_REVOKED: 'Record Revoked',
  FINGERPRINT_REVOKED_DESC: 'This document was previously secured but has been revoked.',
  FINGERPRINT_NOT_FOUND: 'No Record Found',
  FINGERPRINT_NOT_FOUND_DESC: 'No secured record matches this fingerprint.',
  FINGERPRINT_INVALID: 'Invalid fingerprint format. Enter a valid 64-character fingerprint.',
  VIEW_FULL_RECORD: 'View Full Record',
  SEARCH_BY_PERSON: 'Person',
  PERSON_PLACEHOLDER: 'Search by name...',
  NO_PERSONS: 'No matching records found',
  NO_PERSONS_DESC: 'No public credentials match this name.',
  PERSON_CREDENTIALS: 'Verified Credentials',
} as const;

// =============================================================================
// USAGE WIDGET (UF-06)
// =============================================================================

export const USAGE_LABELS = {
  TITLE: 'Monthly Usage',
  RECORDS_USED: '{used} of {limit} records used',
  RECORDS_UNLIMITED: 'Unlimited records',
  CREDITS_REMAINING: '{count} credits remaining',
  RESETS_ON: 'Resets on {date}',
  WARNING_80: 'You have used 80% of your monthly records. Upgrade for more.',
  WARNING_100: 'Monthly record limit reached. Upgrade to continue securing documents.',
  UPGRADE_CTA: 'Upgrade Plan',
  FREE_LIMIT: '{used} of {limit} records used \u2014 upgrade for more',
} as const;

// =============================================================================
// ENHANCED VERIFICATION DISPLAY (UF-07)
// =============================================================================

export const VERIFICATION_DISPLAY_LABELS = {
  ISSUER_SECTION: 'Issuer',
  VIEW_ISSUER_REGISTRY: 'View all credentials from this issuer',
  REVOCATION_SECTION: 'Revocation Details',
  REVOCATION_REASON: 'Reason',
  REVOCATION_DATE: 'Revoked',
  REVOCATION_RECEIPT: 'Network Receipt',
  DOWNLOAD_PROOF: 'Download Proof',
  DOWNLOAD_JSON: 'JSON Proof Package',
  DOWNLOAD_PDF: 'PDF Summary',
  FINGERPRINT_TOOLTIP: 'This is the document\u2019s unique digital fingerprint \u2014 a cryptographic proof that identifies this exact file.',
  EXPLORER_TOOLTIP: 'View the network receipt for this anchor',
  NO_REVOCATION_REASON: 'No reason provided',
} as const;

// =============================================================================
// MY CREDENTIALS / RECIPIENT INBOX (UF-03)
// =============================================================================

export const MY_CREDENTIALS_LABELS = {
  PAGE_TITLE: 'My Credentials',
  PAGE_SUBTITLE: 'Credentials issued to you by organizations.',
  NAV_LABEL: 'My Credentials',
  EMPTY_TITLE: 'No credentials yet',
  EMPTY_DESC: 'When organizations issue credentials to your email address, they will appear here.',
  ISSUED_BY: 'Issued by',
  RECEIVED_ON: 'Received',
  VIEW_CREDENTIAL: 'View',
  VERIFY_CREDENTIAL: 'Verify',
  CLAIMED: 'Claimed',
  UNCLAIMED: 'Pending',
  CREDENTIAL_COUNT: '{count} credentials',
} as const;

// =============================================================================
// SHARE FLOW (UF-08)
// =============================================================================

export const SHARE_LABELS = {
  SHARE_BUTTON: 'Share',
  SHARE_TITLE: 'Share Credential',
  SHARE_DESCRIPTION: 'Share the verification link for this credential.',
  COPY_LINK: 'Copy Verification Link',
  LINK_COPIED: 'Verification link copied to clipboard',
  COPIED_TOAST: 'Copied to clipboard',
  QR_CODE: 'QR Code',
  QR_DESCRIPTION: 'Scan to verify this credential',
  EMAIL_SHARE: 'Share via Email',
  EMAIL_SUBJECT: 'Verify my credential on Arkova',
  CLOSE: 'Close',
} as const;

// =============================================================================
// LINKEDIN SHARE (BETA-09)
// =============================================================================

export const LINKEDIN_LABELS = {
  SHARE_BUTTON: 'Share on LinkedIn',
  SHARE_TEXT_WITH_TYPE: 'My {type} has been independently verified on Arkova. Verify it here:',
  SHARE_TEXT_DEFAULT: 'My credential has been independently verified on Arkova. Verify it here:',
  GET_BADGE: 'Get Badge',
  BADGE_TITLE: 'Verification Badge',
  BADGE_DESCRIPTION: 'Embed this badge in your LinkedIn profile or website to showcase your verified credential.',
  EMBED_CODE: 'Embed Code',
  COPY_SNIPPET: 'Copy Snippet',
  SNIPPET_COPIED: 'Badge snippet copied to clipboard',
} as const;

// =============================================================================
// EXPLORER / NETWORK RECEIPT (BETA-11)
// =============================================================================

export const EXPLORER_LABELS = {
  VIEW_ON_NETWORK: 'View on Network',
  NETWORK_RECEIPT: 'Network Receipt',
  CONFIRMED_AT_HEIGHT: 'Confirmed at height',
  REVOCATION_RECEIPT: 'Revocation Receipt',
} as const;

// =============================================================================
// DESCRIPTION (BETA-12)
// =============================================================================

export const DESCRIPTION_LABELS = {
  FIELD_LABEL: 'Description',
  FIELD_PLACEHOLDER: 'Brief description of what this credential represents (max 500 characters)',
  FIELD_HELP: 'This description will be permanently associated with your credential.',
} as const;

// =============================================================================
// REALTIME STATUS TOASTS (BETA-13)
// =============================================================================

export const REALTIME_TOAST_LABELS = {
  SECURED: 'Your credential has been secured on the network.',
  REVOKED: 'This credential has been revoked.',
  EXPIRED: 'This credential has expired.',
  SUBMITTED: 'Your credential has been submitted and is awaiting confirmation.',
} as const;

// =============================================================================
// NAVIGATION POLISH (UF-09)
// =============================================================================

export const NAV_POLISH_LABELS = {
  MANAGING_ORG: 'Managing',
  BREADCRUMB_HOME: 'Dashboard',
  BREADCRUMB_RECORDS: 'My Records',
  BREADCRUMB_ORGANIZATION: 'Organization',
  BREADCRUMB_SETTINGS: 'Settings',
  BREADCRUMB_BILLING: 'Billing',
  BREADCRUMB_HELP: 'Help',
  BREADCRUMB_CREDENTIAL_TEMPLATES: 'Credential Templates',
  BREADCRUMB_WEBHOOKS: 'Webhooks',
  BREADCRUMB_API_KEYS: 'API Keys',
  AUTH_REDIRECT_TOAST: 'Please sign in to access that page',
  SIGN_OUT: 'Sign Out',
  COLLAPSE: 'Collapse',
  PUBLIC_PROFILE_DESC_ON: 'When enabled, your name appears in public search results and your credential registry is visible. Your email and internal data are never exposed.',
  PUBLIC_PROFILE_DESC_OFF: 'Your profile is not visible in public search results.',
} as const;

// =============================================================================
// ONBOARDING GUIDANCE (UF-10)
// =============================================================================

export const ONBOARDING_GUIDANCE_LABELS = {
  WELCOME_TITLE: 'Welcome to Arkova',
  WELCOME_SUBTITLE: 'Get started in a few simple steps.',
  CHECKLIST_TITLE: 'Getting Started',
  CHECKLIST_DISMISS: 'Skip setup',
  // ORG_ADMIN steps
  STEP_TEMPLATE: 'Create a credential template',
  STEP_TEMPLATE_DESC: 'Define the fields for your credentials.',
  STEP_ISSUE: 'Issue your first credential',
  STEP_ISSUE_DESC: 'Secure a document and create a verifiable record.',
  STEP_BILLING: 'Set up billing',
  STEP_BILLING_DESC: 'Choose a plan to unlock more records.',
  // INDIVIDUAL steps
  STEP_SECURE: 'Secure your first document',
  STEP_SECURE_DESC: 'Create a permanent, tamper-proof record.',
  STEP_SHARE: 'Share your verification link',
  STEP_SHARE_DESC: 'Let others verify your credential.',
  // Empty states
  EMPTY_ORG_RECORDS: 'No credentials issued yet',
  EMPTY_ORG_RECORDS_DESC: 'Issue your first credential to get started.',
  EMPTY_ORG_RECORDS_CTA: 'Issue Credential',
  EMPTY_INDIVIDUAL_RECORDS: 'Your vault is empty',
  EMPTY_INDIVIDUAL_RECORDS_DESC: 'Secure your first document to create a permanent record.',
  EMPTY_INDIVIDUAL_RECORDS_CTA: 'Secure Document',
} as const;

// =============================================================================
// ORGANIZATION PAGE
// =============================================================================

export const ORG_PAGE_LABELS = {
  INVITE_MEMBER: 'Invite Member',
  BULK_UPLOAD: 'Bulk Upload',
  ISSUE_CREDENTIAL: 'Issue Credential',
  BULK_UPLOAD_DIALOG_TITLE: 'Bulk Upload',
  PROMOTE_TO_ADMIN: 'Promote to Admin',
  DEMOTE_TO_MEMBER: 'Demote to Member',
  RECIPIENT: 'Recipient',
} as const;

// =============================================================================
// MEMBER DETAIL PAGE
// =============================================================================

export const MEMBER_DETAIL_LABELS = {
  PAGE_TITLE: 'Member Details',
  BACK_TO_ORG: 'Back to Organization',
  PROFILE_SECTION: 'Profile',
  RECORDS_SECTION: 'Records by This Member',
  RECORDS_EMPTY: 'This member has not created any records yet.',
  ROLE: 'Role',
  EMAIL: 'Email',
  JOINED: 'Joined',
  MEMBER_ID: 'Member ID',
  STATUS: 'Status',
  MEMBER_NOT_FOUND: 'Member not found or you do not have access.',
} as const;

// =============================================================================
// AI EXTRACTION
// =============================================================================

export const AI_EXTRACTION_LABELS = {
  EXTRACT_BUTTON: 'Extract with AI',
  EXTRACTING: 'Analyzing...',
  EXTRACT_DESCRIPTION: 'Automatically extract credential fields from the uploaded document',
  EXTRACTION_FAILED_TOAST: 'AI extraction unavailable — document will be secured without metadata.',
} as const;

// =============================================================================
// SETTINGS PAGE
// =============================================================================

export const SETTINGS_PAGE_LABELS = {
  ORG_TITLE: 'Organization Settings',
  ORG_DESCRIPTION: 'Manage templates, integrations, and API access',
  CREDENTIAL_TEMPLATES: 'Credential Templates',
  CREDENTIAL_TEMPLATES_DESC: 'Define schemas for credential types',
  WEBHOOKS: 'Webhooks',
  WEBHOOKS_DESC: 'Configure event notifications',
  API_KEYS: 'API Keys',
  API_KEYS_DESC: 'Manage verification API access',
  TEMPLATES_EMPTY_TITLE: 'No templates yet',
  TEMPLATES_EMPTY_DESC: 'Create your first credential template to start issuing verifiable credentials.',
  TEMPLATES_EMPTY_CTA: 'Create Template',
  TEMPLATES_STARTER_HEADING: 'Popular templates to get started',
} as const;

// =============================================================================
// ACCOUNT DELETION (PII-02 — GDPR Art. 17)
// =============================================================================

export const ACCOUNT_DELETE_LABELS = {
  DELETE_BUTTON: 'Delete Account',
  DIALOG_TITLE: 'Delete Your Account',
  DIALOG_DESCRIPTION: 'This action is permanent and cannot be undone.',
  WARNING: 'All your personal data will be permanently anonymized. This cannot be reversed.',
  CONSEQUENCES_INTRO: 'Deleting your account will:',
  CONSEQUENCE_1: 'Anonymize all your audit trail records',
  CONSEQUENCE_2: 'Remove your profile and sign-in credentials',
  CONSEQUENCE_3: 'Revoke all active API keys',
  CONSEQUENCE_4: 'Preserved records will be disassociated from your identity',
  CONFIRM_BUTTON: 'Permanently Delete Account',
  DELETING: 'Deleting...',
  DANGER_ZONE_TITLE: 'Danger Zone',
  DANGER_ZONE_DESCRIPTION: 'Irreversible account actions',
  DANGER_ZONE_DETAIL: 'Permanently delete your account and anonymize all personal data. This cannot be undone.',
} as const;

// =============================================================================
// ADMIN TREASURY DASHBOARD (GAP-01 — internal ops, banned terms exempt)
// =============================================================================

export const TREASURY_LABELS = {
  PAGE_TITLE: 'Anchoring Infrastructure',
  PAGE_SUBTITLE: 'Internal operations dashboard for Arkova platform administrators.',
  VAULT_SECTION: 'Anchoring Account',
  VAULT_ADDRESS: 'Account Address',
  VAULT_BALANCE: 'Available Anchoring Credits',
  VAULT_NETWORK: 'Environment',
  UTXO_SECTION: 'Available Outputs',
  UTXO_COUNT: 'Available Outputs',
  ANCHOR_STATS_SECTION: 'Anchor Processing',
  TOTAL_ANCHORS: 'Total Anchors',
  PENDING_ANCHORS: 'Pending',
  SECURED_ANCHORS: 'Secured',
  REVOKED_ANCHORS: 'Revoked',
  RECENT_ANCHORS: 'Recent Anchors',
  NETWORK_STATUS: 'Network Status',
  CONNECTED: 'Connected',
  DISCONNECTED: 'Disconnected',
  UNKNOWN: 'Unknown',
  VAULT_NOT_CONFIGURED: 'Treasury vault not configured. Set signing key in worker environment.',
  API_UNAVAILABLE: 'Treasury API not available. Ensure the worker is running.',
  UNAUTHORIZED: 'Access denied. Platform administrator privileges required.',
  REFRESH: 'Refresh',
  FEE_RATE: 'Fee Rate (sat/vB)',
  FEE_ESTIMATOR: 'Estimator',
  BLOCK_HEIGHT: 'Network Record Height',
  CHAIN_NAME: 'Chain',
  LAST_24H: 'Last 24 Hours',
  WORKER_STATUS: 'Worker',
  CHAIN_CLIENT: 'Chain Client',
} as const;

// =============================================================================
// INTEGRITY SCORES (P8-S8)
// =============================================================================

export const INTEGRITY_LABELS = {
  TITLE: 'Integrity Analysis',
  COMPUTE_BUTTON: 'Analyze Integrity',
  COMPUTING: 'Analyzing...',
  SCORE_HIGH: 'High Integrity',
  SCORE_MEDIUM: 'Medium Integrity',
  SCORE_LOW: 'Low Integrity',
  SCORE_FLAGGED: 'Flagged',
  NO_SCORE: 'No integrity analysis available',
  COMPUTE_DESCRIPTION: 'Run an integrity analysis to check metadata quality and detect potential issues',
} as const;

// =============================================================================
// REVIEW QUEUE (P8-S9)
// =============================================================================

export const REVIEW_QUEUE_LABELS = {
  PAGE_TITLE: 'Review Queue',
  PAGE_SUBTITLE: 'Review flagged credentials that require human verification.',
  EMPTY: 'No items in the review queue',
  PENDING: 'Pending Review',
  INVESTIGATING: 'Under Investigation',
  ESCALATED: 'Escalated',
  APPROVED: 'Approved',
  DISMISSED: 'Dismissed',
  ACTION_APPROVE: 'Approve',
  ACTION_INVESTIGATE: 'Investigate',
  ACTION_ESCALATE: 'Escalate',
  ACTION_DISMISS: 'Dismiss',
  NOTES_PLACEHOLDER: 'Add review notes (optional)...',
  ACTION_SUCCESS: 'Review action applied successfully',
  NAV_LABEL: 'Review Queue',
} as const;

// =============================================================================
// COMPLIANCE DASHBOARD
// =============================================================================

export const COMPLIANCE_LABELS = {
  PAGE_TITLE: 'Compliance Intelligence',
  PAGE_SUBTITLE: 'Monitor credential health, expiring credentials, and review activity across your organization.',
  CARD_ACTIVE: 'Active Credentials',
  CARD_ACTIVE_SUBTITLE: 'Issued attestations',
  CARD_EXPIRING: 'Expiring Soon',
  CARD_REVOKED: 'Recently Revoked',
  CARD_ANCHORED: 'Anchored Rate',
  SECTION_EXPIRING: 'Expiring Credentials',
  SECTION_ACTIVITY: 'Recent Activity',
  SECTION_REVIEW: 'Review Summary',
  EMPTY_EXPIRING: 'All credentials current',
  EMPTY_EXPIRING_DESC: 'No credentials are expiring in the next 30 days.',
  EMPTY_ACTIVITY: 'No recent activity',
  EMPTY_ACTIVITY_DESC: 'Credential activity will appear here as events occur.',
  COL_SUBJECT: 'Subject',
  COL_TYPE: 'Type',
  COL_ATTESTER: 'Attester',
  COL_EXPIRES: 'Expires',
  COL_DAYS_LEFT: 'Days Left',
  COL_STATUS: 'Status',
  COL_ACTION: 'Action',
  ACTION_VIEW: 'View',
  ACTION_RENEW: 'Renew',
  REVIEW_PENDING: 'Items Pending Review',
  REVIEW_LINK: 'View Review Queue',
  WITHIN_30_DAYS: 'within 30 days',
  EVENT_CREATED: 'Credential created',
  EVENT_REVOKED: 'Credential revoked',
  EVENT_EXPIRED: 'Credential expired',
  EVENT_ACTIVE: 'Credential activated',
  SECTION_COVERAGE: 'Regulatory Framework Coverage',
  SECTION_COVERAGE_DESC: 'Controls evidenced by your secured credentials.',
  COVERAGE_SECURED: 'Secured Records',
  COVERAGE_CONTROLS: 'Controls Evidenced',
  COVERAGE_FRAMEWORKS: 'Frameworks Covered',
  COVERAGE_EMPTY: 'No secured records yet',
  COVERAGE_EMPTY_DESC: 'Framework coverage appears once credentials are anchored to the network.',
  EXPORT_AUDIT: 'Export Audit Report',
  EXPORT_AUDIT_DESC: 'Download a compliance-ready report for GRC platforms.',
  EXPORT_PDF: 'Download PDF',
  EXPORT_CSV: 'Download CSV',
  // CML-05: GRC Platform Integrations
  GRC_SECTION_TITLE: 'GRC Platform Connections',
  GRC_SECTION_DESC: 'Connect compliance platforms for automated evidence delivery.',
  GRC_CONNECT: 'Connect Platform',
  GRC_DISCONNECT: 'Disconnect',
  GRC_TEST: 'Test Connection',
  GRC_SYNC_LOGS: 'Sync History',
  GRC_STATUS_ACTIVE: 'Connected',
  GRC_STATUS_INACTIVE: 'Disconnected',
  GRC_LAST_SYNC: 'Last synced',
  GRC_NO_CONNECTIONS: 'No platforms connected',
  GRC_NO_CONNECTIONS_DESC: 'Connect Vanta, Drata, or Anecdotes to automatically push compliance evidence.',
} as const;

// =============================================================================
// NESSIE INTELLIGENCE (NMT-07)
// =============================================================================

export const NESSIE_LABELS = {
  PANEL_TITLE: 'Nessie Intelligence',
  PANEL_SUBTITLE: 'Ask compliance questions. Answers cite verified, anchored documents.',
  INPUT_PLACEHOLDER: 'Ask a compliance question...',
  CONFIDENCE: 'confidence',
  CITATIONS_HEADING: 'Verified Citations',
  VIEW_ON_CHAIN: 'On-chain proof',
  VERIFY: 'Verify',
  EMPTY_STATE: 'Ask a question to get compliance intelligence backed by verified evidence.',
  CACHED: 'cached',
} as const;

// =============================================================================
// AI REPORTS (P8-S16)
// =============================================================================

export const AI_REPORTS_LABELS = {
  PAGE_TITLE: 'AI Reports',
  PAGE_SUBTITLE: 'Generate analytics and compliance reports for your organization.',
  GENERATE_BUTTON: 'Generate Report',
  GENERATING: 'Generating...',
  EMPTY: 'No reports yet',
  EMPTY_DESC: 'Generate your first report to get insights into your credentials.',
  REPORT_INTEGRITY: 'Integrity Summary',
  REPORT_ACCURACY: 'Extraction Accuracy',
  REPORT_ANALYTICS: 'Credential Analytics',
  REPORT_COMPLIANCE: 'Compliance Overview',
  DOWNLOAD_JSON: 'Download JSON',
  STATUS_QUEUED: 'Queued',
  STATUS_GENERATING: 'Generating',
  STATUS_COMPLETE: 'Complete',
  STATUS_FAILED: 'Failed',
  NAV_LABEL: 'AI Reports',
} as const;

// =============================================================================
// EXTRACTION FEEDBACK (P8-S6)
// =============================================================================

export const EXTRACTION_FEEDBACK_LABELS = {
  ACCURACY_TITLE: 'Extraction Accuracy',
  ACCURACY_DESC: 'AI suggestion acceptance rates over the last 30 days',
  FIELD: 'Field',
  TOTAL: 'Total',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  EDITED: 'Edited',
  RATE: 'Acceptance Rate',
  CONFIDENCE: 'Avg Confidence',
  NO_DATA: 'No feedback data yet. Accept or reject AI suggestions to build accuracy metrics.',
} as const;

// =============================================================================
// INTEGRITY DETAIL VIEW (P8-S8)
// =============================================================================

export const INTEGRITY_DETAIL_LABELS = {
  // Breakdown dimension labels
  METADATA_COMPLETENESS: 'Metadata Completeness',
  EXTRACTION_CONFIDENCE: 'Extraction Confidence',
  ISSUER_VERIFICATION: 'Issuer Verification',
  DUPLICATE_CHECK: 'Duplicate Check',
  TEMPORAL_CONSISTENCY: 'Temporal Consistency',
  // Flag labels
  FLAG_MISSING_ISSUED_DATE: 'Missing issue date',
  FLAG_FUTURE_ISSUED_DATE: 'Issue date is in the future',
  FLAG_VERY_OLD_CREDENTIAL: 'Credential is over 50 years old',
  FLAG_EXPIRY_BEFORE_ISSUED: 'Expiry date is before issue date',
  FLAG_DUPLICATE_FINGERPRINT: 'Duplicate document fingerprint found',
  FLAG_ISSUER_NOT_IN_REGISTRY: 'Issuer not found in registry',
  FLAG_MISSING_ISSUER: 'Missing issuer information',
  FLAG_ANCHOR_NOT_FOUND: 'Record not found',
  // Status messages
  NO_ISSUES: 'No integrity issues detected',
} as const;

// =============================================================================
// VISUAL FRAUD DETECTION (Phase 5)
// =============================================================================

export const FRAUD_DETECTION_LABELS = {
  TITLE: 'Document Risk Assessment',
  SUBTITLE: 'Visual analysis of document authenticity indicators.',
  ANALYZE_BUTTON: 'Analyze Document',
  ANALYZING: 'Analyzing document...',
  RISK_LOW: 'Low Risk',
  RISK_MEDIUM: 'Medium Risk',
  RISK_HIGH: 'High Risk',
  RISK_CRITICAL: 'Critical Risk',
  NO_ANALYSIS: 'No risk assessment available',
  SIGNALS_TITLE: 'Detection Signals',
  RECOMMENDATIONS_TITLE: 'Recommendations',
  CATEGORY_FONT: 'Font Analysis',
  CATEGORY_LAYOUT: 'Layout Analysis',
  CATEGORY_MANIPULATION: 'Image Manipulation',
  CATEGORY_METADATA: 'Metadata Consistency',
  CATEGORY_SECURITY: 'Security Features',
  SEVERITY_INFO: 'Info',
  SEVERITY_WARNING: 'Warning',
  SEVERITY_CRITICAL: 'Critical',
} as const;

// =============================================================================
// ERROR BOUNDARY (AUDIT-07)
// =============================================================================

export const ERROR_BOUNDARY_LABELS = {
  TITLE: 'Something went wrong',
  DESCRIPTION: 'This section encountered an error. You can try again or navigate to another page.',
  RETRY: 'Try Again',
  GO_HOME: 'Dashboard',
  SKIP_TO_CONTENT: 'Skip to main content',
} as const;

// =============================================================================
// VERIFICATION WALKTHROUGH (DEMO-02)
// =============================================================================

export const WALKTHROUGH_LABELS = {
  TITLE: 'How Verification Works',
  SUBTITLE: 'Your document is independently verifiable — no dependency on Arkova.',
  STEP_1_TITLE: 'Fingerprint Your Document',
  STEP_1_DESC: 'A SHA-256 algorithm creates a unique fingerprint from your document. Even a single changed character produces a completely different fingerprint.',
  STEP_2_TITLE: 'Find It On the Network',
  STEP_2_DESC: 'The fingerprint (and metadata fingerprint) are permanently written to a tamper-proof record on the network. Anyone can search for your fingerprint to confirm it exists.',
  STEP_3_TITLE: 'Match = Verified',
  STEP_3_DESC: 'If the fingerprint you compute matches the one on the network, the document is authentic and was secured at the recorded time. No Arkova account or service needed.',
  METADATA_NOTE: 'AI-extracted metadata (degree, institution, dates) is also fingerprinted and anchored, enabling verification of both the document and its structured data.',
} as const;

// =============================================================================
// DEVELOPER PAGE
// =============================================================================

export const DEVELOPER_PAGE_LABELS = {
  // Hero
  HERO_TITLE: 'Developer Platform',
  HERO_SUBTITLE: 'Programmatic credential verification, AI-powered metadata extraction, and seamless integration for your applications.',

  // API Overview cards
  CARD_VERIFY_TITLE: 'Verify Credentials',
  CARD_VERIFY_ENDPOINT: 'GET /verify/{id}',
  CARD_VERIFY_DESC: 'Verify any credential\'s status, proof details, and issuer information with a single API call.',
  CARD_BATCH_TITLE: 'Batch Verification',
  CARD_BATCH_ENDPOINT: 'POST /verify/batch',
  CARD_BATCH_DESC: 'Verify up to 100 credentials per request for high-throughput integrations.',
  CARD_AI_TITLE: 'AI Intelligence',
  CARD_AI_ENDPOINT: 'POST /ai/extract',
  CARD_AI_DESC: 'AI-powered metadata extraction, semantic search, and integrity scoring for credential data.',

  // Getting Started
  GETTING_STARTED_TITLE: 'Getting Started',
  STEP_1: 'Create an account and navigate to Settings',
  STEP_2: 'Go to API Keys and generate a new key',
  STEP_3: 'Make your first API call using the example below',
  CURL_COMMENT: '# Verify a credential by its public ID',

  // Links
  LINKS_TITLE: 'Resources',
  LINK_API_DOCS: 'API Documentation',
  LINK_API_DOCS_DESC: 'Interactive Swagger UI with full endpoint reference',
  LINK_OPENAPI_SPEC: 'OpenAPI Spec',
  LINK_OPENAPI_SPEC_DESC: 'Machine-readable API specification (JSON)',
  LINK_AGENT_GUIDE: 'Agent Integration Guide',
  LINK_AGENT_GUIDE_DESC: 'Instructions for AI agent and LLM integration',
  LINK_LLM_DISCOVERY: 'LLM Discovery',
  LINK_LLM_DISCOVERY_DESC: 'Structured capability manifest for AI assistants',

  // MCP Server
  MCP_TITLE: 'MCP Server for AI Agents',
  MCP_DESC: 'Arkova provides a Model Context Protocol (MCP) server for AI agents. Connect your agent to verify credentials and search the registry programmatically.',
  MCP_TOOL_VERIFY: 'verify_credential',
  MCP_TOOL_VERIFY_DESC: 'Verify a credential by its public ID',
  MCP_TOOL_SEARCH: 'search_credentials',
  MCP_TOOL_SEARCH_DESC: 'Search the public credential registry',

  // API docs card on ApiKeySettingsPage
  API_DOCS_CARD_TITLE: 'API Documentation',
  API_DOCS_CARD_DESC: 'Explore the full API reference with interactive examples.',
  API_DOCS_CARD_BUTTON: 'Open API Docs',
  API_DOCS_CARD_LINK: 'View full developer overview',
} as const;

// =============================================================================
// BETA GATE
// =============================================================================

export const AUTH_FORM_LABELS = {
  SIGNUP_TITLE: 'Create your account',
  SIGNUP_DESCRIPTION: 'Join the closed beta and start securing your documents',
  ALREADY_HAVE_ACCOUNT: 'Already have an account?',
  SIGN_IN: 'Sign in',
  CREATE_ACCOUNT: 'Create account',
  CREATING_ACCOUNT: 'Creating account...',
} as const;

export const BETA_GATE_LABELS = {
  DESCRIPTION: 'Arkova is in closed beta. Enter your invite code to create an account.',
  CODE_LABEL: 'Invite code',
  CODE_PLACEHOLDER: 'Enter your invite code',
  CONTINUE: 'Continue',
  INVALID_CODE: 'Invalid invite code. Please check your invitation email and try again.',
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
// =============================================================================
// PIPELINE MONITORING (PH1-DATA-05)
// =============================================================================

export const PIPELINE_LABELS = {
  PAGE_TITLE: 'Pipeline Monitoring',
  PAGE_DESCRIPTION: 'Data ingestion and anchoring pipeline status',
  RECORDS_INGESTED: 'Records Ingested',
  RECORDS_ANCHORED: 'Records Anchored',
  RECORDS_PENDING: 'Pending Anchoring',
  RECORDS_EMBEDDED: 'Records Embedded',
  ANCHORING_COST: 'Anchoring Cost',
  LAST_RUN: 'Last Successful Run',
  ERROR_COUNT: 'Errors',
  SOURCE_EDGAR: 'SEC EDGAR',
  SOURCE_USPTO: 'USPTO Patents',
  SOURCE_FEDERAL_REGISTER: 'Federal Register',
  SOURCE_MCP: 'MCP Submissions',
  SOURCE_OPENALEX: 'OpenAlex Academic',
  RECORDS_BROWSER_TITLE: 'Records Browser',
  RECORDS_BROWSER_DESCRIPTION: 'Browse and filter all ingested public records',
  FILTER_ALL_SOURCES: 'All Sources',
  FILTER_ALL_TYPES: 'All Types',
  FILTER_ALL_STATUSES: 'All Statuses',
  FILTER_ANCHORED: 'Anchored',
  FILTER_UNANCHORED: 'Not Anchored',
  FILTER_SEARCH_PLACEHOLDER: 'Search by title or source ID...',
  RECORDS_NO_RESULTS: 'No records match the current filters.',
  RECORDS_SHOWING: 'Showing',
  RECORDS_OF: 'of',
  RECORDS_LOAD_MORE: 'Load More',
  ANCHORS_BY_TYPE_TITLE: 'Anchors by Credential Type',
  TYPE_PUBLICATION: 'Publications',
  TYPE_SEC_FILING: 'SEC Filings',
  TYPE_PROFESSIONAL: 'Professional',
  TYPE_OTHER: 'Other',
  TYPE_LEGAL: 'Legal',
  TYPE_CHARITY: 'Charity',
  TYPE_CERTIFICATE: 'Certificates',
  TYPE_DEGREE: 'Degrees',
  TYPE_LICENSE: 'Licenses',
  TYPE_TRANSCRIPT: 'Transcripts',
} as const;

// =============================================================================
// PAYMENT ANALYTICS (PH1-PAY-03)
// =============================================================================

export const PAYMENT_LABELS = {
  PAGE_TITLE: 'Payment Analytics',
  PAGE_DESCRIPTION: 'x402 payment revenue and settlement tracking',
  TOTAL_REVENUE: 'Total Revenue',
  PAYMENTS_TODAY: 'Payments Today',
  PAYMENTS_WEEK: 'This Week',
  PAYMENTS_MONTH: 'This Month',
  TOP_ENDPOINTS: 'Revenue by Endpoint',
  SETTLEMENT_STATUS: 'Settlement Status',
  AVERAGE_PAYMENT: 'Avg Payment',
} as const;

// =============================================================================
// DESIGN AUDIT — NEW LABELS
// =============================================================================

export const EXTRACTION_RECOVERY_LABELS = {
  TITLE: 'Extraction Unsuccessful',
  DESCRIPTION: 'We couldn\'t extract metadata from this document. This may be due to image quality or an unsupported format.',
  RETRY: 'Retry Extraction',
  ENTER_MANUALLY: 'Enter Manually',
  SKIP: 'Skip \u2014 Anchor Without Metadata',
} as const;

export const CONFIRMATION_PROGRESS_LABELS = {
  IN_PROGRESS: 'Anchoring in progress \u2014 your record will be permanently verified in ~10 minutes.',
  NOTIFICATION_NOTE: 'You\u2019ll receive a notification when anchoring is complete. You can safely close this dialog.',
} as const;

export const FINGERPRINT_TOOLTIP = {
  TITLE: 'What is a document fingerprint?',
  DESCRIPTION: 'A document fingerprint is a unique identifier calculated from the document\u2019s contents. Like a human fingerprint, no two documents produce the same one. This fingerprint is what gets permanently anchored.',
} as const;

export const ONBOARDING_VALUE_PROP_LABELS = {
  TITLE: 'Welcome to Arkova',
  STEP_1_TITLE: 'Upload any document',
  STEP_1_DESC: 'Drag and drop a credential, certificate, or any file you need to verify.',
  STEP_2_TITLE: 'AI extracts and verifies metadata',
  STEP_2_DESC: 'Our AI reads your document, extracts key fields, and checks for inconsistencies \u2014 all on your device.',
  STEP_3_TITLE: 'Permanently anchored and verifiable',
  STEP_3_DESC: 'Your proof is permanently recorded. Anyone can independently verify it \u2014 no Arkova account needed.',
  CONTINUE: 'Get Started',
} as const;

export const ORG_MEMBERSHIP_LABELS = {
  TITLE: 'Are you part of an organization?',
  DESCRIPTION: 'If your employer or institution uses Arkova, you can request to join their organization for shared access to verified records.',
  YES_BUTTON: 'Yes, find my organization',
  NO_BUTTON: 'No, continue as individual',
  SEARCH_LABEL: 'Organization name or domain',
  SEARCH_PLACEHOLDER: 'e.g. Acme Corp or acme.com',
  SEARCHING: 'Searching...',
  NO_ORG_FOUND: 'No matching organizations found. You can continue as an individual and join an organization later from Settings.',
  JOIN_BUTTON: 'Request to join',
  SKIP_BUTTON: 'Continue as individual',
  SEARCH_BUTTON: 'Search',
} as const;

export const PLAN_SELECTOR_LABELS = {
  TITLE: 'Choose your plan',
  SUBTITLE: 'Select the plan that fits your needs',
  BETA_BANNER: 'All plans are free during the beta period',
  FREE_NAME: 'Free',
  FREE_DESC: 'Get started at no cost',
  FREE_RECORDS: '3 records per month',
  FREE_VERIFICATION: 'Basic verification',
  FREE_PROOF: '7-day proof access',
  STARTER_NAME: 'Starter',
  STARTER_DESC: 'For personal document security',
  STARTER_PRICE: '$10/mo',
  STARTER_RECORDS: '10 records per month',
  STARTER_SUPPORT: 'Basic support',
  STARTER_DOWNLOADS: 'Proof downloads',
  PROFESSIONAL_NAME: 'Professional',
  PROFESSIONAL_DESC: 'For growing businesses',
  PROFESSIONAL_PRICE: '$100/mo',
  PROFESSIONAL_RECORDS: '100 records per month',
  PROFESSIONAL_SUPPORT: 'Priority support',
  PROFESSIONAL_API: 'API access',
  PROFESSIONAL_BULK: 'Bulk CSV upload',
  CONTINUE: 'Continue',
  CURRENT_PLAN: 'Current plan',
  RECOMMENDED: 'Recommended',
  SETTING_UP: 'Setting up...',
  FREE_PRICE: '$0',
  BETA_LABEL: 'beta',
} as const;

export const REVOKED_EXPIRED_ACTIONS = {
  REQUEST_REISSUANCE: 'Request Re-Issuance',
  REQUEST_RENEWAL: 'Request Renewal',
  CONTACT_ISSUER: 'Contact Issuer',
} as const;

export const BILLING_PAGE_LABELS = {
  PAGE_TITLE: 'Billing & Subscription',
  PAGE_SUBTITLE: 'Manage your plan, view usage, and update payment methods.',
} as const;

export const SYSTEM_HEALTH_LABELS = {
  CONNECTION_ERROR: 'Unable to connect to the server. Please check your connection and try again.',
  WORKER_HINT: 'Ensure the worker service is running and accessible.',
  WORKER_OFFLINE: 'Worker offline',
} as const;

// =============================================================================
// VERSION HISTORY / LINEAGE
// =============================================================================

export const VERSION_HISTORY_LABELS = {
  TITLE: 'Version History',
  VERSION_PREFIX: 'Version',
  CURRENT: 'Current',
  ORIGINAL: 'Original',
  UPDATED_VERSION: 'Updated Version',
  NO_HISTORY: 'This is the original version of this record.',
  VIEW_VERSION: 'View Version',
} as const;

// =============================================================================
// SUB-ORG AFFILIATION (IDT-11)
// =============================================================================

export const SUB_ORG_LABELS = {
  SECTION_TITLE: 'Affiliated Organizations',
  MANAGE_TITLE: 'Manage Affiliated Organizations',
  MANAGE_DESCRIPTION: 'Approve or revoke affiliation requests from other organizations.',
  COUNT_LABEL: 'affiliated organizations',
  MAX_SUB_ORGS_LABEL: 'Maximum Affiliates',
  MAX_SUB_ORGS_HINT: 'Set the maximum number of organizations that can affiliate with yours.',
  APPROVE: 'Approve',
  REVOKE: 'Revoke',
  STATUS_PENDING: 'Pending Approval',
  STATUS_APPROVED: 'Approved',
  STATUS_REVOKED: 'Revoked',
  EMPTY_STATE: 'No affiliated organizations yet.',
  EMPTY_STATE_CHILD: 'Your organization is not affiliated with a parent organization.',
  REQUEST_AFFILIATION: 'Request Affiliation',
  REQUEST_DIALOG_TITLE: 'Request Organization Affiliation',
  REQUEST_DIALOG_DESCRIPTION: 'Search for a verified organization to request affiliation with.',
  SEARCH_PLACEHOLDER: 'Search verified organizations...',
  AFFILIATED_WITH: 'Affiliated with',
  PENDING_APPROVAL: 'Pending approval from',
  REVOKED_BY: 'Affiliation revoked by',
  APPROVE_SUCCESS: 'Organization approved as affiliate.',
  APPROVE_FAILED: 'Failed to approve organization.',
  REVOKE_SUCCESS: 'Organization affiliation revoked.',
  REVOKE_FAILED: 'Failed to revoke affiliation.',
  REQUEST_SUCCESS: 'Affiliation request sent successfully.',
  REQUEST_FAILED: 'Failed to send affiliation request.',
  CANCEL_REQUEST: 'Cancel Request',
  CANCEL_SUCCESS: 'Affiliation request cancelled.',
  NO_RESULTS: 'No verified organizations found.',
} as const;

// =============================================================================
// ORG LOGO
// =============================================================================

export const ORG_LOGO_LABELS = {
  UPLOAD_LOGO: 'Upload Logo',
  CHANGE_LOGO: 'Change Logo',
  LOGO_HINT: 'PNG or JPG, max 2 MB',
  UPLOAD_FAILED: 'Failed to upload logo. Please try again.',
  UPLOAD_SUCCESS: 'Logo updated successfully.',
} as const;

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

// =============================================================================
// IDENTITY TRUST LAYER (IDT)
// =============================================================================

export const DISCLAIMER_LABELS = {
  title: 'Platform Disclaimer',
  heading: 'Important Information About Arkova',
  body: `Arkova provides timestamped cryptographic verification of documents and credentials. Our service creates permanent, tamper-evident records that a specific document existed at a specific time.

Arkova does NOT:
• Verify the truthfulness or accuracy of document contents
• Guarantee the authenticity of the original document
• Provide legal certification or notarization
• Replace official verification processes required by law

A secured record on Arkova confirms that a document's digital fingerprint was anchored at a given time — nothing more. Users and third parties should perform their own due diligence when relying on any credential.

By using this platform, you acknowledge and accept these limitations.`,
  description: 'Please review our platform disclaimer',
  cardDescription: 'Please review and accept the following before continuing.',
  acceptButton: 'I Understand and Accept',
  accepted: 'Disclaimer accepted',
  notAccepted: 'Please review and accept the platform disclaimer to continue.',
} as const;

export const PROFILE_LABELS = {
  bio: {
    label: 'Bio',
    placeholder: 'Tell others about yourself or your professional background...',
    hint: 'Up to 500 characters',
  },
  socialLinks: {
    heading: 'Social Profiles',
    linkedin: { label: 'LinkedIn', placeholder: 'https://linkedin.com/in/yourprofile' },
    twitter: { label: 'X (Twitter)', placeholder: '@yourhandle' },
    github: { label: 'GitHub', placeholder: 'https://github.com/yourprofile' },
    website: { label: 'Website', placeholder: 'https://yourwebsite.com' },
  },
} as const;

// =============================================================================
// SHARED PUBLIC FOOTER (GEO-08)
// =============================================================================

export const PUBLIC_FOOTER_LABELS = {
  NAV_SEARCH: 'Search Credentials',
  NAV_VERIFY: 'Verify a Document',
  NAV_HOW_IT_WORKS: 'How It Works',
  NAV_USE_CASES: 'Use Cases',
  NAV_ENTERPRISE: 'Enterprise',
  NAV_DEVELOPERS: 'Developer API',
  NAV_CONTACT: 'Contact',
  NAV_PRIVACY: 'Privacy',
  NAV_TERMS: 'Terms',
  COPYRIGHT: 'Arkova',
  STEP_PREFIX: 'Step',
} as const;

// =============================================================================
// HOW IT WORKS PAGE (GEO-08)
// =============================================================================

export const HOW_IT_WORKS_LABELS = {
  PAGE_TITLE: 'How Arkova Works — Credential Verification in 3 Steps',
  PAGE_DESCRIPTION: 'Learn how Arkova secures credentials with client-side fingerprinting, permanent network anchoring, and universal verification. Privacy-first by design.',
  HERO_TITLE: 'How Arkova Works',
  HERO_SUBTITLE: 'Three steps to permanently verifiable credentials. Your documents never leave your device.',
  STEP_1_TITLE: 'Upload & Fingerprint',
  STEP_1_DESCRIPTION: 'Select your document and a unique cryptographic fingerprint (SHA-256) is generated entirely in your browser. The document itself never leaves your device — only the fingerprint moves forward.',
  STEP_1_DETAIL: 'Client-side processing means your sensitive documents remain private. No server ever sees, stores, or transmits the original file.',
  STEP_2_TITLE: 'Permanent Anchoring',
  STEP_2_DESCRIPTION: 'The fingerprint is recorded on a public, immutable network. Anchors are batched for efficiency, reducing costs while maintaining cryptographic integrity.',
  STEP_2_DETAIL: 'Once anchored, the record cannot be altered, deleted, or tampered with. The network provides a permanent, independently verifiable timestamp.',
  STEP_3_TITLE: 'Universal Verification',
  STEP_3_DESCRIPTION: 'Anyone can verify a document by generating its fingerprint and comparing it against the permanent record. No account required — verification is open and free.',
  STEP_3_DETAIL: 'Third-party verifiers, employers, regulators, and auditors can independently confirm document authenticity without needing access to the original.',
  DIFFERENTIATORS_TITLE: 'What Makes It Different',
  DIFF_PRIVACY_TITLE: 'Client-Side Privacy',
  DIFF_PRIVACY_DESC: 'Documents are processed entirely in the browser. No server-side storage, no cloud uploads, no third-party access to your files.',
  DIFF_IMMUTABILITY_TITLE: 'Permanent Immutability',
  DIFF_IMMUTABILITY_DESC: 'Anchored fingerprints are recorded on a public, decentralized network. No single entity can alter or remove the record.',
  DIFF_AI_TITLE: 'AI-Powered Extraction',
  DIFF_AI_DESC: 'Intelligent metadata extraction identifies credential types, issuers, dates, and fields — making records searchable and structured.',
  DIFF_OPEN_TITLE: 'Open Verification',
  DIFF_OPEN_DESC: 'Verification is free and requires no account. Anyone with the document can confirm its authenticity against the permanent record.',
  CTA_TITLE: 'Ready to Secure Your Credentials?',
  CTA_DESCRIPTION: 'Start anchoring documents in minutes. Free tier available.',
  CTA_BUTTON: 'Get Started',
} as const;

// =============================================================================
// USE CASES PAGE (GEO-08)
// =============================================================================

export const USE_CASES_LABELS = {
  PAGE_TITLE: 'Use Cases — Who Uses Arkova for Credential Verification',
  PAGE_DESCRIPTION: 'Discover how education, legal, healthcare, finance, HR, and government organizations use Arkova to verify credentials and anchor documents.',
  HERO_TITLE: 'Who Uses Arkova',
  HERO_SUBTITLE: 'Organizations across industries trust Arkova to make credentials verifiable, tamper-proof, and portable.',
  EDUCATION_TITLE: 'Education',
  EDUCATION_DESC: 'Universities and institutions anchor degree certificates and transcripts, enabling instant verification by employers and other schools. Graduates carry provable credentials wherever they go.',
  EDUCATION_EXAMPLE: 'A university anchors 10,000 diplomas at graduation. Employers verify any graduate in seconds.',
  LEGAL_TITLE: 'Legal',
  LEGAL_DESC: 'Law firms and courts timestamp contracts, evidence, and filings. Anchored records prove a document existed at a specific point in time, providing an unalterable chain of custody.',
  LEGAL_EXAMPLE: 'A firm anchors a signed contract. Years later, either party can prove the original terms were never modified.',
  HEALTHCARE_TITLE: 'Healthcare',
  HEALTHCARE_DESC: 'Hospitals and credentialing bodies verify medical licenses, board certifications, and continuing education. Reduces manual verification from weeks to seconds.',
  HEALTHCARE_EXAMPLE: 'A hospital verifies a surgeon\'s board certification instantly before granting privileges.',
  FINANCE_TITLE: 'Finance',
  FINANCE_DESC: 'Financial institutions anchor compliance documentation, audit reports, and regulatory filings. Creates an immutable audit trail for regulators and internal compliance teams.',
  FINANCE_EXAMPLE: 'A bank anchors quarterly compliance reports, creating tamper-proof evidence for regulatory review.',
  HR_TITLE: 'HR & Recruiting',
  HR_DESC: 'HR teams and recruiters verify candidate credentials, background checks, and employment history. Integrates with applicant tracking systems for automated verification workflows.',
  HR_EXAMPLE: 'A recruiter verifies a candidate\'s professional certifications directly from their credential portfolio.',
  GOVERNMENT_TITLE: 'Government',
  GOVERNMENT_DESC: 'Government agencies anchor public records, licenses, and transparency documents. Citizens can independently verify the authenticity of any official record.',
  GOVERNMENT_EXAMPLE: 'A state agency publishes anchored business registrations that anyone can verify without contacting the agency.',
  FAQ_TITLE: 'Frequently Asked Questions',
  FAQ_1_Q: 'How does Arkova verify a document without seeing it?',
  FAQ_1_A: 'Arkova generates a cryptographic fingerprint of your document entirely in your browser. Only this fingerprint is sent to our servers and anchored on a public network. To verify, anyone can re-generate the fingerprint from the original document and compare it to the anchored record.',
  FAQ_2_Q: 'How long does verification take?',
  FAQ_2_A: 'Fingerprint generation is instant. Anchoring to the network typically completes within 10-30 minutes. Once anchored, verification is instant and permanent.',
  FAQ_3_Q: 'Can a secured record be altered or deleted?',
  FAQ_3_A: 'No. Once a fingerprint is anchored on the public network, it cannot be modified, deleted, or tampered with by anyone — including Arkova. This is the foundation of the platform\'s trust model.',
  FAQ_4_Q: 'What types of documents can I anchor?',
  FAQ_4_A: 'Arkova supports 21 credential types including degrees, licenses, certificates, legal documents, financial records, and more. Any digital document can be fingerprinted and anchored.',
  FAQ_5_Q: 'Is there an API for automated verification?',
  FAQ_5_A: 'Yes. Arkova provides a RESTful Verification API with TypeScript and Python SDKs for programmatic access. Enterprise plans include batch processing, webhooks, and dedicated support.',
  CTA_TITLE: 'See It in Action',
  CTA_DESCRIPTION: 'Try verifying a credential on the public search page, or create an account to start anchoring.',
  CTA_BUTTON_SEARCH: 'Search Credentials',
  CTA_BUTTON_SIGNUP: 'Create Account',
} as const;

// =============================================================================
// ENTERPRISE PAGE (GEO-08)
// =============================================================================

export const ENTERPRISE_LABELS = {
  PAGE_TITLE: 'Enterprise Credential Verification — Arkova for Organizations',
  PAGE_DESCRIPTION: 'Enterprise-grade credential verification with API access, batch processing, SSO, webhooks, and dedicated support. Built on permanent anchoring infrastructure.',
  HERO_TITLE: 'Enterprise-Grade Credential Verification',
  HERO_SUBTITLE: 'Scalable, secure, and auditable credential infrastructure for organizations that need more than a login.',
  FEATURES_TITLE: 'Built for Scale',
  FEAT_API_TITLE: 'RESTful API Access',
  FEAT_API_DESC: 'Programmatic credential verification and anchoring. Full OpenAPI documentation with TypeScript and Python SDKs.',
  FEAT_BATCH_TITLE: 'Batch Processing',
  FEAT_BATCH_DESC: 'Anchor thousands of credentials in a single operation. Optimized batching reduces costs while maintaining individual verifiability.',
  FEAT_WEBHOOKS_TITLE: 'Custom Webhooks',
  FEAT_WEBHOOKS_DESC: 'Real-time notifications when credentials are anchored, verified, or expire. Integrate with your existing workflows.',
  FEAT_SSO_TITLE: 'Single Sign-On',
  FEAT_SSO_DESC: 'SAML and OAuth integration for seamless team access. Centralized user management with role-based permissions.',
  FEAT_SUPPORT_TITLE: 'Dedicated Support',
  FEAT_SUPPORT_DESC: 'Named account manager, priority response times, and onboarding assistance for your team.',
  FEAT_SLA_TITLE: 'SLA Guarantees',
  FEAT_SLA_DESC: '99.9% uptime commitment with proactive monitoring and incident response. Enterprise-grade reliability.',
  TRUST_TITLE: 'Trusted Infrastructure',
  TRUST_ANCHORING_TITLE: 'Permanent Anchoring',
  TRUST_ANCHORING_DESC: 'Every credential fingerprint is recorded on a public, immutable network. No single entity can alter the record.',
  TRUST_SOC2_TITLE: 'SOC 2 Compliance Path',
  TRUST_SOC2_DESC: 'Security controls designed for SOC 2 Type II certification. Comprehensive audit trails and access logging.',
  TRUST_ENCRYPTION_TITLE: 'End-to-End Privacy',
  TRUST_ENCRYPTION_DESC: 'Documents never leave the user\'s device. Only cryptographic fingerprints are transmitted and stored.',
  TRUST_RLS_TITLE: 'Row-Level Security',
  TRUST_RLS_DESC: 'Every database query is scoped to the authenticated user\'s organization. Data isolation is enforced at the infrastructure level.',
  INTEGRATIONS_TITLE: 'Integrations',
  INTEGRATIONS_SUBTITLE: 'Connect Arkova to your existing tools and workflows.',
  INT_API_TITLE: 'REST API',
  INT_API_DESC: 'Full-featured verification and anchoring API with comprehensive documentation.',
  INT_SDK_TITLE: 'TypeScript & Python SDKs',
  INT_SDK_DESC: 'Official client libraries for rapid integration. Type-safe with full IDE support.',
  INT_MCP_TITLE: 'MCP Server for AI Agents',
  INT_MCP_DESC: 'Model Context Protocol server enables AI agents to verify and anchor credentials programmatically.',
  INT_WEBHOOKS_TITLE: 'Webhook Events',
  INT_WEBHOOKS_DESC: 'Subscribe to credential lifecycle events and integrate with Slack, Zapier, or custom endpoints.',
  CTA_TITLE: 'Ready to Scale Credential Verification?',
  CTA_DESCRIPTION: 'Talk to our team about enterprise pricing, custom integrations, and volume discounts.',
  CTA_BUTTON_CONTACT: 'Contact Sales',
  CTA_BUTTON_DOCS: 'View API Documentation',
} as const;

// ─── Evidence Layers (COMP-01) ─────────────────────────────────────────

export const EVIDENCE_LAYER_LABELS = {
  SECTION_TITLE: 'Evidence Layers',
  SECTION_DESCRIPTION: 'Each layer provides independent proof. No single layer depends on another.',
  ANCHOR_TITLE: 'Existence Proof',
  ANCHOR_PROVES: 'This document fingerprint was recorded on a public network at the time shown. The record is immutable and independently verifiable.',
  ANCHOR_DOES_NOT_PROVE: 'This does not prove who created the document, whether its content is accurate, or that it has legal authority.',
  SIGNATURE_TITLE: 'Electronic Signature',
  SIGNATURE_PROVES: 'A named signer cryptographically bound their identity to this document fingerprint using an HSM-protected key.',
  SIGNATURE_DOES_NOT_PROVE: 'This does not prove the signer read or understood the document, only that they authorized the signing action.',
  TIMESTAMP_TITLE: 'Qualified Timestamp',
  TIMESTAMP_PROVES: 'A trusted third-party authority certified that this signature existed at the time shown. This timestamp is independent of Arkova.',
  TIMESTAMP_DOES_NOT_PROVE: 'This does not prove when the document was created, only when the signature was timestamped.',
  DISCLAIMER: 'This verification confirms the integrity of the document fingerprint. It does not verify the accuracy of the document\'s content or the qualifications of its subject.',
  LEGAL_EFFECT_EIDAS_QES: 'Equivalent to a handwritten signature under EU eIDAS Regulation Art. 25(2).',
  LEGAL_EFFECT_EIDAS_ADES: 'Admissible as evidence in legal proceedings under EU eIDAS Regulation Art. 25(1).',
  LEGAL_EFFECT_ESIGN: 'Valid electronic signature under the US ESIGN Act and UETA.',
} as const;

// ─── Independent Verification (COMP-03) ─────────────────────────────────

export const INDEPENDENT_VERIFY_LABELS = {
  PAGE_TITLE: 'Verify Without Arkova',
  PAGE_DESCRIPTION: 'Step-by-step instructions to verify any Arkova credential using only public data.',
  HERO_TITLE: 'Verify Without Arkova',
  HERO_SUBTITLE: 'Every Arkova credential can be independently verified using publicly available data. If Arkova disappears tomorrow, your proofs still work.',
  STEP_1_TITLE: 'Compute the Document Fingerprint',
  STEP_1_DESC: 'Generate the SHA-256 hash of your document. This is the same fingerprint Arkova computed when the document was anchored.',
  STEP_1_CMD: 'shasum -a 256 your-document.pdf',
  STEP_2_TITLE: 'Find the Network Record',
  STEP_2_DESC: 'Look up the anchoring record on a public block explorer. The OP_RETURN data contains a Merkle root that includes your fingerprint.',
  STEP_2_CMD: 'curl https://mempool.space/api/tx/{txid}',
  STEP_3_TITLE: 'Verify the Merkle Proof',
  STEP_3_DESC: 'Using the Merkle proof from your proof package, verify that your fingerprint is included in the Merkle root.',
  STEP_3_CMD: './verify.sh --fingerprint {hash} --proof proof-package.json',
  STEP_4_TITLE: 'Verify the Timestamp (Optional)',
  STEP_4_DESC: 'If the credential has an RFC 3161 timestamp, verify it independently using OpenSSL.',
  STEP_4_CMD: 'openssl ts -verify -data signed-attrs.der -in timestamp.tst -CAfile tsa-ca.pem',
  FAQ_SHUTDOWN_Q: 'What if Arkova shuts down?',
  FAQ_SHUTDOWN_A: 'Your proofs remain valid. The network records are permanent and public. The Merkle proofs in your proof packages contain everything needed for independent verification.',
  FAQ_OFFLINE_Q: 'What if the Arkova website is offline?',
  FAQ_OFFLINE_A: 'You can verify using only the proof package file and a public block explorer. No Arkova API call is required.',
  FAQ_TRUST_Q: 'Do I need to trust Arkova?',
  FAQ_TRUST_A: 'No. Arkova is a convenience layer. The cryptographic proofs are self-contained and verifiable by anyone with standard tools.',
  DOWNLOAD_SCRIPT: 'Download Verification Script',
} as const;

// ─── Data Retention (COMP-04) ─────────────────────────────────────────

export const DATA_RETENTION_LABELS = {
  PAGE_TITLE: 'Data Retention Policy',
  PAGE_DESCRIPTION: 'How long Arkova retains your data and how to request deletion.',
  INTRO: 'Arkova retains data only as long as necessary to fulfill its verification purpose.',
  NETWORK_NOTE: 'Network anchor records are permanent by design. The fingerprint recorded on the public network cannot be deleted. However, the mapping between a fingerprint and your identity can be removed upon request.',
  ERASURE_TITLE: 'Right to Erasure',
  ERASURE_BODY: 'Request deletion via Settings > Account > Delete Account, or contact privacy@arkova.ai. We remove your profile and identity associations. Cryptographic fingerprints on the public network remain (they contain no personal information).',
  LEGAL_HOLD_TITLE: 'Legal Hold',
  LEGAL_HOLD_BODY: 'Retention periods may be extended when required by law, regulatory investigation, or pending litigation.',
} as const;

// ─── Provenance Timeline (COMP-02) ──────────────────────────────────────

export const PROVENANCE_LABELS = {
  TITLE: 'Provenance Chain',
  EXPORT_JSON: 'Export as JSON',
  LOADING: 'Loading provenance chain...',
  ERROR_LOAD: 'Failed to load provenance data',
  ERROR_NETWORK: 'Network error',
} as const;

// ─── Auditor Batch Verification (COMP-06) ───────────────────────────────

export const AUDITOR_BATCH_LABELS = {
  PAGE_TITLE: 'Audit Batch Verification',
  PAGE_DESCRIPTION: 'Verify credentials in bulk for SOC 2 and ISO 27001 audit sampling (ISA 530).',
  SELECT_MODE: 'Verification Mode',
  MODE_CSV: 'Credential IDs',
  MODE_SAMPLE: 'Random Sample',
  CSV_LABEL: 'Credential IDs (one per line or comma-separated)',
  CSV_HINT: 'Maximum 1,000 IDs per batch. Paste from CSV or enter manually.',
  SAMPLE_PCT_LABEL: 'Sample Percentage',
  SEED_LABEL: 'Random Seed',
  SEED_PLACEHOLDER: 'Optional — for reproducibility',
  SEED_HINT: 'Use the same seed to reproduce identical sampling results (ISA 530).',
  SUBMIT: 'Run Batch Verification',
  DOWNLOAD_CSV: 'Download CSV Report',
  VERIFYING: 'Verifying...',
  COL_CREDENTIAL_ID: 'Credential ID',
  COL_STATUS: 'Status',
  COL_SECURED_AT: 'Secured At',
  COL_ANOMALIES: 'Anomalies',
  STAT_VERIFIED: 'Verified',
  STAT_PASSED: 'Passed',
  STAT_FAILED: 'Failed',
  STAT_NOT_FOUND: 'Not Found',
  STAT_ANOMALIES: 'Anomalies',
  STATUS_PASS: 'Pass',
  STATUS_FAIL: 'Fail',
  STATUS_NOT_FOUND: 'Not Found',
  ANOMALY_NONE: 'None',
  ERR_EMPTY_IDS: 'Enter at least one credential ID',
  ERR_MAX_IDS: 'Maximum 1,000 credential IDs per batch',
  ERR_INVALID_PCT: 'Sample percentage must be between 0.1 and 100',
  ERR_NOT_AUTHENTICATED: 'Not authenticated',
  ERR_NETWORK: 'Network error',
  ERR_INVALID_SEED: 'Seed must be a valid number',
} as const;

// ─── Compliance Trend Dashboard (COMP-07) ───────────────────────────────

export const COMPLIANCE_TREND_LABELS = {
  PAGE_TITLE: 'Compliance Trends',
  PAGE_DESCRIPTION: 'Track compliance KPIs over time. Demonstrate continuous improvement to auditors.',
  FETCH: 'Load Trends',
  DOWNLOAD_CSV: 'Export CSV',
  LOADING: 'Loading...',
  GRANULARITY: 'Granularity',
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  MONTHLY: 'Monthly',
  FROM: 'From',
  TO: 'To',
  COL_PERIOD: 'Period',
  COL_ANCHORS: 'Anchors',
  COL_SECURED: 'Secured',
  COL_SIGNATURES: 'Signatures',
  COL_TIMESTAMP_PCT: 'Timestamp %',
  COL_AVG_DELAY: 'Avg Delay (min)',
  COL_CERTS: 'Certs (active/expired)',
  NO_DATA: 'No data available for the selected period.',
  ERR_NOT_AUTHENTICATED: 'Not authenticated',
  ERR_NETWORK: 'Network error',
} as const;
