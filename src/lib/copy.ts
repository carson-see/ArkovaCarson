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
  OTHER: 'Other',
} as const;

export const CREDENTIAL_TYPE_DESCRIPTIONS = {
  DEGREE: 'Academic degree (e.g., Bachelor\'s, Master\'s, Doctorate)',
  LICENSE: 'Professional or occupational license',
  CERTIFICATE: 'Certificate of completion or achievement',
  TRANSCRIPT: 'Academic transcript or record of courses',
  PROFESSIONAL: 'Professional certification or accreditation',
  CLE: 'Continuing Legal Education credit',
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
  DOCUMENTS: 'Documents',
  MY_RECORDS: 'My Records',
  ORGANIZATION: 'Organization',
  SETTINGS: 'Settings',
  HELP: 'Help',
  SEARCH: 'Search',
  TREASURY: 'Treasury',
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
  NO_RESULTS: 'No results found',
  NO_RESULTS_DESC: 'Try a different search term or check the verification ID.',
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
  PUBLIC_PROFILE_DESC_ON: 'When enabled, your organization name appears in public search results and your credential registry is visible. Your email and internal data are never exposed.',
  PUBLIC_PROFILE_DESC_OFF: 'Your organization is not visible in public search results.',
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
  PAGE_TITLE: 'Treasury Dashboard',
  PAGE_SUBTITLE: 'Internal operations dashboard for Arkova platform administrators.',
  VAULT_SECTION: 'Treasury Vault',
  VAULT_ADDRESS: 'Address',
  VAULT_BALANCE: 'Balance (sats)',
  VAULT_NETWORK: 'Network',
  UTXO_SECTION: 'Unspent Outputs',
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
