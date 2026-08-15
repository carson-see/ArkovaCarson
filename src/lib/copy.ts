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
  SUPERSEDED: 'Superseded',
} as const;

export const ANCHOR_STATUS_DESCRIPTIONS = {
  PENDING: 'Your record is being secured. This typically completes within a few minutes.',
  SUBMITTED: 'Your record has been submitted to the network and is awaiting confirmation.',
  // SCRUM-2495 claims review (§1.5): permanence is bound to the record's
  // FINGERPRINT, not the underlying document. Arkova records and anchors the
  // fingerprint permanently; it does not store, monitor, or protect the
  // document itself after securing.
  SECURED: "Your record's fingerprint has been permanently secured with cryptographic verification.",
  REVOKED: 'This record has been revoked and is no longer active.',
  EXPIRED: 'This record has passed its expiration date.',
  SUPERSEDED: 'This record has been replaced by a newer version.',
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
  SUPERSEDED: 'Superseded',
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
  PROFESSIONAL: 'Professional Certification',
  CPE: 'CPE Credit',
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
  ACCREDITATION: 'Accreditation',
  // SCRUM-863 / SCRUM-1623 — pre/post-signing contract anchors. UI copy
  // uses neutral terminology ("Contract — Unsigned" / "Contract — Signed")
  // per CLAUDE.md §1.3 banned-words list (no "Wallet", "Crypto", etc.).
  CONTRACT_PRESIGNING: 'Contract — Unsigned',
  CONTRACT_POSTSIGNING: 'Contract — Signed',
  OTHER: 'Other',
} as const;

/** Map raw credential_type DB value to display label with fallback to title case. */
export function formatCredentialType(raw: string | null | undefined): string {
  if (!raw) return '—';
  const upper = raw.replace(/-/g, '_').toUpperCase();
  if (upper in CREDENTIAL_TYPE_LABELS) return CREDENTIAL_TYPE_LABELS[upper as keyof typeof CREDENTIAL_TYPE_LABELS];
  return raw.replaceAll('_', ' ').replaceAll(/\b\w/g, c => c.toUpperCase());
}

// Hoisted to module scope so it isn't rebuilt on every render call (this
// helper is invoked from the credential renderer on every list row).
const SUBTYPE_ACRONYMS: Readonly<Record<string, string>> = Object.freeze({
  rn: 'RN', lpn: 'LPN', np: 'NP', md: 'MD', do: 'DO', cpa: 'CPA',
  pe: 'PE', fe: 'FE', jd: 'JD', mba: 'MBA', cv: 'CV', cle: 'CLE',
  aws: 'AWS', cisco: 'Cisco', comptia: 'CompTIA', cfa: 'CFA',
  pmi: 'PMI', pmp: 'PMP', capm: 'CAPM', shrm: 'SHRM',
  isc2: 'ISC2', cissp: 'CISSP', sec: 'SEC', cdl: 'CDL',
  finra: 'FINRA', npi: 'NPI', dea: 'DEA', wes: 'WES', ece: 'ECE',
  cfr: 'CFR', dd214: 'DD214', va: 'VA', id: 'ID',
  ria: 'RIA', iapd: 'IAPD', '501c3': '501(c)(3)',
  pct: 'PCT', '10k': '10-K', '10q': '10-Q', '8k': '8-K',
  def14a: 'DEF 14A', s1: 'S-1',
});

/**
 * Map a snake_case credential SUB-TYPE (`professional_certification`,
 * `nursing_rn`, `bachelor`, `10k`, etc.) to a human-readable label.
 * SCRUM-952 fix: callers were rendering the parent `credential_type`
 * fallback ("Other") when the more specific subtype was already known.
 *
 * Strategy: title-case each underscore-separated segment, with
 * targeted overrides for tokens that have a canonical capitalization
 * (`md`, `pe`, `cle`, `cpa`, `cv`, `aws`, etc.) or are well-known acronyms.
 * Returns `'—'` for nullish inputs and `'Unclassified'` for `unclassified`.
 */
export function formatCredentialSubType(raw: string | null | undefined): string {
  if (!raw) return '—';
  if (raw === 'unclassified') return 'Unclassified';
  return raw
    .split('_')
    .map(seg => SUBTYPE_ACRONYMS[seg] ?? (seg.charAt(0).toUpperCase() + seg.slice(1)))
    .join(' ');
}

export const CREDENTIAL_TYPE_DESCRIPTIONS = {
  DEGREE: 'Academic degree (e.g., Bachelor\'s, Master\'s, Doctorate)',
  LICENSE: 'Professional or occupational license',
  CERTIFICATE: 'Certificate of completion or achievement',
  TRANSCRIPT: 'Academic transcript or record of courses',
  PROFESSIONAL: 'Professional certification or accreditation',
  CLE: 'Continuing Legal Education credit',
  BADGE: 'Digital badge or micro-certification (e.g., Credly, Acclaim)',
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
  ACCREDITATION: 'Accreditation issued by a recognized accrediting body',
  // SCRUM-863 / SCRUM-1623 — pre/post-signing contract anchors. Neutral
  // language per CLAUDE.md §1.3.
  CONTRACT_PRESIGNING: 'Contract pending signature',
  CONTRACT_POSTSIGNING: 'Executed contract with signatures',
  OTHER: 'Unclassified document',
} as const;

/**
 * Anonymized template descriptions for public-facing anchor metadata.
 * These replace raw file details with privacy-safe summaries.
 */
export const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  DEGREE: 'Verified Academic Degree',
  LICENSE: 'Verified Professional License',
  CERTIFICATE: 'Verified Certificate of Achievement',
  TRANSCRIPT: 'Verified Academic Record',
  PROFESSIONAL: 'Verified Professional Certification',
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
  ACCREDITATION: 'Verified Accreditation Record',
  CONTRACT_PRESIGNING: 'Verified Unsigned Contract Record',
  CONTRACT_POSTSIGNING: 'Verified Signed Contract Record',
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
  PAGE_SUBTITLE: 'All your records, documents, and attestations in one place.',
  TAB_ALL: 'All',
  TAB_RECORDS: 'My Records',
  TAB_CREDENTIALS: 'Issued to Me',
  TAB_ATTESTATIONS: 'Attestations',
  EMPTY_TITLE: 'No documents yet',
  EMPTY_DESC: 'Secure your first document, receive a record, or create an attestation to get started.',
  // SCRUM-2938 S1: "Issued to Me" tab empty state (moved out of inline JSX in
  // DocumentsPage per §1.3 / src/lib/agents.md). Generic securable/imported
  // items are "documents", not "credentials".
  RECEIVED_EMPTY_TITLE: 'No documents yet',
  RECEIVED_EMPTY_DESC: 'When organizations issue documents to your email address, they will appear here.',
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
  CREDENTIAL_TYPE: 'Document Type',
  CREDENTIAL_TYPE_PLACEHOLDER: 'Select a document type',
  LABEL: 'Label',
  LABEL_PLACEHOLDER: 'Enter a descriptive label for this document',
} as const;

// =============================================================================
// MESSAGES
// =============================================================================

export const MESSAGES = {
  // Success
  ANCHOR_CREATED: 'Your document has been submitted for securing.',
  // SCRUM-2495 claims review (§1.5): the fingerprint is permanently secured,
  // not the document itself (Arkova never stores or monitors the document).
  ANCHOR_SECURED: "Your document's fingerprint has been permanently secured.",
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
  TEMPLATE_PERMISSION_DENIED: 'Only organization admins can manage templates.',

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
  BULK_RECIPIENTS_FAILED: 'Bulk upload complete — {created} records created, but {failed} recipient invite(s) failed.',
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
  PAGE_TITLE: 'Verify a Document',
  PAGE_SUBTITLE: 'Check if a document has been secured with Arkova. Upload the file or enter its fingerprint to verify authenticity.',
  FORM_TITLE: 'Document Verification',
  FORM_SUBTITLE: 'Verify that a document matches a secured record',

  // Status badges
  STATUS_ACTIVE: 'Active',
  STATUS_REVOKED: 'Revoked',
  STATUS_EXPIRED: 'Expired',
  STATUS_SUPERSEDED: 'Superseded',

  // Section headings
  SECTION_STATUS: 'Verification Status',
  SECTION_CREDENTIAL: 'Record Details',
  SECTION_TIMELINE: 'Timeline',
  SECTION_PROOF: 'Network Proof',
  SECTION_DOCUMENT: 'Document Information',

  // Field labels
  ISSUER: 'Issuer',
  RECIPIENT_ID: 'Recipient Identifier',
  CREDENTIAL_TYPE: 'Document Type',
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
  ACTIVE_DESC: 'This record has been verified and is currently active.',
  REVOKED_DESC: 'This record has been revoked and is no longer valid.',
  EXPIRED_DESC: 'This record has passed its expiration date.',
  SUPERSEDED_DESC: 'This record has been replaced by a newer version.',
  NOT_FOUND_TITLE: 'Verification Failed',
  NOT_FOUND_DESC: 'The record you are looking for may not exist or has not been verified yet.',

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
  // Replaces "Block Height" — the banned-term version sat next to
  // NETWORK_RECEIPT / "Network Observed Time"; this keeps the trio coherent.
  NETWORK_CHECKPOINT: 'Network Checkpoint',
  // Network-observed-time honesty (BUG-2026-06-24-008, §1.5): the network has
  // only "observed" a record once it is SECURED. For unconfirmed records the
  // field falls back to CREATED_TIME (the local creation/upload time) under an
  // honest label — never the local time under the network label.
  NETWORK_OBSERVED_TIME: 'Network Observed Time',
  CREATED_TIME: 'Record Created',
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
  // BUG-C (BUG-2026-06-24-009 class): unlimited plans encode their monthly limit
  // as the sentinel 999999 (seed.sql:220). The checkout-success screen renders
  // this label via isUnlimitedRecordsLimit() instead of the raw sentinel.
  RECORDS_UNLIMITED: 'Unlimited records',
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
  // `useBilling.startCheckout` / `openBillingPortal` swallow failures and
  // resolve null (worker 400 when a plan has no stripe_price_id configured,
  // 401, 409, network error...). Without these the button would silently do
  // nothing — the same "is it broken or did I misclick?" dead end as the
  // no-op Upgrade button this release fixes.
  CHECKOUT_UNAVAILABLE: 'Could not start checkout for this plan. Please try again or contact support.',
  PORTAL_UNAVAILABLE: 'Could not open the billing portal. Please try again.',
} as const;

// =============================================================================
// WEBHOOKS
// =============================================================================

export const WEBHOOK_LABELS = {
  // BUG-D: deleting an endpoint is destructive — it silently stops the event
  // feed. The confirm dialog (mirrors RevokeDialog / ApiKeySettings) names the
  // endpoint and warns that notifications stop. `{url}` is interpolated by the
  // component. §1.3-clean (no banned terms).
  DELETE_CONFIRM_TITLE: 'Delete webhook endpoint?',
  DELETE_CONFIRM_DESC:
    'Event notifications to {url} will stop and this endpoint will be removed. This cannot be undone.',
  DELETE_CONFIRM_ACTION: 'Delete endpoint',
  DELETE_CONFIRM_CANCEL: 'Cancel',
  // Surfaced when enabling/disabling an endpoint is denied (e.g. RLS /
  // permission failure). The optimistic toggle reverts; this tells the user it
  // did not take, instead of a silent snap-back. No internal error detail is
  // leaked to the user. §1.3-clean (no banned terms).
  TOGGLE_ERROR: "Couldn't update this endpoint. You may not have permission. Please try again.",

  // ── WH-02 (SCRUM-2397): signed test ping ──────────────────────────────────
  // A test event signed with the endpoint's secret, so the receiver can verify
  // the same signature scheme production events use. §1.3-clean.
  TEST_PING_ACTION: 'Send test event',
  TEST_PING_SENDING: 'Sending…',
  TEST_PING_SUCCESS: 'Test event delivered and accepted (HTTP {status}). Your endpoint verified the signed request.',
  TEST_PING_FAILURE: 'Your endpoint did not accept the test event (HTTP {status}). Check that it verifies the signature and returns a 2xx response.',
  TEST_PING_ERROR: "Couldn't send the test event. Please try again.",
  TEST_PING_INACTIVE: 'Enable this endpoint before sending a test event.',

  // ── WH-03 (SCRUM-2398): delivery history + failed deliveries ─────────────
  DELIVERIES_TITLE: 'Delivery History',
  DELIVERIES_DESC: 'Recent event notifications sent to your endpoints. Only delivery details are shown — never document contents.',
  DELIVERIES_EMPTY: 'No deliveries yet. Events will appear here once your endpoints start receiving notifications.',
  DELIVERIES_ERROR: "Couldn't load delivery history. Please try again.",
  DELIVERIES_COL_EVENT: 'Event',
  DELIVERIES_COL_ENDPOINT: 'Endpoint',
  DELIVERIES_COL_STATUS: 'Status',
  DELIVERIES_COL_RESPONSE: 'Response',
  DELIVERIES_COL_ATTEMPT: 'Attempt',
  DELIVERIES_COL_TIME: 'Time',
  // Delivery status display labels (webhook_delivery_logs.status). A separate
  // domain from anchor/attestation statuses in statusDisplay.ts — do not merge.
  DELIVERY_STATUS_PENDING: 'Pending',
  DELIVERY_STATUS_SUCCESS: 'Delivered',
  DELIVERY_STATUS_FAILED: 'Failed',
  DELIVERY_STATUS_RETRYING: 'Retrying',
  REPLAY_ACTION: 'Resend',
  REPLAY_SENDING: 'Resending…',
  REPLAY_SUCCESS: 'Delivery resent. A new delivery record was created — the original is kept for audit.',
  REPLAY_FAILURE: 'Resend attempted but the endpoint did not accept it (HTTP {status}). The attempt was recorded.',
  REPLAY_ERROR: "Couldn't resend this delivery. Please try again.",
  REPLAY_ENDPOINT_INACTIVE: 'This endpoint is disabled. Enable it before resending.',

  FAILED_TITLE: 'Failed Deliveries',
  FAILED_DESC: 'Deliveries that exhausted all retries. Resend them from the history above, or dismiss them once handled.',
  FAILED_EMPTY: 'No failed deliveries. All event notifications were delivered or are still retrying.',
  FAILED_ERROR: "Couldn't load failed deliveries. Please try again.",
  FAILED_COL_ERROR: 'Last error',
  FAILED_COL_ATTEMPTS: 'Attempts',
  FAILED_COL_FAILED_AT: 'Failed at',
  DISMISS_ACTION: 'Dismiss',
  DISMISS_SUCCESS: 'Failed delivery dismissed.',
  DISMISS_ERROR: "Couldn't dismiss this entry. Please try again.",

  // ── WH-01 (SCRUM-2396): event catalog ─────────────────────────────────────
  CATALOG_TITLE: 'Available Events',
  CATALOG_DESC: 'Event types your endpoints can subscribe to, with the exact payload fields each one sends.',
  CATALOG_LIVE_BADGE: 'Active',
  CATALOG_DEFERRED_BADGE: 'Not yet active',
  CATALOG_DEFERRED_NOTE: 'You can subscribe now, but no events of this type are sent yet.',
  CATALOG_PAYLOAD_FIELDS_LABEL: 'Payload fields',
  // §1.5 / §1.13 R-7 honesty: states what payloads DO and DO NOT contain.
  CATALOG_REDACTION_NOTE:
    'Event payloads carry public record identifiers and status details only. They never include document contents, document fingerprints, personal information, or internal account identifiers.',
} as const;

// Per-event catalog descriptions (WH-01). Keyed by the same event ids as
// AVAILABLE_EVENTS in src/components/webhooks/WebhookSettings.tsx, which
// mirrors the worker allowlist (VALID_WEBHOOK_EVENTS). The live/deferred
// split and payload fields live beside AVAILABLE_EVENTS in
// src/components/webhooks/WebhookEventCatalog.tsx (technical data, verified
// against services/worker/src/webhooks/payload-schemas.ts). §1.3-clean.
export const WEBHOOK_EVENT_DESCRIPTIONS: Record<string, string> = {
  'anchor.submitted': 'A document record was submitted for securing.',
  'anchor.secured': 'A document record was secured and its Anchor Receipt details are available.',
  'anchor.revoked': 'A secured document record was revoked by its issuer.',
  'anchor.expired': 'A secured document record passed its expiration date.',
  'anchor.batch_secured': 'A group of document records was secured together in one Network Receipt.',
  'credential.issued': 'A credential was issued by a verified organization.',
  'credential.verified': 'A document record was confirmed as secured through a verification request.',
  'credential.status_changed': 'A document record moved to a different status.',
};

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
  REVOKE_FAILED: 'Failed to revoke key. It is still active — please try again.',
  DELETE_FAILED: 'Failed to delete key. Please try again.',
  NO_KEYS: 'No API keys yet. Create one to get started with the Verification API.',
  ACTIVE: 'Active',
  REVOKED: 'Revoked',
  EXPIRED: 'Expired',
  LAST_USED: 'Last used',
  NEVER_USED: 'Never used',
  FETCH_ERROR: 'Unable to load API keys. Please refresh and try again.',
  ORG_REQUIRED_TITLE: 'API keys require an organisation',
  ORG_REQUIRED_BODY: 'API keys are issued per organisation. Create or join one to start calling the Verification API.',
  ORG_REQUIRED_CTA: 'Create organisation',
  SCOPE_VERIFY: 'Verify',
  SCOPE_BATCH: 'Batch',
  SCOPE_USAGE: 'Usage',
  SCOPE_READ_SEARCH: 'Search',
  SCOPE_READ_RECORDS: 'Records',
  SCOPE_READ_ORGS: 'Organisations',
  SCOPE_WRITE_ANCHORS: 'Anchor writes',
  SCOPE_ADMIN_RULES: 'Rules admin',
  SCOPE_KEYS_MANAGE: 'Key management',
  SCOPE_COMPLIANCE_READ: 'Compliance read',
  SCOPE_COMPLIANCE_WRITE: 'Compliance write',
  SCOPE_ORACLE_READ: 'Oracle read',
  SCOPE_ORACLE_WRITE: 'Oracle write',
  SCOPE_ANCHOR_READ: 'Anchor reads',
  SCOPE_ATTESTATIONS_WRITE: 'Attestation writes',
  SCOPE_ATTESTATIONS_READ: 'Attestation reads',
  SCOPE_WEBHOOKS_MANAGE: 'Webhook management',
  SCOPE_AGENTS_MANAGE: 'Agent management',
  SCOPE_KEYS_READ: 'Key inventory',
  USAGE_TITLE: 'API Usage',
  USAGE_DESCRIPTION: 'Monitor your Verification API usage for the current billing period.',
  REQUESTS_USED: 'requests used',
  REQUESTS_REMAINING: 'requests remaining',
  MONTHLY_LIMIT: 'Monthly Limit',
  UNLIMITED_TIER: 'Unlimited',
  RESET_DATE: 'Resets on',
  PER_KEY_BREAKDOWN: 'Usage by Key',
  USAGE_UNAVAILABLE: 'Usage data unavailable — service not connected',
  USAGE_CREATE_KEY_HINT: 'Usage metrics will appear once you create your first API key',
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
  CREDENTIAL_DETAILS: 'Record Details',
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
  PROFILE_SCOPED_FLOW_UNAVAILABLE: 'This upload path is tied to your active organization. Use a single document here, or switch organizations before using bulk upload or attestation files.',
} as const;

// =============================================================================
// MIXED-FORMAT BATCH ANCHORING (SCRUM-2911 W1, founder P0 2026-07-28)
// =============================================================================

export const MIXED_BATCH_LABELS = {
  TITLE: 'Secure Multiple Documents',
  DESCRIPTION: 'Each file is fingerprinted on your device, then the batch is secured together.',
  FINGERPRINTING: 'Fingerprinting documents...',
  FINGERPRINTING_COUNT: '{done} of {total} fingerprinted',
  SUBMITTING: 'Securing {count} documents...',
  CANCEL: 'Cancel',
  DONE: 'Done',
  SECURE_MORE: 'Secure More Documents',
  RESULTS_HEADING: 'Results',
  SUMMARY_SECURED: 'Secured',
  SUMMARY_DUPLICATE: 'Already Secured',
  SUMMARY_FAILED: 'Failed',
  CREDITS_CONSUMED: '{count} credits used',
  STATUS_DUPLICATE: 'Already secured',
  STATUS_FAILED: 'Failed',
  STATUS_SECURED: 'Secured',
  FINGERPRINT_FAILED: 'Could not fingerprint this file.',
  NO_FILES_FINGERPRINTED: 'None of the selected files could be fingerprinted. Please try again.',
  ORG_REQUIRED: 'Securing multiple documents at once requires an organization account. Secure documents one at a time, or contact your organization to get access.',
  NETWORK_ERROR: 'Unable to reach the server. Please check your connection and try again.',
  SUBMIT_FAILED: 'Failed to secure the batch. Please try again.',
} as const;

// =============================================================================
// SECURE DOCUMENT FORM
// =============================================================================

export const SECURE_DOCUMENT_LABELS = {
  TITLE: 'Secure Document',
  DESCRIPTION: 'Create a verifiable document record for your organization.',
  PENDING_NOTICE: 'The record will be created with Pending status and assigned a unique verification ID immediately.',
  ISSUING_LOADING: 'Securing...',
  ISSUE_BUTTON: 'Secure Document',
  VERIFICATION_LINK: 'Verification Link',
  COPY_LINK_ARIA: 'Copy verification link',
  HINT_UPLOAD_DOCUMENT: 'Upload a document to continue.',
  HINT_SELECT_TYPE: 'Select a document type to continue.',
} as const;

// =============================================================================
// ISSUE CREDENTIAL DIALOG (SCRUM-1755)
// =============================================================================
// Distinct from SECURE_DOCUMENT_LABELS. Issue Credential is a restricted
// flow (verified orgs + approved sub-orgs only); Secure Document is the
// universal anchor flow available to everyone. Prior to SCRUM-1755 these
// were aliased, which conflated the two flows in the org-admin view.

export const ISSUE_CREDENTIAL_LABELS = {
  TITLE: 'Issue Credential',
  DESCRIPTION: 'Issue a verifiable credential to a recipient. Only verified organizations may issue credentials.',
  PENDING_NOTICE: 'The credential will be issued with Pending status and assigned a unique verification ID immediately.',
  ISSUING_LOADING: 'Issuing credential...',
  ISSUE_BUTTON: 'Issue Credential',
  ISSUE_ANOTHER: 'Issue another credential',
  VERIFICATION_LINK: 'Verification Link',
  COPY_LINK_ARIA: 'Copy verification link',
  HINT_UPLOAD_DOCUMENT: 'Upload a document to continue.',
  HINT_SELECT_TYPE: 'Select a credential type to continue.',
  HINT_PROOF_URL_INVALID: 'Proof URL must be a valid https:// link.',
  GATE_BLOCKED_TITLE: 'Issue Credential is unavailable',
  GATE_LOADING: 'Checking your organization’s authorization to issue credentials…',
  GATE_QUERY_ERROR: 'We could not verify your organization’s authorization right now. Please retry in a few seconds; if the issue persists, contact support.',
  GATE_NOT_VERIFIED: 'Your organization is not yet verified. Verified organizations can issue credentials. Contact support to start verification.',
  GATE_SUSPENDED: 'Your organization is currently suspended. Issue Credential is unavailable until the suspension is resolved.',
  GATE_PARENT_UNAPPROVED: 'Your sub-organization affiliation has not been approved by the parent organization. Ask a parent-org admin to approve your affiliation before issuing credentials.',
  GATE_PARENT_UNVERIFIED: 'Your parent organization is not verified. Sub-organizations can only issue credentials when the parent organization is verified.',
  GATE_PARENT_SUSPENDED: 'Your parent organization is currently suspended. Issue Credential is unavailable until the parent organization is reinstated.',
  PROOF_URL_LABEL: 'Public Proof URL',
  PROOF_URL_HELP: 'If this credential is also published online (Udemy, Accredible, LinkedIn Learning, your own website, etc.), paste the public link here. Recipients and verifiers can cross-check the credential against the public record.',
  PROOF_URL_PLACEHOLDER: 'https://www.udemy.com/certificate/UC-…',
  PROOF_URL_OPTIONAL: 'Optional, but strongly recommended when available.',
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
  RECORD_SUPERSEDED: 'Record Superseded',
  DOCUMENT_VERIFIED: 'Document Verified',
  VERIFIED_ON: 'Verified on {date}',
  REVOKED_DESC: 'This record has been revoked by the issuing organization',
  EXPIRED_DESC: 'This record has passed its expiration date',
  SUPERSEDED_DESC: 'This record has been replaced by a newer version.',
  // SCRUM-2495 claims review (§1.5): permanence is bound to the record's
  // FINGERPRINT, never the underlying document. The unscoped "This record is
  // permanently anchored." read as document-level protection, contradicting
  // the does-not-assert disclaimer rendered on the same page. The permanence
  // claim itself is real (anchor/fingerprint permanence is the product's core
  // value) — only its scope changed.
  VERIFIED_DESC: 'This record’s fingerprint is permanently anchored.',
  CRYPTOGRAPHIC_PROOF: 'Cryptographic Proof',
  FINGERPRINT_SHA256: 'Fingerprint (SHA-256)',
  NETWORK_RECEIPT: 'Network Receipt',
  NETWORK_RECORD: 'Network Record',
  NETWORK_RECORD_PREFIX: 'Network record: ',
  OBSERVED_TIME: 'Observed Time',
  LIFECYCLE: 'Lifecycle',
  SECURED_BY: 'Secured by Arkova',
  COPY_FINGERPRINT_ARIA: 'Copy document fingerprint',
  COPY_RECEIPT_ARIA: 'Copy network receipt',
  REPORT_ISSUE: 'Report an Issue',
  REPORT_ISSUE_SUBJECT: 'Issue with record',
} as const;

// =============================================================================
// DOES-NOT-ASSERT DISCLAIMER (SCRUM-2495 / ABUSE-DISCLAIMER)
// =============================================================================
// Always-visible block on the proof/verification surface stating what an
// Arkova anchor MEASURES, ASSERTS, and does NOT assert (CLAUDE.md §1.5).
// This replaces the prior ad-hoc disclaimer paragraph that was written
// directly in PublicVerification.tsx JSX (banned per §6 "Text directly in
// JSX") and that also contained a banned-terminology violation ("Bitcoin
// blockchain", §1.3) invisible to lint:copy only because the two words fell
// on the same un-quoted, tag-free JSX text line (a scanner blind spot — see
// PublicVerification.test.tsx for the regression coverage). Jurisdiction tags
// are informational metadata only, never a legal claim (§1.5).
export const DOES_NOT_ASSERT_LABELS = {
  TITLE: 'What This Anchor Does and Does Not Assert',
  MEASURED_LABEL: 'Measured',
  MEASURED_BODY:
    'The document Fingerprint (a cryptographic digest of the file) at a specific point in time, and the Network Observed Time at which that fingerprint was recorded.',
  ASSERTED_LABEL: 'Asserted',
  // §1.5 claims discipline (Carson P1 review): do NOT say "and have not been
  // altered since" — Arkova does not monitor the document after securing and
  // makes no post-securing immutability claim about it. What the record
  // proves: the fingerprint existed and the record reached Secured status at
  // the recorded time. A document altered later simply produces a different
  // fingerprint that will not match this record.
  ASSERTED_BODY:
    'That this record reached Secured status — its fingerprint and existence were confirmed at the time of securing shown on this record. Arkova does not monitor or make any claim about the document after that moment; a document altered later would produce a different fingerprint and simply would not match this record.',
  NOT_ASSERTED_LABEL: 'Not Asserted',
  NOT_ASSERTED_BODY:
    'The identity of the signer or uploader, the legal validity of the underlying document, or any jurisdiction. Jurisdiction tags shown elsewhere on this record are informational metadata only — not a legal claim. Relying parties should exercise their own due diligence.',
} as const;

// =============================================================================
// AUDIT CERTIFICATE PDF (PROOF-04 / SCRUM-2337)
// =============================================================================
//
// Copy for the downloadable audit-certificate PDF. The certificate embeds a
// machine-readable proof packet plus an "verify offline" instruction block so
// a third party can independently re-check the document. All strings here are
// §1.3-compliant (no Wallet / Hash / Transaction / Block / Bitcoin / …).

export const CERTIFICATE_COPY = {
  TITLE: 'Arkova Verification Certificate',
  GENERATED_AT: 'Generated: {date}',
  VERIFICATION_ID: 'Verification ID: {id}',
  STATUS_LABEL: 'Status: {status}',

  SECTION_DOCUMENT: 'Document Information',
  SECTION_ISSUER: 'Issuer',
  SECTION_PROOF: 'Cryptographic Proof',
  SECTION_LIFECYCLE: 'Lifecycle',
  SECTION_MACHINE_PROOF: 'Machine-Readable Proof Packet',
  SECTION_OFFLINE_VERIFY: 'Verify This Certificate Offline',

  FIELD_FILENAME: 'Filename',
  FIELD_FILE_SIZE: 'File Size',
  FIELD_CREDENTIAL_TYPE: 'Document Type',
  FIELD_ORGANIZATION: 'Organization',
  FIELD_ISSUED: 'Issued',
  FIELD_FINGERPRINT: 'Fingerprint (SHA-256)',
  FIELD_NETWORK_RECEIPT: 'Network Receipt',
  FIELD_NETWORK_RECORD: 'Network Record',
  FIELD_VERIFICATION_TREE_ROOT: 'Verification Tree Root',
  FIELD_VERIFICATION_PATH: 'Verification Path',
  FIELD_RECORD_POSITION: 'Record Position',
  FIELD_LEAF_COUNT: 'Tree Leaf Count',
  FIELD_PROOF_SCHEMA: 'Proof Schema Version',
  // Human-readable label only — the embedded machine field is `block_timestamp`.
  FIELD_OBSERVED_TIME: 'Network Observed Time',
  FIELD_SIGNATURE: 'Signature',
  FIELD_CREATED: 'Created',
  FIELD_SECURED: 'Secured',
  FIELD_EXPIRES: 'Expires',
  FIELD_REVOKED: 'Revoked',
  FIELD_REVOCATION_REASON: 'Revocation Reason',

  // Offline-verify instructions. The proof packet below is everything a
  // verifier needs to re-check this document without contacting Arkova.
  OFFLINE_VERIFY_INTRO:
    'This certificate carries a complete, machine-readable proof packet (below). Anyone can re-check it independently:',
  // Shown when the proof packet is missing a field required to run every offline
  // check (e.g. the batch tree leaf count could not be sourced). The packet is
  // still embedded for inspection, but the certificate does NOT claim it can run
  // every check, so the reader is not misled (§1.5 — measured vs not asserted).
  OFFLINE_VERIFY_INTRO_INCOMPLETE:
    'This certificate carries a machine-readable proof packet (below), but one or more fields needed to run every offline check could not be sourced for this record. Use the packet for inspection; some checks may not be runnable:',
  OFFLINE_VERIFY_STEP_1:
    '1. Compute the SHA-256 fingerprint of your copy of the document and confirm it matches the Fingerprint field.',
  OFFLINE_VERIFY_STEP_2:
    '2. Walk the Verification Path from the fingerprint to the Verification Tree Root.',
  OFFLINE_VERIFY_STEP_3:
    '3. Confirm the Verification Tree Root appears in the referenced Network Record on the public network.',
  OFFLINE_VERIFY_TOOL:
    'Reference verifier: https://arkova.ai/verify — paste the proof packet to run all checks in your browser.',
  MACHINE_PROOF_NOTE:
    'The JSON below is also embedded in this file’s document properties for automated extraction.',

  DISCLAIMER_OBSERVED:
    'This certificate was generated by Arkova. It asserts that the document fingerprint was observed at the stated time.',
  DISCLAIMER_NOT_ASSERTED:
    'This certificate does NOT assert the accuracy of document contents, the identity of the issuer, or the validity of the document itself.',
} as const;

// =============================================================================
// ANCHORING STATUS (UF-04)
// =============================================================================

export const ANCHORING_STATUS_LABELS = {
  PENDING_TITLE: 'Anchoring In Progress',
  PENDING_SUBTITLE: 'Your document has been submitted for anchoring. This typically takes 5\u201315 minutes.',
  PENDING_PUBLIC_TITLE: 'Submitting to network...',
  PENDING_PUBLIC_SUBTITLE: 'This record is being submitted. Check back shortly for confirmation.',
  // SCRUM-952 \u2014 SUBMITTED is distinct from PENDING. SUBMITTED means the
  // anchor has been broadcast to the network and is awaiting on-network
  // confirmation; the hero must NOT show a green "Verified" affordance
  // because the record is not yet immutable. The badge string itself
  // already lives at ANCHOR_STATUS_LABELS.SUBMITTED \u2014 we don't redeclare
  // it here.
  SUBMITTED_PUBLIC_TITLE: 'Record Submitted \u00b7 Awaiting Network Confirmation',
  SUBMITTED_PUBLIC_SUBTITLE: 'Finalization usually takes \u224860 minutes once the network observes the next checkpoint.',
  PENDING_BADGE: 'Processing',
  SUBMITTED_BADGE: 'Awaiting Confirmation',
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
  SECTION_TITLE: 'Record Details',
  REQUIRED_MARKER: '*',
  OPTIONAL: '(optional)',
  SELECT_PLACEHOLDER: 'Select...',
  FILE_PREVIEW_TITLE: 'Document Preview',
  FILE_NAME: 'Filename',
  FILE_SIZE: 'Size',
  FINGERPRINT_PREVIEW: 'Fingerprint',
  NO_TEMPLATE: 'No template found for this document type. Metadata fields will be available after a template is created.',
  LOADING_TEMPLATE: 'Loading template fields...',
  RECIPIENT_EMAIL: 'Recipient Email',
  RECIPIENT_EMAIL_PLACEHOLDER: 'recipient@example.com',
  RECIPIENT_EMAIL_DESCRIPTION: 'The recipient will be able to view this record in their inbox.',
} as const;

// =============================================================================
// PUBLIC SEARCH (UF-02)
// =============================================================================

export const SEARCH_LABELS = {
  PAGE_TITLE: 'Search Records',
  PAGE_SUBTITLE: 'Find verified records by issuer, verification ID, or document fingerprint.',
  SEARCH_PLACEHOLDER: 'Search by issuer name or verification ID...',
  SEARCH_BY_ID: 'Verification ID',
  SEARCH_BY_ISSUER: 'Issuer',
  SEARCH_BY_FINGERPRINT: 'Fingerprint',
  FINGERPRINT_PLACEHOLDER: 'Paste a 64-character document fingerprint...',
  SEARCH_BUTTON: 'Search',
  NO_RESULTS: 'No records found',
  NO_RESULTS_FOR: 'No results for "{query}"',
  NO_RESULTS_DESC: 'No public records match your search.',
  NO_ISSUERS: 'No issuers found',
  NO_ISSUERS_DESC: 'No public issuers match your search.',
  ISSUER_REGISTRY_TITLE: 'Issuer Registry',
  CREDENTIALS_COUNT: '{count} verified records',
  VIEW_REGISTRY: 'View Records',
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
  NO_PERSONS_DESC: 'No public records match this name.',
  PERSON_CREDENTIALS: 'Verified Records',
  SEARCH_ERROR: 'Search failed. Please try again.',
} as const;

// =============================================================================
// SEMANTIC SEARCH (SCRUM-1958 — AI natural-language credential search)
// =============================================================================
// User-visible copy for the authenticated, AI-powered semantic search panel on
// the dashboard. Gated behind ENABLE_SEMANTIC_SEARCH. Respects Constitution
// §1.3 terminology bans (no Wallet/Hash/Transaction/etc.) — "Fingerprint" is
// the approved term and match strength is shown as a friendly percentage, never
// a raw vector score.
export const SEMANTIC_SEARCH_LABELS = {
  HEADING: 'Smart Search',
  SUBHEADING: 'Find your secured documents by describing them in your own words.',
  PLACEHOLDER: 'Describe what you are looking for…',
  SEARCH_BUTTON: 'Search',
  SEARCHING: 'Searching…',
  RESULTS_COUNT: '{count} result{plural} found',
  CREDITS_REMAINING: '{count} AI credit{plural} remaining',
  DOCUMENT_LABEL: 'Document',
  MATCH_LABEL: '{percent}% match',
  MATCH_STRENGTH_STRONG: 'Strong match',
  MATCH_STRENGTH_GOOD: 'Good match',
  MATCH_STRENGTH_FAIR: 'Fair match',
  STATUS_SECURED: 'Secured',
  STATUS_PENDING: 'Pending',
  STATUS_UNAVAILABLE: 'Unavailable',
  // Honest empty state — embeddings may legitimately return nothing.
  EMPTY_TITLE: 'No matching documents',
  EMPTY_DESC: 'Try describing the document differently, or search by issuer or fingerprint instead.',
  CLEAR_BUTTON: 'Clear search',
  // Error states — friendly, non-technical copy.
  ERROR_AUTH: 'Please sign in to search your documents.',
  ERROR_NO_CREDITS: 'You are out of AI credits. Upgrade your plan to keep using smart search.',
  ERROR_UNAVAILABLE: 'Smart search is temporarily unavailable. Please try again in a few minutes.',
  ERROR_NETWORK: 'Could not reach the service. Check your connection and try again.',
  ERROR_GENERIC: 'Search failed. Please try again.',
} as const;

// =============================================================================
// DASHBOARD
// =============================================================================

export const DASHBOARD_STATS_LABELS = {
  TOTAL_RECORDS: 'Total Records',
  SECURED: 'Secured',
  PENDING: 'Pending',
  UNAVAILABLE_VALUE: 'Unavailable',
  ERROR_DESCRIPTION: 'Stats unavailable. Refresh to try again.',
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
  VIEW_ISSUER_REGISTRY: 'View all records from this issuer',
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
// PROOF AVAILABILITY (FE-PROOF-GATE / SCRUM-2501)
// =============================================================================
// Copy for the public verification page's proof-download states, per
// docs/reference/FE_PROOF_GATE_CONTRACT.md \u00a73.1. State 2 (the honest core \u2014
// SECURED but no downloadable proof file, i.e. the ~2.97M direct-anchored
// back catalogue) renders NO download control at all; this copy affirms the
// record's standing first and explains availability honestly. It never promises
// a date, implies the user must act, or references receipt fields that may be
// absent on direct-anchored records.
export const PROOF_AVAILABILITY_LABELS = {
  // State 2 / 1b \u2014 honest empty-state. No disabled button, no error toast.
  NOT_YET_AVAILABLE_TITLE: 'Secured & Anchored',
  NOT_YET_AVAILABLE_BODY:
    'This record is protected on the Production Network. The Fingerprint and verification details above are its proof of standing. A downloadable proof file becomes available for records secured through batch anchoring.',
  // State 3 (record not yet SECURED) has no entry here: the page-level hero
  // state machine ("Submitting to Network\u2026", proof sections hidden \u2014 see
  // src/components/verification/agents.md) IS the securing-in-progress
  // presentation, and VerifierProofDownload is never mounted pre-SECURED.
  // Record not found (404 "Record not found") \u2014 a real error, not state 2.
  RECORD_MISSING: 'This record could not be found.',
  // 5xx, malformed 200 (verified:false) \u2014 retryable, never state-2 copy.
  RETRY_TITLE: 'Proof File Unavailable',
  RETRY_BODY: 'The proof file could not be loaded right now. Please try again.',
  RETRY_BUTTON: 'Retry',
} as const;

// =============================================================================
// PUBLIC ATTESTATION VERIFY
// =============================================================================

export const PUBLIC_ATTESTATION_VERIFY_LABELS = {
  BRAND: 'Arkova',
  SIGN_IN: 'Sign in',
  PAGE_TITLE: 'Attestation Verification',
  PAGE_SUBTITLE: 'Verify the authenticity and status of an attestation',
  VERIFYING: 'Verifying attestation...',
  NOT_FOUND: 'Attestation Not Found',
  TRY_ANOTHER: 'Try Another Verification',
  EXPIRED_NOTICE: 'This attestation has expired',
  REVOKED_NOTICE: 'This attestation has been revoked',
  REASON_PREFIX: 'Reason:',
  DETAILS_TITLE: 'Attestation Details',
  EVIDENCE_PREFIX: 'Evidence:',
  EVIDENCE: 'Evidence',
  LINKED_CREDENTIAL: 'Linked Record',
  ATTESTOR_CREDENTIAL_CHAIN: 'Attestor Record Chain',
  VERIFY_CREDENTIAL: 'Verify Record',
  VERIFY: 'Verify',
  BYTES_SUFFIX: ' bytes',
  FOOTER_TAGLINE: 'Arkova — Secure document verification platform',
  FOOTER_PRIVACY: 'Privacy',
  FOOTER_TERMS: 'Terms',
} as const;

export const EVIDENCE_PAYLOAD_ERROR = 'Evidence metadata is invalid. Check fingerprints, file names, and descriptions.';

// =============================================================================
// ATTESTATION UI (SCRUM-1874 — DocuSign integration attestation display)
// =============================================================================

export const ATTESTATION_LABELS = {
  // Status card
  STATUS_CARD_TITLE: 'Attestation Status',
  STATUS_DRAFT: 'Draft',
  STATUS_DRAFT_DESC: 'This attestation is in draft and has not been submitted.',
  STATUS_PENDING: 'Pending',
  STATUS_PENDING_DESC: 'This attestation has been submitted and is awaiting network confirmation.',
  STATUS_ACTIVE: 'Active',
  STATUS_ACTIVE_DESC: 'This attestation is verified and currently active.',
  STATUS_REVOKED: 'Revoked',
  STATUS_REVOKED_DESC: 'This attestation has been revoked and is no longer valid.',
  STATUS_EXPIRED: 'Expired',
  STATUS_EXPIRED_DESC: 'This attestation has passed its expiration date.',
  STATUS_CHALLENGED: 'Challenged',
  STATUS_CHALLENGED_DESC: 'This attestation has been challenged and is under review.',

  // Notarization badge
  NOTARIZED: 'Notarized',
  NOTARIZED_VIA_DOCUSIGN: 'Notarized via DocuSign',
  NOTARIZATION_PENDING: 'Notarization Pending',
  NOTARIZATION_COMPLETED: 'Notarization Completed',
  NOTARY_NAME: 'Notary',
  NOTARY_COMMISSION: 'Commission',
  NOTARY_STATE: 'State',
  NOTARIZED_ON: 'Notarized on',
  ENVELOPE_ID: 'Envelope ID',
  ESIGN_COMPLETED: 'E-Signature Completed',
  ESIGN_COMPLETED_ON: 'Completed on',

  // Verification result
  VERIFICATION_RESULT_TITLE: 'Verification Result',
  VERIFICATION_PASSED: 'Verification Passed',
  VERIFICATION_PASSED_DESC: 'This attestation has been verified against the network record.',
  VERIFICATION_FAILED: 'Verification Failed',
  VERIFICATION_FAILED_DESC: 'This attestation could not be verified against the network record.',
  VERIFICATION_PENDING: 'Verification Pending',
  VERIFICATION_PENDING_DESC: 'Network confirmation is in progress. Check back shortly.',
  NETWORK_RECEIPT: 'Network Receipt',
  NETWORK_CHECKPOINT: 'Network Checkpoint',
  NETWORK_OBSERVED_TIME: 'Network Observed Time',
  FINGERPRINT: 'Document Fingerprint',
  COPY_FINGERPRINT: 'Copy fingerprint',
  COPY_RECEIPT: 'Copy network receipt',
  COPIED: 'Copied',

  // Detail labels
  ATTESTATION_TYPE: 'Attestation Type',
  SUBJECT: 'Subject',
  ATTESTER: 'Attester',
  ATTESTER_TYPE: 'Attester Type',
  JURISDICTION: 'Jurisdiction',
  CLAIMS: 'Claims',
  SUMMARY: 'Summary',
  ISSUED: 'Issued',
  EXPIRES: 'Expires',
  CREATED: 'Created',
  PUBLIC_ID: 'Verification ID',
  EVIDENCE_COUNT: 'Supporting Evidence',
  VIEW_VERIFICATION: 'View Verification',

  // Empty state
  NO_ATTESTATIONS: 'No attestations yet',
  NO_ATTESTATIONS_DESC: 'Create an attestation to verify, endorse, or audit a record.',
  CREATE_ATTESTATION: 'Create Attestation',

  // Page chrome
  PAGE_TITLE: 'Attestations',
  PAGE_SUBTITLE: 'Create and manage immutable attestations anchored to the network',
  CREATE_PORTFOLIO: 'Create Portfolio',
  BULK_ISSUE: 'Bulk Issue',
  NEW_ATTESTATION: 'New Attestation',
  CREATE_NEW_ATTESTATION: 'Create New Attestation',
  YOUR_ATTESTATIONS: 'Your Attestations',
  EMPTY_CTA: 'Create your first attestation to anchor a verifiable claim',

  // Form labels
  SUBJECT_TYPE: 'Subject Type',
  SUBJECT_REQUIRED: 'Subject *',
  SUBJECT_HINT: 'What is being attested (auto-generates ID like ARK-UMI-VER-A3F2B1)',
  ATTESTER_NAME_REQUIRED: 'Attester Name *',
  TITLE_ROLE: 'Title / Role',
  CLAIMS_REQUIRED: 'Claims *',
  ADD_CLAIM: 'Add Claim',
  EXPIRES_AT_OPTIONAL: 'Expires At (optional)',
  CREATING: 'Creating...',

  // Form placeholders
  PLACEHOLDER_ATTESTER_NAME: 'Your name or organization',
  PLACEHOLDER_TITLE: 'e.g., General Counsel, CPA',
  PLACEHOLDER_CLAIM: 'Claim statement',
  PLACEHOLDER_EVIDENCE: 'Supporting evidence (optional)',
  PLACEHOLDER_SUMMARY: 'Brief description of this attestation',
  PLACEHOLDER_JURISDICTION: 'e.g., US, EU, UK',

  // Subject type options
  SUBJECT_CREDENTIAL: 'Record',
  SUBJECT_ENTITY: 'Entity / Organization',
  SUBJECT_PROCESS: 'Process / Procedure',
  SUBJECT_ASSET: 'Asset / Document',

  // Templates
  TEMPLATE_PROMPT: 'Choose a template or create a custom attestation',
  TEMPLATE_EMPLOYMENT: 'Employment Verification',
  TEMPLATE_EMPLOYMENT_DESC: 'Verify employment dates, title, and status',
  TEMPLATE_EDUCATION: 'Education Record',
  TEMPLATE_EDUCATION_DESC: 'Issue tamper-proof degree or certification',
  TEMPLATE_CUSTOM: 'Custom Attestation',
  TEMPLATE_CUSTOM_DESC: 'Create any type of attestation',

  // Revoke dialog
  REVOKE: 'Revoke',
  REVOKE_TITLE: 'Revoke Attestation',
  REVOKE_WARNING: 'This action is permanent. The attestation will be marked as revoked and its verification status will reflect this change.',
  REVOKE_REASON_LABEL: 'Reason for Revocation *',
  REVOKE_REASON_HINT: 'Minimum 3 characters required',
  REVOKE_REASON_PLACEHOLDER: 'Describe why this attestation is being revoked',
  REVOKE_CONFIRM_LABEL: 'to confirm',
  REVOKING: 'Revoking...',

  // Table headers
  TABLE_ID: 'ID',
  TABLE_SUBJECT: 'Subject',
  TABLE_ATTESTER: 'Attester',
  TABLE_STATUS: 'Status',
  TABLE_CREATED: 'Created',
} as const;

// =============================================================================
// MY CREDENTIALS / RECIPIENT INBOX (UF-03)
// =============================================================================

export const MY_CREDENTIALS_LABELS = {
  // SCRUM-2938 S1: this surface is the generic "Imported Records" inbox — the
  // securable/imported documents it lists are labelled "documents", not the
  // restricted "credentials" term (§1.3 generic-action wording). The SCRUM-1672
  // "Issue Credential" restricted issuance flow is untouched (see
  // ISSUE_CREDENTIAL_LABELS / CREDENTIAL_ISSUE_FAILED).
  PAGE_TITLE: 'Imported Records',
  PAGE_SUBTITLE: 'Documents issued to you or imported from public sources.',
  NAV_LABEL: 'Imported Records',
  EMPTY_TITLE: 'No documents yet',
  EMPTY_DESC: 'When organizations issue documents to your email address, they will appear here.',
  ISSUED_BY: 'Issued by',
  RECEIVED_ON: 'Received',
  VIEW_CREDENTIAL: 'View',
  VERIFY_CREDENTIAL: 'Verify',
  ADD_SOURCE: 'Add Source',
  ADD_FROM_REGISTRY: 'From Public Registry',
  CLAIMED: 'Claimed',
  UNCLAIMED: 'Pending',
  CREDENTIAL_COUNT: '{count} documents',
} as const;

export const CREDENTIAL_SOURCE_IMPORT_LABELS = {
  TITLE: 'Add Record Source',
  DESCRIPTION: 'Import a public record source URL.',
  URL_LABEL: 'Record source URL',
  URL_PLACEHOLDER: 'https://',
  TYPE_LABEL: 'Record type',
  ISSUER_LABEL: 'Issuer',
  ISSUED_FIELD: 'Issued',
  EXPIRES_FIELD: 'Expires',
  SOURCE_FIELD: 'Source',
  PROVIDER_FIELD: 'Provider',
  RECIPIENT_FIELD: 'Recipient',
  RECIPIENT_PROOF_FIELD: 'Recipient Proof',
  // SCRUM-2914: CONFIDENCE_FIELD removed — extraction confidence scoring is
  // unreliable and is no longer surfaced anywhere in the UI. Do not re-add.
  EVIDENCE_FIELD: 'Evidence',
  PAYLOAD_FIELD: 'Payload',
  NOT_DETECTED: 'Not detected',
  CANCEL: 'Cancel',
  PREVIEW: 'Preview',
  ADD: 'Add',
  PREVIEW_FAILED: 'Preview failed',
  IMPORT_FAILED: 'Import failed',
  REQUEST_FAILED: 'Request failed',
  TOAST_ADDED: 'Record source added',
  TOAST_DUPLICATE: 'Record source already added',
} as const;

// =============================================================================
// PUBLIC REGISTRY IMPORT (L3-A6 — CE Noncredit Data Taxonomy anchoring POC)
// =============================================================================
// SCRUM-1672-safe: "registry record" / "public registry", never "Issue
// Credential". §1.3 banned-term-safe: "Fingerprint" not "Hash", no chain
// terminology anywhere in this surface.

export const CE_REGISTRY_IMPORT_LABELS = {
  BUTTON: 'From Public Registry',
  TITLE: 'Add from Public Registry',
  DESCRIPTION: 'Look up a public registry record by its identifier and add a tamper-evident copy to your records.',
  CTID_LABEL: 'Registry identifier',
  CTID_PLACEHOLDER: 'ce-00000000-0000-0000-0000-000000000000',
  LOOKUP: 'Look Up',
  LOOKING_UP: 'Looking up…',
  ADD: 'Add Record',
  ADDING: 'Adding…',
  CANCEL: 'Cancel',
  RECORD_TYPE_FIELD: 'Record Type',
  ISSUER_FIELD: 'Issuer',
  RETRIEVED_FIELD: 'Retrieved',
  FINGERPRINT_FIELD: 'Fingerprint',
  REGISTRY_LINK_FIELD: 'Registry Source',
  NOT_DETECTED: 'Not detected',
  LOOKUP_FAILED: 'Lookup failed',
  ADD_FAILED: 'Add failed',
  REQUEST_FAILED: 'Request failed',
  NOT_FOUND: 'No record found for this identifier.',
  NO_RECORD: 'This registry record has nothing Arkova can add yet.',
  TOAST_ADDED: 'Registry record added',
  TOAST_DUPLICATE: 'Registry record already added',
  CHANGED_ERROR: 'The registry record changed since lookup. Look it up again before adding.',
  VIEW_RECORD: 'View record',
} as const;

// =============================================================================
// SHARE FLOW (UF-08)
// =============================================================================

export const SHARE_LABELS = {
  SHARE_BUTTON: 'Share',
  SHARE_TITLE: 'Share Record',
  SHARE_DESCRIPTION: 'Share the verification link for this record.',
  COPY_LINK: 'Copy Verification Link',
  LINK_COPIED: 'Verification link copied to clipboard',
  COPIED_TOAST: 'Copied to clipboard',
  QR_CODE: 'QR Code',
  QR_DESCRIPTION: 'Scan to verify this record',
  EMAIL_SHARE: 'Share via Email',
  EMAIL_SUBJECT: 'Verify my record on Arkova',
  CLOSE: 'Close',
} as const;

// =============================================================================
// LINKEDIN SHARE (BETA-09)
// =============================================================================

export const LINKEDIN_LABELS = {
  SHARE_BUTTON: 'Share on LinkedIn',
  SHARE_TEXT_WITH_TYPE: 'My {type} has been independently verified on Arkova. Verify it here:',
  SHARE_TEXT_DEFAULT: 'My document has been independently verified on Arkova. Verify it here:',
  GET_BADGE: 'Get Badge',
  BADGE_TITLE: 'Verification Badge',
  BADGE_DESCRIPTION: 'Embed this badge in your LinkedIn profile or website to showcase your verified document.',
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
  FIELD_PLACEHOLDER: 'Brief description of what this document represents (max 500 characters)',
  FIELD_HELP: 'This description will be permanently associated with your record.',
} as const;

// =============================================================================
// REALTIME STATUS TOASTS (BETA-13)
// =============================================================================

export const REALTIME_TOAST_LABELS = {
  SECURED: 'Your document has been secured on the network.',
  REVOKED: 'This record has been revoked.',
  EXPIRED: 'This record has expired.',
  SUBMITTED: 'Your document has been submitted and is awaiting confirmation.',
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
  BREADCRUMB_CREDENTIAL_TEMPLATES: 'Document Templates',
  BREADCRUMB_WEBHOOKS: 'Webhooks',
  BREADCRUMB_API_KEYS: 'API Keys',
  AUTH_REDIRECT_TOAST: 'Please sign in to access that page',
  SIGN_OUT: 'Sign Out',
  COLLAPSE: 'Collapse',
  PUBLIC_PROFILE_DESC_ON: 'When enabled, your name appears in public search results and your record registry is visible. Your email and internal data are never exposed.',
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
  STEP_TEMPLATE: 'Create a document template',
  STEP_TEMPLATE_DESC: 'Define the fields for your documents.',
  STEP_ISSUE: 'Secure your first document',
  STEP_ISSUE_DESC: 'Secure a document and create a verifiable record.',
  STEP_BILLING: 'Set up billing',
  STEP_BILLING_DESC: 'Choose a plan to unlock more records.',
  // INDIVIDUAL steps
  STEP_SECURE: 'Secure your first document',
  STEP_SECURE_DESC: 'Create a permanent, tamper-proof record.',
  STEP_SHARE: 'Share your verification link',
  STEP_SHARE_DESC: 'Let others verify your document.',
  // Empty states
  EMPTY_ORG_RECORDS: 'No documents secured yet',
  EMPTY_ORG_RECORDS_DESC: 'Secure your first document to get started.',
  EMPTY_ORG_RECORDS_CTA: 'Secure Document',
  EMPTY_INDIVIDUAL_RECORDS: 'Your vault is empty',
  EMPTY_INDIVIDUAL_RECORDS_DESC: 'Secure your first document to create a permanent record.',
  EMPTY_INDIVIDUAL_RECORDS_CTA: 'Secure Document',
} as const;

// =============================================================================
// ORGANIZATION PAGE
// =============================================================================

export const ORG_PAGE_LABELS = {
  INVITE_MEMBER: 'Invite Member',
  // SCRUM-1755 — primary CTA on the org page is the universal "Secure Document"
  // button. Bulk upload is auto-detected inside Secure Document; no separate
  // bulk-vs-single chooser is exposed. The legacy BULK_UPLOAD / BULK_UPLOAD_DIALOG_TITLE
  // strings are retained for any out-of-tree usage but should not be wired into new UI.
  SECURE_DOCUMENT: 'Secure Document',
  SECURE_DOCUMENT_MOBILE: 'Secure',
  ISSUE_CREDENTIAL: 'Issue Credential',
  ISSUE_CREDENTIAL_MOBILE: 'Issue',
  FOUNDED: 'Founded',
  /** @deprecated SCRUM-1755 — Secure Document auto-detects bulk; do not render a separate Bulk Upload button. */
  BULK_UPLOAD: 'Bulk Upload',
  /** @deprecated SCRUM-1755 — Secure Document auto-detects bulk; do not render a separate Bulk Upload dialog. */
  BULK_UPLOAD_DIALOG_TITLE: 'Bulk Upload',
  PROMOTE_TO_ADMIN: 'Promote to Admin',
  DEMOTE_TO_MEMBER: 'Demote to Member',
  RECIPIENT: 'Recipient',
  ABOUT: 'About',
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
  EXTRACT_DESCRIPTION: 'Automatically extract key fields from the uploaded document',
  EXTRACTION_FAILED_TOAST: 'AI extraction unavailable — document will be secured without metadata.',
  /**
   * SCRUM-2911 — BENIGN no-text soft-fail. Shown when extraction ran fine but
   * found no readable text — the classic case is a scanned (image-only) PDF
   * whose text layer is empty, or a blank photo. NOT a privacy failure: the
   * pipeline ran on-device and nothing left the browser. Fixed copy — never
   * interpolates document-derived text.
   */
  NO_TEXT_FOUND:
    'No readable text was found in this document — it may be a scanned image. You can try a clearer copy, enter details manually, or secure it without AI metadata. Your file never left your device.',
  /**
   * §1.6 FAIL-CLOSED (WEBEXT-03). Shown when the on-device privacy tools (the
   * personal-information remover or the on-device document reader) could not
   * run, so nothing was analyzed and nothing was sent. This is a LOUD failure,
   * deliberately distinct from EXTRACTION_FAILED_TOAST — we did NOT proceed.
   */
  PRIVACY_GUARANTEE_FAILED:
    'On-device privacy protection couldn’t run, so this document was not analyzed and nothing was sent. Your file never left your device. Reload and try again, or continue without AI metadata.',
} as const;

// =============================================================================
// §1.6 ON-DEVICE PRIVACY FAIL-CLOSED (WEBEXT-03 / SCRUM-2505)
// Loud, explicit failure surface for when on-device PII stripping or OCR could
// not run. The whole point: the user is told plainly that nothing was sent.
// =============================================================================

export const PRIVACY_FAIL_CLOSED_LABELS = {
  // Founder report 2026-08-03: the old copy said the privacy tools "failed to
  // load", which reads as a system fault — and an adversarial review of the
  // first fix attempt (2026-08-03) proved that framing was actually RIGHT, not
  // wrong. `step === 'privacy-blocked'` is reached ONLY via `failClosed: true`
  // in src/lib/aiExtraction.ts, which is set ONLY by isPiiStripFailClosedError
  // (a genuine OCR-engine/NER-model load-or-run failure). The separate benign
  // case — a file with no readable text layer (HEIC/SVG/EPUB/ODP/TIFF/scanned
  // PDF) — is deliberately routed to a DIFFERENT step, 'extraction-failed',
  // with its own EXTRACTION_RECOVERY_LABELS copy (see aiExtraction.ts's
  // isUnsupportedImageFormatError / isNoTextExtractedError branches, and the
  // SCRUM-2911 fix, commit d971e55af, 2026-07-23, that split them apart
  // specifically so the benign case would stop surfacing this screen).
  // So: every user who sees THIS screen has hit a real tool-load failure —
  // some fraction transient and retriable. The first rewrite of this copy
  // (same day) got the population backwards, leading with the benign
  // explanation and making Continue the primary action for a screen that,
  // by construction, is never the benign case. Reverted that ordering.
  TITLE: 'On-Device Privacy Tools Failed to Load',
  BODY:
    'Arkova reads and removes personal information on your device before anything is sent. That on-device step could not run — most often a slow or unreliable connection while loading the analysis tools, or low memory on this device. Nothing was analyzed and nothing was sent. Your file never left your device.',
  WHAT_HAPPENED_LABEL: 'What to try',
  WHAT_HAPPENED:
    'This is usually temporary. Try again — a retry succeeds in most cases. If it keeps happening, a stronger network connection or a different device often resolves it.',
  // Anchoring does NOT depend on this step: fingerprinting is byte-based and
  // works for every file type, so continuing without a retry is always SAFE,
  // even though it is not the recommended first action on this screen (most
  // failures here are transient and a retry recovers full AI metadata).
  SAFE_TO_CONTINUE:
    'If you would rather not retry, you can continue instead — the document is still fingerprinted and secured exactly the same way, just without the optional AI-suggested metadata.',
  RETRY: 'Try Again',
  CONTINUE_WITHOUT: 'Continue Without AI Metadata',
  REASSURANCE: 'No information was sent to Arkova or anyone else.',
} as const;

// =============================================================================
// SETTINGS PAGE
// =============================================================================

export const SETTINGS_PAGE_LABELS = {
  ORG_TITLE: 'Organization Settings',
  ORG_DESCRIPTION: 'Manage templates, integrations, and API access',
  CREDENTIAL_TEMPLATES: 'Document Templates',
  CREDENTIAL_TEMPLATES_DESC: 'Define schemas for document types',
  WEBHOOKS: 'Webhooks',
  WEBHOOKS_DESC: 'Configure event notifications',
  API_KEYS: 'API Keys',
  API_KEYS_DESC: 'Manage verification API access',
  TEMPLATES_EMPTY_TITLE: 'No templates yet',
  TEMPLATES_EMPTY_DESC: 'Create your first document template to start securing verifiable documents.',
  TEMPLATES_EMPTY_CTA: 'Create Template',
  TEMPLATES_STARTER_HEADING: 'Popular templates to get started',
} as const;

// =============================================================================
// CONNECTIONS — third-party document source integrations (SCRUM-1101)
// =============================================================================

export const CONNECTIONS_LABELS = {
  CARD_TITLE: 'Connections',
  CARD_DESCRIPTION: 'Connect a document source so rules trigger on real events',
  DOCUSIGN_NAME: 'DocuSign',
  DOCUSIGN_DESC: 'Trigger rules when an envelope is signed and completed',
  CONNECT_BUTTON: 'Connect',
  CONNECTING: 'Connecting…',
  DISCONNECT_BUTTON: 'Disconnect',
  DISCONNECTING: 'Disconnecting…',
  STATUS_CONNECTED: 'Connected',
  STATUS_NOT_CONNECTED: 'Not connected',
  STATUS_CHECKING: 'Checking',
  CONNECT_FAILED: 'Could not start the connection. Please try again.',
  DISCONNECT_FAILED: 'Could not disconnect. Please try again.',
  TOAST_CONNECTED: 'DocuSign connected. Completed envelopes will now trigger rules.',
  TOAST_DISCONNECTED: 'DocuSign disconnected.',
  TOAST_ERROR_PREFIX: 'DocuSign connection failed: ',
  ACCOUNT_LABEL_PREFIX: 'Account: ',
  MEMBER_DOCUSIGN_NAME: 'Personal DocuSign',
  MEMBER_DOCUSIGN_DESC: 'Connect your personal DocuSign account for member-level signing',
  MEMBER_TOAST_CONNECTED: 'DocuSign connected.',
  MEMBER_TOAST_DISCONNECTED: 'Personal DocuSign disconnected.',
  // SCRUM-2361 (DS-01): denial copy shown when the organization is not yet
  // verified. Mirrors the worker `code: 'org_unverified'` response so the UI
  // message and the backend gate stay in lockstep.
  DOCUSIGN_NOT_VERIFIED: 'Your organization must be verified before connecting DocuSign. Verified organizations can connect a document source. Contact support to start verification.',
  DOCUSIGN_GATE_CHECKING: 'Checking your organization’s authorization…',
  GOOGLE_DRIVE_NAME: 'Google Drive',
  GOOGLE_DRIVE_DESC: 'Trigger rules when a watched folder’s files change',
  // DRIVE-01 (SCRUM-2366): entitlement denial copy. Each string mirrors a
  // worker `code:` so the UI message and the backend eligibility gate stay in
  // lockstep. A free or unverified account cannot connect a document source.
  DRIVE_NOT_ADMIN: 'Only an organization administrator can connect Google Drive for your organization.',
  DRIVE_ORG_NOT_VERIFIED: 'Your organization must be verified before connecting Google Drive. Verified organizations can connect a document source. Contact support to start verification.',
  DRIVE_ORG_SUSPENDED: 'Your organization is currently suspended. Google Drive cannot be connected until the suspension is resolved.',
  DRIVE_NEEDS_PAID_PLAN: 'Connecting Google Drive requires a paid plan. Upgrade your plan, or ask an organization administrator to connect it for your organization.',
  DRIVE_INDIVIDUAL_NOT_VERIFIED: 'You must complete identity verification before connecting Google Drive to your personal account.',
  DRIVE_GATE_CHECKING: 'Checking your authorization to connect Google Drive…',
  DRIVE_GATE_UNAVAILABLE: 'We could not verify your authorization right now. Please retry in a few seconds; if the issue persists, contact support.',
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
  BALANCE_STALE: 'Balance may be stale — network data temporarily unavailable.',
  BALANCE_UNAVAILABLE: 'Unable to fetch balance. Please try again shortly.',
  WORKER_RETURNED_STATUS: (status: number) => `Worker returned ${status}`,
  WORKER_REQUEST_FAILED: 'Worker request failed',
  WORKER_HEALTH_RETURNED_STATUS: (status: number) => `Worker health returned ${status}`,
  WORKER_HEALTH_REQUEST_FAILED: 'Worker health request failed',
  // SCRUM-2901: friendly copy for the 8s status-API budget firing — never
  // surface the raw browser TimeoutError text ("signal timed out") to admins.
  WORKER_STATUS_TIMED_OUT: (seconds: number) =>
    `Status request took longer than ${seconds} seconds and was stopped.`,
  WORKER_HEALTH_TIMED_OUT: (seconds: number) =>
    `Freshness check took longer than ${seconds} seconds and was stopped.`,
  FETCH_FAILED: 'Failed to fetch treasury data',
  CACHE_NO_TIMESTAMP: 'No treasury cache timestamp returned',
  CACHE_TIMESTAMP_UNAVAILABLE: 'Treasury cache timestamp unavailable',
  CACHE_REFRESHED_LESS_THAN_MINUTE: 'Treasury cache refreshed less than a minute ago',
  CACHE_REFRESHED_ONE_MINUTE: 'Treasury cache refreshed 1 minute ago',
  CACHE_REFRESHED_MINUTES: (minutes: string) => `Treasury cache refreshed ${minutes} minutes ago`,
  CACHE_FRESHNESS_UNAVAILABLE: (error: string) => `Worker/cache freshness unavailable: ${error}`,
  WORKER_SOURCE: 'Worker source',
  STALE: 'Stale',
  ANCHOR_STATS_PIPELINE_STATUS: 'Pipeline Status',
  ANCHOR_STATUS_QUEUED: 'Queued',
  ANCHOR_STATUS_SUBMITTING: 'Submitting to Network',
  ANCHOR_STATUS_IN_MEMPOOL: 'In Mempool',
  ANCHOR_STATUS_ANCHORED: 'Anchored',
  ANCHOR_STATUS_REVOKED: 'Revoked',
  ANCHOR_STATS_ANCHORED_ON_NETWORK: 'Anchored on Network',
  ANCHOR_STATS_TOTAL_RECORDS: 'Total Records',
  ANCHOR_STATS_NETWORK_RECEIPTS: 'Network Receipts',
  ANCHOR_STATS_AVG_RECORDS_PER_RECEIPT: 'Avg Records/Receipt',
  ANCHOR_STATS_LAST_ACTIVITY: 'Last Activity',
  ANCHOR_STATS_UNAVAILABLE: 'Unable to load stats',
  X402_PAYMENT_REVENUE: 'x402 Payment Revenue',
  X402_NETWORK_BADGE: 'Base Sepolia',
  USDC_ADDRESS: 'USDC Address',
  PAYMENTS: 'Payments',
  PAYMENT_STATUS: 'Status',
  PAYMENT_STATUS_ACTIVE: 'Active',
  X402_GATE_ENABLED: 'x402 payment gate is enabled. Unauthenticated API calls return 402 with USDC payment requirements.',
  X402_NO_DATA_RETURNED: 'No data returned',
  X402_LOAD_FAILED: 'Failed to load x402 stats',
  TOTAL_PAYMENTS: 'Total Payments',
  REVENUE_USDC: 'Revenue (USDC)',
  RECENT_PAYMENTS: 'Recent payments:',
} as const;

// =============================================================================
// ADMIN ORG CREDIT ADJUST (L2-A5 — founder admin-controls: platform-admin
// add/remove on an organization's credit balance)
// =============================================================================

export const ADMIN_CREDIT_ADJUST_LABELS = {
  COLUMN_LABEL: 'Credits',
  BUTTON_LABEL: 'Adjust credits',
  BUTTON_TITLE: 'Adjust credit balance',
  DIALOG_TITLE: 'Adjust credits',
  DIALOG_DESCRIPTION: (orgName: string) => `Add or remove credits for ${orgName}.`,
  CURRENT_BALANCE_LABEL: 'Current balance',
  ACTION_ADD: 'Add credits',
  ACTION_REMOVE: 'Remove credits',
  AMOUNT_LABEL: 'Amount',
  REASON_LABEL: 'Reason',
  REASON_PLACEHOLDER: 'Why are you adjusting this balance? Shown in the audit log.',
  REASON_REQUIRED_ERROR: 'Enter a reason for this adjustment.',
  AMOUNT_REQUIRED_ERROR: 'Enter a whole number of credits greater than zero.',
  REVIEW_BUTTON: 'Review',
  BACK_BUTTON: 'Back',
  CONFIRM_BUTTON: 'Confirm adjustment',
  CONFIRMING_BUTTON: 'Adjusting…',
  CONFIRM_SUMMARY_ADD: (amount: string, orgName: string) => `Add ${amount} credits to ${orgName}.`,
  CONFIRM_SUMMARY_REMOVE: (amount: string, orgName: string) => `Remove ${amount} credits from ${orgName}.`,
  NEW_BALANCE_LABEL: 'New balance',
  SUCCESS_ADD: (amount: string, orgName: string) => `Added ${amount} credits to ${orgName}.`,
  SUCCESS_REMOVE: (amount: string, orgName: string) => `Removed ${amount} credits from ${orgName}.`,
  ERROR_INSUFFICIENT_BALANCE: 'Cannot remove more credits than the organization has.',
  ERROR_GENERIC: 'Failed to adjust credits.',
  UNKNOWN_BALANCE: '—',
} as const;

// =============================================================================
// DATA ERROR BANNER (SCRUM-1260 R1-6 /simplify carry-over)
// =============================================================================
//
// Centralised error-banner copy for admin dashboards. The previous inline
// hardcoded strings on PipelineAdminPage + TreasuryAdminPage drifted into
// three subtly different phrasings ("Pipeline stats temporarily unavailable",
// "Records fetch failed", "x402 stats unavailable"). Consolidating per
// CLAUDE.md §1.3 (UI copy lives in src/lib/copy.ts).
export const DATA_ERROR_LABELS = {
  STATS_UNAVAILABLE_TITLE: 'Pipeline stats temporarily unavailable',
  STATS_UNAVAILABLE_TRAILER: ' — showing last successful values.',
  RECORDS_FETCH_FAILED_TITLE: 'Records fetch failed',
  TREASURY_UNAVAILABLE_TITLE: 'Treasury data temporarily unavailable',
  X402_UNAVAILABLE_TITLE: 'x402 stats unavailable',
  RETRY: 'Retry',
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
  PAGE_SUBTITLE: 'Review flagged records that require human verification.',
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
  // SCRUM-2938 S1: "Compliance Intelligence" retired from user-facing copy.
  PAGE_TITLE: 'Compliance Dashboard',
  // SCRUM-2938 S1: non-admin access-restricted card (moved out of inline JSX
  // in ComplianceDashboardPage per §1.3 / src/lib/agents.md — copy lives here).
  ACCESS_RESTRICTED_TITLE: 'Access Restricted',
  ACCESS_RESTRICTED_BODY:
    'The Compliance dashboard is available to organization administrators. Contact your admin for access.',
  PAGE_SUBTITLE: 'Monitor record health, expiring records, and review activity across your organization.',
  CARD_ACTIVE: 'Active Records',
  CARD_ACTIVE_SUBTITLE: 'Issued attestations',
  CARD_EXPIRING: 'Expiring Soon',
  CARD_REVOKED: 'Recently Revoked',
  CARD_ANCHORED: 'Anchored Rate',
  SECTION_EXPIRING: 'Expiring Records',
  SECTION_ACTIVITY: 'Recent Activity',
  SECTION_REVIEW: 'Review Summary',
  EMPTY_EXPIRING: 'All records current',
  EMPTY_EXPIRING_DESC: 'No records are expiring in the next 30 days.',
  EMPTY_ACTIVITY: 'No recent activity',
  EMPTY_ACTIVITY_DESC: 'Record activity will appear here as events occur.',
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
  EVENT_CREATED: 'Record created',
  EVENT_REVOKED: 'Record revoked',
  EVENT_EXPIRED: 'Record expired',
  EVENT_ACTIVE: 'Record activated',
  SECTION_COVERAGE: 'Regulatory Framework Coverage',
  SECTION_COVERAGE_DESC: 'Controls evidenced by your secured records.',
  COVERAGE_SECURED: 'Secured Records',
  COVERAGE_CONTROLS: 'Controls Evidenced',
  COVERAGE_FRAMEWORKS: 'Frameworks Covered',
  COVERAGE_EMPTY: 'No secured records yet',
  COVERAGE_EMPTY_DESC: 'Framework coverage appears once records are anchored to the network.',
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

export const PROFESSIONAL_EDUCATION_EXPORT_LABELS = {
  TITLE: 'Professional Education Exports',
  DESCRIPTION: 'Generate signed compliance logs for reporting periods.',
  FORMAT_LABEL: 'Format',
  FORMAT_PDF: 'PDF',
  FORMAT_JSON: 'JSON',
  CPE_TITLE: 'CPE Log',
  CPE_DESCRIPTION: 'Export your continuing education records for accounting board review.',
  CPE_PERIOD_START: 'CPE period start',
  CPE_PERIOD_END: 'CPE period end',
  CPE_EXPORT: 'Export CPE log',
  CPE_EXPORTING: 'Exporting CPE log',
  CLE_TITLE: 'CLE Log',
  CLE_DESCRIPTION: 'Export legal education records for a selected jurisdiction.',
  CLE_JURISDICTION: 'CLE jurisdiction',
  CLE_JURISDICTION_PLACEHOLDER: 'US-CA',
  CLE_PERIOD_START: 'CLE period start',
  CLE_PERIOD_END: 'CLE period end',
  CLE_EXPORT: 'Export CLE log',
  CLE_EXPORTING: 'Exporting CLE log',
  REQUIRED_FIELDS: 'Choose a valid reporting period before exporting.',
  MISSING_URL: 'The export completed, but no download link was returned.',
  UNSAFE_URL: 'The export completed, but the download link was not safe to open.',
  GENERIC_ERROR: 'Unable to export the compliance log. Please try again.',
  SUCCESS_CPE: (count: number) => `CPE log ready. ${count} ${count === 1 ? 'record' : 'records'} included.`,
  SUCCESS_CLE: (count: number) => `CLE log ready. ${count} ${count === 1 ? 'record' : 'records'} included.`,
} as const;

// =============================================================================
// S3 CREDENTIAL-NETWORK (LANE 3) STRINGS — SCRUM-2378 / SCRUM-2379 / SCRUM-2380
// One contiguous block by design: Sprint-3 streams share copy.ts, so all Lane-3
// CPE/CLE strings live HERE to minimize merge conflicts. Do not scatter.
// =============================================================================

export const PROFESSIONAL_EDUCATION_S3_LABELS = {
  // CPE-01 (SCRUM-2378): the worker excludes ALL non-secured records from
  // compliance exports — including revoked/expired/superseded ones that will
  // NEVER become secured. Per §1.5 the notice asserts only what is held (they
  // aren't secured); it must not promise they will "appear once secured"
  // (round-1 review finding 2). Surfaced inline — never a blocker, never
  // silent.
  EXCLUDED_NOTICE: (count: number) =>
    count === 1
      ? "1 record isn't included because it isn't secured."
      : `${count} records aren't included because they aren't secured.`,
  // CLE-01 (SCRUM-2379, Constitution §1.5): jurisdiction tags are informational
  // metadata only. Mirrors JURISDICTION_INFORMATIONAL_DISCLAIMER in
  // services/worker/src/exports/cle-log-export.ts (embedded in the export
  // artifacts) — keep the two statements consistent in substance.
  JURISDICTION_DISCLAIMER:
    'Jurisdiction tags are informational metadata only. Exports do not determine or assert compliance with, or adequacy under, the continuing education requirements of any jurisdiction or licensing body.',
} as const;

// CPE-02 (SCRUM-2380): org CPE dashboard MVP.
export const ORG_CPE_DASHBOARD_LABELS = {
  TITLE: 'Team CPE Records',
  DESCRIPTION: 'Per-member continuing education records for the selected reporting period.',
  PERIOD_LABEL: 'Reporting period',
  PERIOD_YTD: 'Year to date',
  PERIOD_90_DAYS: 'Last 90 days',
  PERIOD_12_MONTHS: 'Last 12 months',
  PERIOD_ALL_TIME: 'All time',
  TILE_MEMBERS: 'Members with records',
  TILE_SECURED: 'Secured records',
  TILE_PENDING: 'Pending records',
  COL_MEMBER: 'Member',
  COL_SECURED: 'Secured',
  COL_PENDING: 'Pending',
  COL_LAST_ACTIVITY: 'Last activity',
  MEMBER_SCOPE_NOTE: 'Showing your records only.',
  UNKNOWN_MEMBER: 'Unknown member',
  EMPTY: 'No CPE records in this period',
  EMPTY_DESC: 'Member records appear here once CPE documents are secured or queued for the selected period.',
  ERROR: 'Unable to load team CPE records.',
  NO_ACTIVITY: '—',
  // Round-1 review finding 1: terminal records (revoked, expired, or
  // superseded) are counted in neither tile — surface them explicitly so they
  // never vanish silently from the dashboard.
  TERMINAL_FOOTNOTE: (count: number) =>
    count === 1
      ? '1 record in this period is revoked, expired, or superseded and is not counted in the totals above.'
      : `${count} records in this period are revoked, expired, or superseded and are not counted in the totals above.`,
} as const;

// =============================================================================
// RULE BUILDER WIZARD (ARK-108 / CIBA-HARDEN-04)
// =============================================================================

export const RULE_TRIGGER_COPY = {
  ESIGN_COMPLETED: {
    label: 'E-signature completed',
    desc: 'When a DocuSign or Adobe Sign envelope is signed.',
  },
  WORKSPACE_FILE_MODIFIED: {
    label: 'Workspace file modified',
    desc: 'When a file changes in Google Drive, SharePoint, or OneDrive.',
  },
  CONNECTOR_DOCUMENT_RECEIVED: {
    label: 'Connector delivered a document',
    desc: 'When a partner (Veremark, Checkr, ...) posts a completed report.',
  },
  MANUAL_UPLOAD: {
    label: 'Manual upload',
    desc: 'When a user uploads through the web app.',
  },
  SCHEDULED_CRON: {
    label: 'Schedule',
    desc: 'On a recurring schedule (e.g. daily at 9am).',
  },
  QUEUE_DIGEST: {
    label: 'Queue review digest',
    desc: 'A daily/weekly digest of the review queue.',
  },
  EMAIL_INTAKE: {
    label: 'Email intake',
    desc: 'When a document arrives at your org intake address.',
  },
} as const;

/**
 * Labels for the two securing paths. "Add to Queue" is the default, free path;
 * "Secure Instantly" is hidden at launch and only shown when the worker grants
 * the capability (never a client default). See queueContract.ts.
 *
 * Moved above RULE_ACTION_COPY (2026-08-03, founder directive): the rule
 * builder's AUTO_ANCHOR/INSTANT_SECURE copy now references these BY VALUE so
 * the manual securing flow and the rule-builder flow can never say different
 * things about the same two paths — module-evaluation order requires this
 * declaration to precede any reference to it.
 */
export const SECURING_CHOICE_LABELS = {
  queue: 'Add to Queue',
  instant: 'Secure Instantly',
} as const;

/** Helper text for each securing path, shown under the choice when offered. */
export const SECURING_CHOICE_HINTS = {
  queue: 'Secured with the next batch. Free — no credits used.',
  instant: 'Secured right away. Uses 1 credit from your plan.',
} as const;

export const RULE_ACTION_COPY = {
  // Founder directive (2026-08-03): "The 'Auto Secure' rule doesn't secure."
  // The old label/desc here ("Secure the document" / "Anchor it on the
  // network automatically") implied immediacy; the dispatcher behavior only
  // ever queues (SCRUM-1649 DS-07 — same free path as "Add to Queue"). This
  // is now the SAME wording as the manual queue path
  // (SECURING_CHOICE_LABELS.queue / SECURING_CHOICE_HINTS.queue), by
  // reference so the two can never drift apart again. AUTO_ANCHOR's
  // dispatcher behavior is unchanged — copy-only, additive.
  AUTO_ANCHOR: {
    label: SECURING_CHOICE_LABELS.queue,
    desc: SECURING_CHOICE_HINTS.queue,
  },
  FAST_TRACK_ANCHOR: {
    label: 'Fast-track secure',
    desc: 'Priority batch (paid plans only).',
  },
  // Founder directive (2026-08-03): the rule action that actually secures
  // right away. Mirrors the manual "Secure Instantly" control's copy by
  // reference (SECURING_CHOICE_LABELS.instant / SECURING_CHOICE_HINTS.instant)
  // so a user sees the identical promise — "instant, costs 1 credit" —
  // whether they secure a document by hand or configure a rule to do it.
  INSTANT_SECURE: {
    label: SECURING_CHOICE_LABELS.instant,
    desc: SECURING_CHOICE_HINTS.instant,
  },
  QUEUE_FOR_REVIEW: {
    label: 'Queue for admin review',
    desc: 'Surface on the review dashboard; admin decides.',
  },
  FLAG_COLLISION: {
    label: 'Flag version collision',
    desc: 'If multiple versions arrive within a window, flag them for review.',
  },
  NOTIFY: {
    label: 'Notify',
    desc: 'Email and/or Slack the team.',
  },
  FORWARD_TO_URL: {
    label: 'Forward to a URL',
    desc: 'POST the event to a pre-allowlisted webhook target.',
  },
} as const;

export const RULE_WIZARD_LABELS = {
  PAGE_TITLE: 'Build a new rule',
  PAGE_SUBTITLE:
    "Describe what should happen and when. New rules always land disabled — flip them on after you've reviewed the summary.",
  STEP_INDICATOR: ['Trigger', 'Configure', 'Action', 'Review'] as const,
  STEP_HEADING: (n: 1 | 2 | 3 | 4) => `Step ${n} of 4`,
  BACK: 'Back',
  NEXT: 'Next',
  SAVE: 'Save as disabled',
  SAVING: 'Saving…',
  FIELD_RULE_NAME: 'Rule name',
  FIELD_RULE_NAME_PLACEHOLDER: 'e.g. Auto-secure signed MSAs',
  FIELD_DESCRIPTION: 'Description (optional)',
  FIELD_DESCRIPTION_PLACEHOLDER: 'What does this rule do, in plain English?',
  FIELD_TRIGGER: 'Trigger',
  FIELD_TRIGGER_PLACEHOLDER: 'Pick what should start this rule',
  FIELD_FILENAME_CONTAINS: 'Filename contains (optional)',
  FIELD_FILENAME_CONTAINS_PLACEHOLDER_MSA: 'e.g. MSA',
  FIELD_FILENAME_CONTAINS_PLACEHOLDER_SOW: 'e.g. SOW',
  FIELD_SENDER_EMAIL: 'Sender email equals (optional)',
  FIELD_SENDER_EMAIL_PLACEHOLDER: 'hr@acme.com',
  FIELD_FOLDER_PATH: 'Folder path starts with (optional)',
  FIELD_FOLDER_PATH_PLACEHOLDER: '/HR/Contracts/',
  FIELD_DRIVE_FOLDERS: 'Google Drive folders',
  FIELD_DRIVE_FOLDER_ID: 'Folder ID',
  FIELD_DRIVE_FOLDER_ID_PLACEHOLDER: '1AbCdEfGhIjKlMnOp',
  FIELD_DRIVE_FOLDER_NAME: 'Folder name (optional)',
  FIELD_DRIVE_FOLDER_NAME_PLACEHOLDER: 'Legal MSAs',
  FIELD_DRIVE_FOLDER_PATH: 'Folder path (optional)',
  FIELD_DRIVE_FOLDER_PATH_PLACEHOLDER: '/Legal/MSAs/',
  ADD_DRIVE_FOLDER: 'Add folder',
  REMOVE_DRIVE_FOLDER: 'Remove folder',
  FIELD_CONNECTOR: 'Connector',
  FIELD_CONNECTOR_PLACEHOLDER: 'Pick a connector',
  FIELD_CRON: 'Schedule (cron expression)',
  FIELD_CRON_PLACEHOLDER: '0,30 9,16 * * *',
  FIELD_CRON_HINT_PREFIX:
    'Five fields: minute hour day-of-month month day-of-week. Example: ',
  FIELD_CRON_HINT_EXAMPLE: '0 9 * * *',
  FIELD_CRON_HINT_SUFFIX: ' runs at 9 AM every day.',
  FIELD_TIMEZONE: 'Timezone',
  NO_CONFIG_MESSAGE:
    'This trigger has no additional configuration. Move on to pick an action.',
  FIELD_ACTION: 'Action',
  FIELD_ACTION_PLACEHOLDER: 'Pick what should happen',
  FIELD_NOTIFY_EMAILS: 'Email recipients (comma-separated)',
  FIELD_NOTIFY_EMAILS_PLACEHOLDER: 'alice@acme.com, bob@acme.com',
  FIELD_NOTIFY_CHANNELS: 'Channels',
  FIELD_COLLISION_WINDOW: 'Collision window (minutes)',
  FIELD_FORWARD_URL: 'Target URL',
  FIELD_FORWARD_URL_PLACEHOLDER: 'https://ops.example.com/hooks/arkova',
  FIELD_FORWARD_URL_HINT: "Worker will refuse any URL not on your org's allowlist.",
  FIELD_HMAC_HANDLE: 'HMAC secret handle',
  FIELD_HMAC_HANDLE_PLACEHOLDER: 'sm:acme_forward_secret',
  FIELD_HMAC_HANDLE_HINT:
    'Reference the handle of a Secret Manager entry (e.g. sm:acme_forward_secret). Never paste the raw secret here — the worker resolves the handle at runtime.',
  REVIEW_NAME: 'Name',
  REVIEW_STATUS_ON_SAVE: 'Status on save',
  REVIEW_STATUS_DISABLED: 'Disabled',
  REVIEW_TRIGGER: 'Trigger',
  REVIEW_ACTION: 'Action',
  REVIEW_CONFIGURED_PREFIX: 'Configured: ',
  REVIEW_TRIGGER_RAW_HIDDEN:
    '. Raw values hidden (may contain recipient emails, sender filters, or webhook targets).',
  REVIEW_DISABLED_BANNER:
    "New rules ship disabled. Enable from the rules list after checking the summary.",
  ERR_PICK_TRIGGER: 'Pick a trigger to continue.',
  ERR_PICK_ACTION: 'Pick an action to continue.',
  ERR_NO_ORG: 'No organization selected.',
  ERR_NAME_REQUIRED: 'Name is required.',
  ERR_INVALID_CONFIG_PREFIX: 'Fix the highlighted fields before continuing: ',
} as const;

export const RULES_PAGE_COPY = {
  RUN_NOW: 'Run now',
  RUNNING: 'Queuing…',
  HISTORY: 'History',
  HISTORY_TITLE: 'Rule history',
  HISTORY_DESCRIPTION: 'Recent queued and completed runs for this rule.',
  HISTORY_EMPTY: 'No runs yet.',
  HISTORY_LOADING: 'Loading history…',
  QUEUED_TOAST: 'Queued.',
  VIEW_HISTORY: 'View history',
  STATUS: 'Status',
  TRIGGER_EVENT: 'Trigger event',
} as const;

// =============================================================================
// RULE SIMULATOR (SCRUM-1141)
// =============================================================================

export const RULE_SIMULATOR_COPY = {
  PANEL_TITLE: 'Test this rule',
  PANEL_SUBTITLE:
    'Run a sample event through this rule to see what would happen. Nothing is saved or anchored.',
  SAMPLE_HEADING: 'Sample event',
  SAMPLE_HINT: "Edit the sample fields below to match the kind of document you're worried about.",
  FIELD_VENDOR: 'Vendor',
  FIELD_VENDOR_PLACEHOLDER: 'docusign / google_drive / veremark…',
  FIELD_FILENAME: 'Filename',
  FIELD_FILENAME_PLACEHOLDER: 'msa-2026.pdf',
  FIELD_FOLDER_PATH: 'Folder path',
  FIELD_FOLDER_PATH_PLACEHOLDER: '/Legal/MSAs/',
  FIELD_SENDER: 'Sender email',
  FIELD_SENDER_PLACEHOLDER: 'signer@example.com',
  FIELD_SUBJECT: 'Email subject',
  FIELD_SUBJECT_PLACEHOLDER: 'Signed contract attached',
  FIELD_CONNECTOR: 'Connector type',
  TEST_BUTTON: 'Test rule',
  TESTING: 'Testing…',
  RESET_SAMPLE: 'Reset sample',
  // Result block
  RESULT_MATCHED: 'This rule WOULD fire',
  RESULT_NOT_MATCHED: 'This rule would NOT fire',
  RESULT_NEEDS_SEMANTIC:
    'Heads up: this rule also requires a semantic-match check (Gemini embedding) before firing.',
  RESULT_REASON_LABEL: 'Reason',
  RESULT_ACTION_PREVIEW: 'Action that would run',
  RESULT_DRY_RUN_BANNER:
    'Dry run only — this is separate from Save/Enable. No notifications, anchors, or webhooks were sent.',
  ERR_NEED_TRIGGER_AND_ACTION:
    'Pick a trigger and action first — those are required to run a simulation.',
  ERR_GENERIC: 'Could not run the simulation. Try again or check the rule config.',
} as const;

// =============================================================================
// NESSIE INTELLIGENCE (NMT-07)
// =============================================================================

export const NESSIE_LABELS = {
  // SCRUM-2938 S1: internal codename "Nessie" and the "compliance intelligence"
  // phrasing removed from user-facing copy (the NESSIE_LABELS identifier is
  // internal-only and unchanged per §1.3 "internal code may use technical names").
  //
  // The intelligence-panel half of this vocabulary (PANEL_TITLE,
  // PANEL_SUBTITLE, INPUT_PLACEHOLDER, EMPTY_STATE, CITATIONS_HEADING,
  // VIEW_ON_CHAIN, VERIFY, CACHED, RISKS_HEADING, RECOMMENDATIONS_HEADING,
  // TASK_*) is deleted along with the panel component: Nessie is OFF by founder
  // directive and the panel was mounted, ungated, on a customer-reachable
  // route. CONFIDENCE + CONFIDENCE_DETAIL_* go with them for the same reason
  // SCRUM-2914 deleted CONFIDENCE_FIELD and EXTRACTION_CONFIDENCE — leaving
  // confidence copy in the vocabulary is leaving the next surface pre-written.
  //
  // Only the INSIGHTS_* keys survive: they belong to `NessieInsights`
  // (components/anchor), which renders no score.
  INSIGHTS_TITLE: 'Document Insights',
  INSIGHTS_SUBTITLE: 'AI-powered compliance analysis for this record.',
  INSIGHTS_LOADING: 'Analyzing...',
  INSIGHTS_EMPTY: 'No insights available for this record.',
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
  EMPTY_DESC: 'Generate your first report to get insights into your records.',
  REPORT_INTEGRITY: 'Integrity Summary',
  REPORT_ACCURACY: 'Extraction Accuracy',
  REPORT_ANALYTICS: 'Record Analytics',
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
  // SCRUM-2914: EXTRACTION_CONFIDENCE removed — no longer rendered as its own
  // integrity bar. The value still feeds the overall score server-side.
  ISSUER_VERIFICATION: 'Issuer Verification',
  DUPLICATE_CHECK: 'Duplicate Check',
  TEMPORAL_CONSISTENCY: 'Temporal Consistency',
  // Flag labels
  FLAG_MISSING_ISSUED_DATE: 'Missing issue date',
  FLAG_FUTURE_ISSUED_DATE: 'Issue date is in the future',
  FLAG_VERY_OLD_CREDENTIAL: 'Document is over 50 years old',
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
  // SCRUM-2246: shown when a page failed to load because a new version was
  // deployed while this tab was open. Refreshing pulls the newest files.
  STALE_VERSION_TITLE: 'A new version is available',
  STALE_VERSION_DESCRIPTION:
    'This page could not load because the app was updated while you were away. Refresh to get the newest version.',
  STALE_VERSION_REFRESH: 'Refresh',
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
  HERO_SUBTITLE: 'Programmatic record verification, AI-powered metadata extraction, and seamless integration for your applications.',

  // API Overview cards
  CARD_VERIFY_TITLE: 'Verify Records',
  CARD_VERIFY_ENDPOINT: 'GET /verify/{id}',
  CARD_VERIFY_DESC: 'Verify any record\'s status, proof details, and issuer information with a single API call.',
  CARD_BATCH_TITLE: 'Batch Verification',
  CARD_BATCH_ENDPOINT: 'POST /verify/batch',
  CARD_BATCH_DESC: 'Verify up to 100 records per request for high-throughput integrations.',
  CARD_AI_TITLE: 'AI Intelligence',
  CARD_AI_ENDPOINT: 'POST /ai/extract',
  CARD_AI_DESC: 'AI-powered metadata extraction, semantic search, and integrity scoring for record data.',

  // Getting Started
  GETTING_STARTED_TITLE: 'Getting Started',
  STEP_1: 'Create an account and navigate to Settings',
  STEP_2: 'Go to API Keys and generate a new key',
  STEP_3: 'Make your first API call using the example below',
  CURL_COMMENT: '# Verify a record by its public ID',

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
  MCP_DESC: 'Arkova provides a Model Context Protocol (MCP) server for AI agents. Connect your agent to verify records and search the registry programmatically.',
  MCP_TOOL_VERIFY: 'verify_credential',
  MCP_TOOL_VERIFY_DESC: 'Verify a record by its public ID',
  MCP_TOOL_SEARCH: 'search_credentials',
  MCP_TOOL_SEARCH_DESC: 'Search the public record registry',

  // API docs card on ApiKeySettingsPage
  API_DOCS_CARD_TITLE: 'API Documentation',
  API_DOCS_CARD_DESC: 'Explore the full API reference with interactive examples.',
  API_DOCS_CARD_BUTTON: 'Open API Docs',
  API_DOCS_CARD_LINK: 'View full developer overview',

  // Sandbox
  SANDBOX_ANON_HINT: 'GET endpoints work without an API key (100 req/min). For batch and write operations,',
  SANDBOX_ANON_HINT_CTA: 'create an account',
  SANDBOX_ANON_HINT_SUFFIX: 'to generate a key.',
  SANDBOX_ERROR_UNREACHABLE: 'Could not connect to API server. The server may be unreachable or CORS may be blocking the request.',
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

// =============================================================================
// ACCEPT INVITE (SCRUM-3012) — /accept-invite?token=...
// =============================================================================

export const ACCEPT_INVITE_LABELS = {
  PAGE_TITLE: "You're invited",
  LOADING: 'Loading your invitation…',
  INVITED_TO_JOIN: 'You have been invited to join',
  AS_A_MEMBER: 'as a member.',
  AS_AN_ADMINISTRATOR: 'as an administrator.',

  INVALID_TITLE: 'Invalid invitation link',
  INVALID_DESCRIPTION: 'This invitation link is invalid. Please check your email for the correct link.',

  EXPIRED_TITLE: 'This invitation has expired',
  EXPIRED_DESCRIPTION: 'Ask your organization administrator to send a new invitation.',

  ALREADY_USED_TITLE: 'Invitation already used',
  ALREADY_USED_DESCRIPTION: 'This invitation has already been accepted. Ask your administrator to send a new one if you need access again.',

  ACCOUNT_EXISTS_TITLE: 'You already have an account',
  ACCOUNT_EXISTS_DESCRIPTION: 'Sign in with this email address to accept the invitation.',
  SIGN_IN_TO_ACCEPT: 'Sign in to accept',

  FULL_NAME_LABEL: 'Full name',
  EMAIL_LABEL: 'Email address',
  PASSWORD_LABEL: 'Create a password',
  PASSWORD_PLACEHOLDER: 'Create a password (8+ characters)',
  CREATE_AND_JOIN: 'Create account and join',
  JOINING: 'Joining…',

  SUCCESS_JOINED_TITLE: "You're in",
  SUCCESS_JOINED_DESCRIPTION: 'Your account has joined the organization.',
  GO_TO_DASHBOARD: 'Go to dashboard',

  SUCCESS_VERIFY_TITLE: 'Confirm your email to finish',
  SUCCESS_VERIFY_DESCRIPTION: "We've sent a confirmation link to your email. Confirm it to sign in.",
  VERIFICATION_EMAIL_FAILED: "Your account was created, but we couldn't send the confirmation email. Contact support to finish setting up sign-in.",

  ERROR_GENERIC: 'Something went wrong accepting this invitation. Please try again.',
  TRY_AGAIN: 'Try again',
} as const;

/**
 * Copy for /activate — the recipient's account-activation page.
 *
 * Wording note (§1.5 / §1.13 R-7): this page previously promised a 12-word
 * "backup access key" that no code path could ever redeem — there is no
 * recovery flow and no column to store it in. That claim is gone rather than
 * restated; see src/pages/agents.md for the ruling.
 */
export const ACTIVATE_ACCOUNT_LABELS = {
  PAGE_TITLE: 'Activate your account',
  LOADING: 'Checking your activation link…',
  INVITED_BY: 'You have been added to',
  SUBTITLE: 'Choose a password to finish setting up your account.',

  INVALID_TITLE: 'Activation link is invalid',
  INVALID_DESCRIPTION:
    'This activation link is invalid or has already been used. Ask your organization administrator to send a new one.',

  EXPIRED_TITLE: 'This activation link has expired',
  EXPIRED_DESCRIPTION: 'Ask your organization administrator to send a new one.',

  EMAIL_LABEL: 'Email address',
  PASSWORD_LABEL: 'Choose a password',
  PASSWORD_PLACEHOLDER: 'At least 8 characters',
  PASSWORD_TOO_SHORT: 'Choose a password of at least 8 characters.',
  FULL_NAME_LABEL: 'Full name',

  SUBMIT: 'Activate my account',
  SUBMITTING: 'Activating your account…',

  SUCCESS_TITLE: 'Your account is ready',
  SUCCESS_DESCRIPTION: 'You can now sign in with your email address and the password you just chose.',
  GO_TO_SIGN_IN: 'Go to sign in',

  ERROR_GENERIC: 'Something went wrong activating your account. Please try again.',
  TRY_AGAIN: 'Try again',
} as const;

/**
 * SCRUM-2907 — copy for a confirmation link that did not work.
 *
 * Supabase signals a dead link with `error`/`error_code` on the redirect hash
 * and creates no session. Previously the app could not tell that apart from
 * "not signed in yet" and silently redirected to the login form, so a user
 * whose link had expired saw no explanation and had no route forward.
 */
export const AUTH_CALLBACK_LABELS = {
  COMPLETING: 'Completing sign in...',
  EXPIRED_TITLE: 'This link has expired',
  EXPIRED_DESCRIPTION:
    'Verification links are single-use and time-limited. Request a new link to finish setting up your account.',
  FAILED_TITLE: 'We could not complete sign in',
  FAILED_DESCRIPTION:
    'Something went wrong verifying this link. Try again, or request a new link.',
  REQUEST_NEW_LINK: 'Request a new link',
  BACK_TO_SIGN_IN: 'Back to sign in',
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
  STATUS_PENDING: 'Pending',
  STATUS_BROADCASTING: 'Submitting to Network',
  STATUS_SUBMITTED: 'Submitted',
  STATUS_SUBMITTED_MEMPOOL: 'Submitted / In Mempool',
  STATUS_SECURED_CONFIRMED: 'Secured / Confirmed',
  STATUS_EXPIRED: 'Expired',
  STATUS_REVOKED: 'Revoked',
  STATUS_UNLINKED: 'Unlinked',
  STATUS_UNKNOWN: 'Unknown',
  STATUS_SECURED_MISSING_RECEIPT: 'Secured / Missing Receipt',
  CACHE_NO_TIMESTAMP: 'No cache timestamp returned',
  CACHE_TIMESTAMP_UNAVAILABLE: 'Cache timestamp unavailable',
  CACHE_REFRESHED_LESS_THAN_MINUTE: 'Last refreshed less than a minute ago',
  CACHE_REFRESHED_ONE_MINUTE: 'Last refreshed 1 minute ago',
  CACHE_REFRESHED_MINUTES: (minutes: string) => `Last refreshed ${minutes} minutes ago`,
  WORKER_CACHE_SOURCE: 'Worker cache',
  DIRECT_RPC_FALLBACK_SOURCE: 'Direct RPC fallback',
  DIRECT_RPC_FALLBACK_NO_DATA: 'Direct RPC fallback returned no data',
  WORKER_CACHE_FALLBACK_WARNING: (error: string) => `Worker/cache source failed (${error}); showing direct RPC fallback values.`,
  LIFECYCLE_COUNTS_UNAVAILABLE_WARNING: 'Pipeline lifecycle counts unavailable: direct RPC returned cache-miss placeholders or timeout sentinels.',
  STALE: 'Stale',
  RECORDS_ANCHORED_SUBTITLE: (submitted: string, secured: string) => `${submitted} submitted / ${secured} confirmed`,
  RECORDS_PENDING_SUBTITLE: (unlinked: string, queued: string, submitting: string) => `${unlinked} unlinked / ${queued} queued / ${submitting} submitting to network`,
  RECORDS_EMBEDDED_SUBTITLE: 'Vector embeddings enable AI search and cross-reference matching across all pipeline records',
  ANCHOR_DETAIL_RECEIPT_MEMPOOL: 'Network Receipt (In Mempool)',
  ANCHOR_DETAIL_MEMPOOL: 'In Mempool',
  FILTER_SEARCH_PLACEHOLDER: 'Search by title or source ID...',
  RECORDS_NO_RESULTS: 'No records match the current filters.',
  RECORDS_SHOWING: 'Showing',
  RECORDS_OF: 'of',
  RECORDS_LOAD_MORE: 'Load More',
  ANCHORS_BY_TYPE_TITLE: 'Anchors by Document Type',
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

export const OCR_LABELS = {
  UNSUPPORTED_FILE_TYPE: (typeOrExt: string) =>
    `Unsupported file type for text extraction: ${typeOrExt}. ` +
    'Supported: PDF, Word (.docx), OpenDocument (.odt/.odp), PowerPoint (.pptx), ' +
    'EPUB, RTF, SVG, images, and text files. ' +
    'The document can still be secured without AI metadata.',
  /**
   * §1.6 FAIL-CLOSED (WEBEXT-03). Surfaced when the on-device document reader
   * (OCR engine) could not load or run. Fixed copy — never includes the
   * underlying error, which may reference document-derived text.
   */
  OCR_ENGINE_UNAVAILABLE:
    'The on-device document reader couldn’t start, so this document was not read and nothing was sent. Your file never left your device.',
  /**
   * SCRUM-2911 — BENIGN unsupported-image-format soft-fail. Shown when the
   * browser cannot decode an image format (e.g. HEIC/TIFF) for on-device text
   * extraction. This is NOT a privacy failure — the document was never at risk
   * and never left the device. Interpolates only the file's format/extension
   * (not document-derived content).
   */
  UNSUPPORTED_IMAGE_FORMAT: (typeOrExt: string) =>
    `This image format (${typeOrExt}) can’t be read on your device for text extraction. ` +
    'You can still secure the document without AI metadata — your file never left your device.',
} as const;

export const CONFIRMATION_PROGRESS_LABELS = {
  // SCRUM-2914 (Founder UI findings, 2026-07-22): dropped the "~10 minutes"
  // estimate \u2014 anchoring timing is not a guarantee we can make.
  IN_PROGRESS: 'Anchoring in progress \u2014 your record will be permanently verified.',
  NOTIFICATION_NOTE: 'You\u2019ll receive a notification when anchoring is complete. You can safely close this dialog.',
  // SCRUM-2914: neighboring timing-neutral label for the record-detail
  // "awaiting confirmation" notice (was hardcoded with a "~10 minutes"
  // estimate directly in AssetDetailView.tsx \u2014 moved here per \u00a71.3).
  AWAITING_CONFIRMATION: 'Your record has been submitted to the network. Confirmation is in progress.',
} as const;

export const FINGERPRINT_TOOLTIP = {
  TITLE: 'What is a document fingerprint?',
  DESCRIPTION: 'A document fingerprint is a unique identifier calculated from the document\u2019s contents. Like a human fingerprint, no two documents produce the same one. This fingerprint is what gets permanently anchored.',
} as const;

export const RECORD_DETAIL_LABELS = {
  FINGERPRINT_COPY_ARIA: 'Copy document fingerprint',
  FINGERPRINT_COPIED_ARIA: 'Document fingerprint copied',
} as const;

export const ONBOARDING_VALUE_PROP_LABELS = {
  TITLE: 'Welcome to Arkova',
  STEP_1_TITLE: 'Upload any document',
  STEP_1_DESC: 'Drag and drop a certificate, license, or any file you need to verify.',
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
  DATA_UNAVAILABLE_TITLE: 'Unable to load billing data',
  DATA_UNAVAILABLE_DESC: 'We could not confirm your billing status. Refresh the page or try again.',
  RETRY: 'Retry',
  // `useBilling.openBillingPortal` swallows failures and resolves null (e.g. a
  // free-tier user with no Stripe customer yet → worker 404). Without this the
  // button would silently do nothing, which is exactly what the old dead
  // no-op did — the user cannot tell a broken button from a working one.
  PORTAL_UNAVAILABLE: 'Could not open the billing portal. Please try again.',
} as const;

export const SYSTEM_HEALTH_LABELS = {
  CONNECTION_ERROR: 'Unable to connect to the server. Please check your connection and try again.',
  WORKER_HINT: 'The verification API backend appears unreachable. Check worker health on Cloud Run.',
  WORKER_OFFLINE: 'Verification API offline',
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
  MANAGE_DESCRIPTION: 'Create, approve, or revoke affiliate organizations.',
  COUNT_LABEL: 'affiliated organizations',
  CREATE_AFFILIATE: 'Create Affiliate',
  AFFILIATE_NAME_LABEL: 'Affiliate name',
  AFFILIATE_LEGAL_NAME_LABEL: 'Legal name',
  AFFILIATE_DOMAIN_LABEL: 'Domain',
  AFFILIATE_ADMIN_EMAIL_LABEL: 'Affiliate admin email',
  CREATE_SUCCESS: 'Affiliate organization created.',
  CREATE_FAILED: 'Failed to create affiliate organization.',
  CREATE_MISSING_FIELDS: 'Affiliate name and admin email are required.',
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
  PARENT_ORGANIZATION: 'parent organization',
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
  body: `Arkova provides timestamped cryptographic verification of documents and records. Our service creates permanent, tamper-evident records that a specific document existed at a specific time.

Arkova does NOT:
• Verify the truthfulness or accuracy of document contents
• Guarantee the authenticity of the original document
• Provide legal certification or notarization
• Replace official verification processes required by law

A secured record on Arkova confirms that a document's digital fingerprint was anchored at a given time — nothing more. Users and third parties should perform their own due diligence when relying on any record.

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
  NAV_SEARCH: 'Search Records',
  NAV_VERIFY: 'Verify a Document',
  NAV_HOW_IT_WORKS: 'How It Works',
  NAV_USE_CASES: 'Use Cases',
  NAV_ENTERPRISE: 'Enterprise',
  NAV_DEVELOPERS: 'Developer API',
  NAV_CONTACT: 'Contact',
  NAV_PRIVACY: 'Privacy',
  NAV_TERMS: 'Terms',
  NAV_THIRD_PARTY_NOTICES: 'Third-Party Notices',
  COPYRIGHT: 'Arkova',
  STEP_PREFIX: 'Step',
} as const;

export const LEGAL_PAGE_LABELS = {
  PRIVACY_UPDATE_NOTICE:
    'We may update this policy from time to time. Material changes will be posted here, and registered users will receive notice when required.',
  TERMS_UPDATE_NOTICE:
    'We may update these terms from time to time. Material changes will be posted here, and registered users will receive notice when required.',

  // ── Privacy Policy page body (public, unauthenticated /privacy) ─────────────
  // These were inline JSX prose in PrivacyPage.tsx. They are here for §1.3, and
  // because copy-internal-scaffolding.test.ts only scans copy.ts — a privacy
  // paragraph written inline is a paragraph no guard reads before a stranger
  // does. PrivacyPage.copy-centralization.test.tsx fails if one moves back.
  //
  // Every statement below is a privacy REPRESENTATION to the public. Rewording
  // one is a legal edit. In particular PRIVACY_S5_TRANSFER_BASIS must keep
  // naming no EU→US transfer mechanism: Arkova holds no DPF self-certification
  // (SCRUM-2283) and §1.13 R-7 forbids asserting external status we do not hold
  // — the same rule that governs PRIVACY_NOTICE_LABELS.DPF_TRANSFER_BASIS.

  PRIVACY_PAGE_TITLE: 'Privacy Policy — Arkova Document Verification Platform',
  PRIVACY_PAGE_DESCRIPTION:
    'Arkova privacy policy. Documents never leave your device. Learn how we protect your data with client-side processing and cryptographic fingerprinting.',
  PRIVACY_HEADING: 'Privacy Policy',
  PRIVACY_EFFECTIVE_DATE_LABEL: 'Effective Date:',
  PRIVACY_EFFECTIVE_DATE: 'March 2026',

  PRIVACY_S1_HEADING: '1. Information We Collect',
  // Split across the <strong>not</strong> the paragraph has always carried. The
  // emphasis is the load-bearing word in a data-collection representation, so it
  // is preserved rather than flattened; the surrounding JSX supplies the spaces.
  PRIVACY_S1_BODY_BEFORE_EMPHASIS:
    'Arkova collects only the minimum information necessary to provide our document verification service. This includes your email address, organization name, and account preferences. We do',
  PRIVACY_S1_BODY_EMPHASIS: 'not',
  PRIVACY_S1_BODY_AFTER_EMPHASIS:
    'collect, store, or process your documents — all document fingerprinting occurs entirely within your browser.',

  PRIVACY_S2_HEADING: '2. How We Use Your Information',
  PRIVACY_S2_BODY:
    'Your information is used to authenticate your account, manage your organization, process billing, and deliver the verification service. We do not sell or share your personal information with third parties for marketing purposes.',

  PRIVACY_S3_HEADING: '3. Document Privacy',
  PRIVACY_S3_BODY:
    'Documents are processed entirely on your device. Only a cryptographic fingerprint (a one-way mathematical representation) is sent to our servers. It is mathematically impossible to reconstruct your document from its fingerprint. Your files never leave your browser.',

  PRIVACY_S4_HEADING: '4. Data Security',
  PRIVACY_S4_BODY:
    'We implement industry-standard security measures including encryption in transit (TLS), row-level security on all database tables, and strict access controls. Our audit trail is append-only and tamper-evident.',

  PRIVACY_S5_HEADING: '5. International Data Transfers',
  PRIVACY_S5_TRANSFER_BASIS:
    'The lawful basis for transatlantic personal data transfers is currently under review by our legal counsel and will be published here once confirmed. Regardless of the transfer mechanism, our client-side processing architecture minimizes cross-border data flows — documents never leave your device, and only cryptographic fingerprints are transmitted.',
  PRIVACY_S5_REGIONAL_TRANSFERS:
    'For transfers involving Brazilian data subjects, we use ANPD-approved Standard Contractual Clauses. For Singapore, we comply with PDPA Section 26 transfer requirements. For Mexico, cross-border transfers require data subject consent per LFPDPPP Article 36.',

  PRIVACY_S6_HEADING: '6. Data Retention',
  PRIVACY_S6_BODY:
    'Verification records are retained for as long as your account is active. You may request deletion of your account and associated data by contacting us at',
  PRIVACY_S6_RETENTION_POLICY_PREFIX: 'For detailed retention periods by data category, see our',
  // The link text is DATA_RETENTION_LABELS.PAGE_TITLE — the link names the page
  // it opens, so the page's own title key is the single source. No separate
  // *_LINK key: a half-done rename must not ship link text that disagrees with
  // the page it opens.

  PRIVACY_S7_HEADING: '7. Contact',
  PRIVACY_S7_BODY: 'For privacy-related inquiries, contact us at',
} as const;

// =============================================================================
// THIRD-PARTY NOTICES PAGE (engineering-counsel LGPL/MIT review, 2026-07-28)
// =============================================================================

export const THIRD_PARTY_NOTICES_LABELS = {
  PAGE_TITLE: 'Third-Party Notices — Arkova',
  PAGE_DESCRIPTION: 'Open-source components used to build Arkova, their licenses, and license text.',
  HEADING: 'Third-Party Notices',
  INTRO:
    'Arkova is built with open-source software. This page lists the third-party components included in our applications and their license terms, including the components with obligations beyond a standard permissive license.',
  COPYLEFT_SECTION_HEADING: 'Components with additional license obligations',
  COPYLEFT_SECTION_INTRO:
    'These components carry license terms beyond a standard permissive license (MIT/ISC/BSD/Apache-2.0). Each entry states what is used, how, and links the full license text.',
  PENDING_BADGE: 'In development — not yet shipped',
  UNMODIFIED_LABEL: 'Used unmodified from the published upstream release.',
  SOURCE_LINK_LABEL: 'Unmodified upstream source',
  LICENSE_TEXT_LABEL: 'License text',
  GENERAL_SECTION_HEADING: 'Open-source components',
  GENERAL_SECTION_INTRO:
    'The following components are used under their respective permissive licenses (MIT, ISC, BSD, Apache-2.0, and similar). This list is generated from our dependency tree.',
  GENERATED_AT_PREFIX: 'List generated',
  REPOSITORY_LABEL: 'Repository',
} as const;

// =============================================================================
// HOW IT WORKS PAGE (GEO-08)
// =============================================================================

export const HOW_IT_WORKS_LABELS = {
  PAGE_TITLE: 'How Arkova Works — Document Verification in 3 Steps',
  PAGE_DESCRIPTION: 'Learn how Arkova secures documents with client-side fingerprinting, permanent network anchoring, and universal verification. Privacy-first by design.',
  HERO_TITLE: 'How Arkova Works',
  HERO_SUBTITLE: 'Three steps to permanently verifiable records. Your documents never leave your device.',
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
  DIFF_AI_DESC: 'Intelligent metadata extraction identifies document types, issuers, dates, and fields — making records searchable and structured.',
  DIFF_OPEN_TITLE: 'Open Verification',
  DIFF_OPEN_DESC: 'Verification is free and requires no account. Anyone with the document can confirm its authenticity against the permanent record.',
  CTA_TITLE: 'Ready to Secure Your Documents?',
  CTA_DESCRIPTION: 'Start anchoring documents in minutes. Free tier available.',
  CTA_BUTTON: 'Get Started',
} as const;

// =============================================================================
// USE CASES PAGE (GEO-08)
// =============================================================================

export const USE_CASES_LABELS = {
  PAGE_TITLE: 'Use Cases — Who Uses Arkova for Document Verification',
  PAGE_DESCRIPTION: 'Discover how education, legal, healthcare, finance, HR, and government organizations use Arkova to verify records and anchor documents.',
  HERO_TITLE: 'Who Uses Arkova',
  HERO_SUBTITLE: 'Organizations across industries trust Arkova to make documents verifiable, tamper-proof, and portable.',
  EDUCATION_TITLE: 'Education',
  EDUCATION_DESC: 'Universities and institutions anchor degree certificates and transcripts, enabling instant verification by employers and other schools. Graduates carry provable records wherever they go.',
  EDUCATION_EXAMPLE: 'A university anchors 10,000 diplomas at graduation. Employers verify any graduate in seconds.',
  LEGAL_TITLE: 'Legal',
  LEGAL_DESC: 'Law firms and courts timestamp contracts, evidence, and filings. Anchored records prove a document existed at a specific point in time, providing an unalterable chain of custody.',
  LEGAL_EXAMPLE: 'A firm anchors a signed contract. Years later, either party can prove the original terms were never modified.',
  HEALTHCARE_TITLE: 'Healthcare',
  HEALTHCARE_DESC: 'Hospitals and licensing boards verify medical licenses, board certifications, and continuing education. Reduces manual verification from weeks to seconds.',
  HEALTHCARE_EXAMPLE: 'A hospital verifies a surgeon\'s board certification instantly before granting privileges.',
  FINANCE_TITLE: 'Finance',
  FINANCE_DESC: 'Financial institutions anchor compliance documentation, audit reports, and regulatory filings. Creates an immutable audit trail for regulators and internal compliance teams.',
  FINANCE_EXAMPLE: 'A bank anchors quarterly compliance reports, creating tamper-proof evidence for regulatory review.',
  HR_TITLE: 'HR & Recruiting',
  HR_DESC: 'HR teams and recruiters verify candidate records, background checks, and employment history. Integrates with applicant tracking systems for automated verification workflows.',
  HR_EXAMPLE: 'A recruiter verifies a candidate\'s professional certifications directly from their document portfolio.',
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
  FAQ_4_A: 'Arkova supports 21 document types including degrees, licenses, certificates, legal documents, financial records, and more. Any digital document can be fingerprinted and anchored.',
  FAQ_5_Q: 'Is there an API for automated verification?',
  FAQ_5_A: 'Yes. Arkova provides a RESTful Verification API with TypeScript and Python SDKs for programmatic access. Enterprise plans include batch processing, webhooks, and dedicated support.',
  CTA_TITLE: 'See It in Action',
  CTA_DESCRIPTION: 'Try verifying a record on the public search page, or create an account to start anchoring.',
  CTA_BUTTON_SEARCH: 'Search Records',
  CTA_BUTTON_SIGNUP: 'Create Account',
} as const;

// =============================================================================
// ENTERPRISE PAGE (GEO-08)
// =============================================================================

export const ENTERPRISE_LABELS = {
  PAGE_TITLE: 'Enterprise Document Verification — Arkova for Organizations',
  PAGE_DESCRIPTION: 'Enterprise-grade document verification with API access, batch processing, SSO, webhooks, and dedicated support. Built on permanent anchoring infrastructure.',
  HERO_TITLE: 'Enterprise-Grade Document Verification',
  HERO_SUBTITLE: 'Scalable, secure, and auditable document infrastructure for organizations that need more than a login.',
  FEATURES_TITLE: 'Built for Scale',
  FEAT_API_TITLE: 'RESTful API Access',
  FEAT_API_DESC: 'Programmatic record verification and anchoring. Full OpenAPI documentation with TypeScript and Python SDKs.',
  FEAT_BATCH_TITLE: 'Batch Processing',
  FEAT_BATCH_DESC: 'Anchor thousands of documents in a single operation. Optimized batching reduces costs while maintaining individual verifiability.',
  FEAT_WEBHOOKS_TITLE: 'Custom Webhooks',
  FEAT_WEBHOOKS_DESC: 'Real-time notifications when records are anchored, verified, or expire. Integrate with your existing workflows.',
  FEAT_SSO_TITLE: 'Single Sign-On',
  FEAT_SSO_DESC: 'SAML and OAuth integration for seamless team access. Centralized user management with role-based permissions.',
  FEAT_SUPPORT_TITLE: 'Dedicated Support',
  FEAT_SUPPORT_DESC: 'Named account manager, priority response times, and onboarding assistance for your team.',
  FEAT_SLA_TITLE: 'SLA Guarantees',
  FEAT_SLA_DESC: '99.9% uptime commitment with proactive monitoring and incident response. Enterprise-grade reliability.',
  TRUST_TITLE: 'Trusted Infrastructure',
  TRUST_ANCHORING_TITLE: 'Permanent Anchoring',
  TRUST_ANCHORING_DESC: 'Every record fingerprint is recorded on a public, immutable network. No single entity can alter the record.',
  TRUST_SOC2_TITLE: 'SOC 2 Compliance Path',
  TRUST_SOC2_DESC: 'Security controls designed for SOC 2 Type II certification. Comprehensive audit trails and access logging.',
  TRUST_ENCRYPTION_TITLE: 'End-to-End Privacy',
  TRUST_ENCRYPTION_DESC: 'Documents never leave the user\'s device. Only cryptographic fingerprints are transmitted and stored.',
  TRUST_RLS_TITLE: 'Row-Level Security',
  TRUST_RLS_DESC: 'Every database query is scoped to the authenticated user\'s organization. Data isolation is enforced at the infrastructure level.',
  TRUST_INTL_TITLE: 'International Compliance',
  TRUST_INTL_DESC: 'Compliance controls spanning 13 regulatory frameworks across 10+ jurisdictions including GDPR, LGPD, PDPA, and LFPDPPP.',
  INTEGRATIONS_TITLE: 'Integrations',
  INTEGRATIONS_SUBTITLE: 'Connect Arkova to your existing tools and workflows.',
  INT_API_TITLE: 'REST API',
  INT_API_DESC: 'Full-featured verification and anchoring API with comprehensive documentation.',
  INT_SDK_TITLE: 'TypeScript & Python SDKs',
  INT_SDK_DESC: 'Official client libraries for rapid integration. Type-safe with full IDE support.',
  INT_MCP_TITLE: 'MCP Server for AI Agents',
  INT_MCP_DESC: 'Model Context Protocol server enables AI agents to verify and anchor records programmatically.',
  INT_WEBHOOKS_TITLE: 'Webhook Events',
  INT_WEBHOOKS_DESC: 'Subscribe to record lifecycle events and integrate with Slack, Zapier, or custom endpoints.',
  CTA_TITLE: 'Ready to Scale Document Verification?',
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
  PAGE_DESCRIPTION: 'Step-by-step instructions to verify any Arkova record using only public data.',
  HERO_TITLE: 'Verify Without Arkova',
  HERO_SUBTITLE: 'Every Arkova record can be independently verified using publicly available data. If Arkova disappears tomorrow, your proofs still work.',
  STEP_1_TITLE: 'Compute the Document Fingerprint',
  STEP_1_DESC: 'Compute the SHA-256 fingerprint of your document. This is the same fingerprint Arkova computed when the document was anchored.',
  STEP_1_CMD: 'shasum -a 256 your-document.pdf',
  STEP_2_TITLE: 'Find the Network Record',
  STEP_2_DESC: 'Look up the anchoring record on a public network explorer. The OP_RETURN data contains a Merkle root that includes your fingerprint.',
  STEP_2_CMD: 'curl https://mempool.space/api/tx/{txid}',
  STEP_3_TITLE: 'Verify the Merkle Proof',
  STEP_3_DESC: 'Using the Merkle proof from your proof package, verify that your fingerprint is included in the Merkle root.',
  STEP_3_CMD: './verify.sh --fingerprint {fingerprint} --proof proof-package.json',
  STEP_4_TITLE: 'Verify the Timestamp (Optional)',
  STEP_4_DESC: 'If the record has an RFC 3161 timestamp, verify it independently using OpenSSL.',
  STEP_4_CMD: 'openssl ts -verify -data signed-attrs.der -in timestamp.tst -CAfile tsa-ca.pem',
  FAQ_SHUTDOWN_Q: 'What if Arkova shuts down?',
  FAQ_SHUTDOWN_A: 'Your proofs remain valid. The network records are permanent and public. The Merkle proofs in your proof packages contain everything needed for independent verification.',
  FAQ_OFFLINE_Q: 'What if the Arkova website is offline?',
  FAQ_OFFLINE_A: 'You can verify using only the proof package file and a public network explorer. No Arkova API call is required.',
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
  // Table headers
  TABLE_HEADER_CATEGORY: 'Data Category',
  TABLE_HEADER_PERIOD: 'Retention Period',
  TABLE_HEADER_BASIS: 'Legal Basis',
  TABLE_HEADER_DELETION: 'Deletion Method',
  SECTION_SCHEDULE: 'Retention Schedule',
  // Retention schedule rows
  CAT_ANCHOR_RECORDS: 'Anchor Records',
  CAT_SIGNATURE_RECORDS: 'Signature Records',
  CAT_TIMESTAMP_TOKENS: 'Timestamp Tokens',
  CAT_AUDIT_EVENTS: 'Audit Events',
  CAT_BILLING_EVENTS: 'Billing Events',
  CAT_USER_ACCOUNTS: 'User Accounts',
  CAT_AI_METADATA: 'AI Extraction Metadata',
  CAT_APP_LOGS: 'Application Logs',
  PERIOD_INDEFINITE: 'Indefinite',
  PERIOD_7_YEARS: '7 years',
  PERIOD_2_YEARS: '2 years',
  PERIOD_1_YEAR: '1 year',
  PERIOD_UNTIL_DELETION: 'Until deletion requested',
  BASIS_EIDAS_TSP: 'eIDAS Art. 24(2) — qualified trust service provider record-keeping',
  BASIS_EIDAS_SIG: 'eIDAS Art. 24(2) — qualified electronic signature evidence',
  BASIS_EIDAS_TS: 'eIDAS Art. 24(2) — qualified timestamp evidence',
  BASIS_SOC2_SOX: 'SOC 2 Type II / SOX Section 802',
  BASIS_SOX_FINANCIAL: 'Financial records retention (SOX)',
  BASIS_GDPR_SERVICE: 'Service delivery (GDPR Art. 6(1)(b))',
  BASIS_AI_AUDIT: 'Model improvement and audit trail',
  BASIS_OPERATIONAL: 'Operational monitoring',
  DELETION_NO_PROOF: 'No deletion (core proof chain)',
  DELETION_NO_LEGAL: 'No deletion (legal evidence)',
  DELETION_ARCHIVE: 'Archival then deletion',
  DELETION_ANONYMIZE: 'Anonymization on request',
  DELETION_AUTOMATED: 'Automated deletion',
} as const;

// ─── Provenance Timeline (COMP-02) ─────────────────────────────────────

export const PROVENANCE_LABELS = {
  SECTION_TITLE: 'Provenance Timeline',
  SECTION_DESCRIPTION: 'Complete chain of custody from upload through verification.',
  EXPORT_JSON: 'Export as JSON',
  LOADING: 'Loading provenance data...',
  NO_EVENTS: 'No provenance data available.',
  ERROR: 'Unable to load provenance timeline.',
  EVENT_LABELS: {
    credential_created: 'Record Created',
    anchor_submitted: 'Submitted to Network',
    batch_included: 'Included in Batch',
    network_confirmed: 'Network Confirmed',
    credential_revoked: 'Record Revoked',
    signature_created: 'Signature Created',
    signature_completed: 'Signature Completed',
    timestamp_acquired: 'Timestamp Acquired',
    verification_query: 'Verification Query',
  } as Record<string, string>,
} as const;

// ─── Auditor Batch Verification (COMP-06) ───────────────────────────────

export const AUDITOR_BATCH_LABELS = {
  PAGE_TITLE: 'Audit Batch Verification',
  PAGE_DESCRIPTION: 'Verify records in bulk for SOC 2 and ISO 27001 audit sampling (ISA 530).',
  SELECT_MODE: 'Verification Mode',
  MODE_CSV: 'Record IDs',
  MODE_SAMPLE: 'Random Sample',
  CSV_LABEL: 'Record IDs (one per line or comma-separated)',
  CSV_HINT: 'Maximum 1,000 IDs per batch. Paste from CSV or enter manually.',
  SAMPLE_PCT_LABEL: 'Sample Percentage',
  SEED_LABEL: 'Random Seed',
  SEED_PLACEHOLDER: 'Optional — for reproducibility',
  SEED_HINT: 'Use the same seed to reproduce identical sampling results (ISA 530).',
  SUBMIT: 'Run Batch Verification',
  DOWNLOAD_CSV: 'Download CSV Report',
  VERIFYING: 'Verifying...',
  COL_CREDENTIAL_ID: 'Record ID',
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
  ERR_EMPTY_IDS: 'Enter at least one record ID',
  ERR_MAX_IDS: 'Maximum 1,000 record IDs per batch',
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

// =============================================================================
// FERPA DIRECTORY INFO OPT-OUT (REG-02)
// =============================================================================

export const DIRECTORY_OPT_OUT_LABELS = {
  TITLE: 'Directory Information Preferences',
  DESCRIPTION: 'Control whether your name, degree type, and dates of attendance are shared when records are verified. This applies to education records only.',
  OPT_OUT_TOGGLE: 'Opt out of directory information disclosure',
  OPT_OUT_HELP: 'When enabled, verification responses will not include your name, degree type, or dates of attendance per FERPA Section 99.37.',
  BULK_IMPORT_TITLE: 'Bulk Opt-Out Import',
  BULK_IMPORT_DESCRIPTION: 'Upload a CSV file with student record IDs and opt-out preferences to update multiple records at once.',
  SUPPRESSED_NOTICE: 'Some details have been withheld per the student\'s privacy preferences.',
  SUCCESS: 'Directory information preferences updated.',
  BULK_SUCCESS: 'Bulk opt-out import completed.',
} as const;

// =============================================================================
// HIPAA COMPLIANCE (REG-05, REG-06, REG-07, REG-10)
// =============================================================================

export const HIPAA_LABELS = {
  MFA_REQUIRED_TITLE: 'Additional Verification Required',
  MFA_REQUIRED_DESCRIPTION: 'This organization requires multi-factor authentication to access healthcare records. Please enable two-factor authentication to continue.',
  MFA_ENABLE_BUTTON: 'Enable Two-Factor Authentication',
  MFA_CHALLENGE_TITLE: 'Verify Your Identity',
  MFA_CHALLENGE_DESCRIPTION: 'Enter your authentication code to access healthcare records.',
  SESSION_TIMEOUT_TITLE: 'Session Expired',
  SESSION_TIMEOUT_DESCRIPTION: 'Your session has timed out due to inactivity. Please sign in again to continue.',
  SESSION_TIMEOUT_SETTING: 'Inactivity Timeout',
  SESSION_TIMEOUT_HELP: 'Automatically sign out users after this period of inactivity. Recommended: 15 minutes for organizations handling healthcare records.',
  AUDIT_REPORT_TITLE: 'Healthcare Access Audit Report',
  AUDIT_REPORT_DESCRIPTION: 'Comprehensive log of all access to healthcare records, including views, verifications, and exports.',
  AUDIT_FILTER_DATE: 'Date Range',
  AUDIT_FILTER_TYPE: 'Document Type',
  AUDIT_FILTER_USER: 'User',
  AUDIT_FILTER_ACTION: 'Action',
  AUDIT_EXPORT_CSV: 'Export as CSV',
  AUDIT_EXPORT_PDF: 'Export as PDF',
  EMERGENCY_ACCESS_TITLE: 'Emergency Access Request',
  EMERGENCY_ACCESS_DESCRIPTION: 'Request time-limited emergency access to healthcare records. Requires approval from an organization administrator.',
  EMERGENCY_ACCESS_REASON: 'Reason for Emergency Access',
  EMERGENCY_ACCESS_DURATION: 'Access Duration',
  EMERGENCY_ACCESS_GRANTED: 'Emergency access granted. Expires in {duration}.',
  EMERGENCY_ACCESS_REVOKED: 'Emergency access has been revoked.',
  EMERGENCY_ACCESS_EXPIRED: 'Emergency access has expired.',
} as const;

// =============================================================================
// DATA CORRECTION (REG-19 / APP 13)
// =============================================================================

export const DATA_CORRECTION_LABELS = {
  TITLE: 'Request data correction',
  DESCRIPTION: 'If any personal information we hold about you is incorrect, you can request a correction. We will respond within 30 days per APP 13.',
  FIELD_LABEL: 'What needs to be corrected?',
  FIELD_PLACEHOLDER: 'Describe the information that is incorrect and what the correct information should be.',
  SUBMIT: 'Submit correction request',
  SUBMITTING: 'Submitting...',
  SUCCESS: 'Correction request submitted. We will respond within 30 days.',
  ERROR: 'Failed to submit correction request. Please try again.',
  PENDING_LABEL: 'Correction request history',
  NO_PENDING: 'No pending correction requests.',
  STATUS_PROCESSING: 'Processing',
  STATUS_COMPLETED: 'Completed',
  STATUS_REJECTED: 'Rejected',
} as const;

// =============================================================================
// JURISDICTION PRIVACY NOTICES (REG-14)
// =============================================================================

/** NCA-07 / NCA-08 / NCA-09 — "Audit My Organization" UI copy */
export const AUDIT_MY_ORG_LABELS = {
  TITLE: 'Audit My Organization',
  DESCRIPTION:
    'Run a live compliance audit across every jurisdiction you operate in. Get a scored report with prioritised next steps in under 30 seconds.',
  CTA: 'Start compliance audit',
  RUNNING: 'Running compliance audit…',
  PROGRESS_ANALYZING: 'Analyzing records…',
  PROGRESS_CHECKING: 'Checking regulatory requirements…',
  PROGRESS_GENERATING: 'Generating compliance report…',
  PROGRESS_ESTIMATE: 'This usually completes in under 30 seconds.',
  VIEW_RESULTS: 'View results',
  RETRY: 'Try again',
  ERROR_HTTP_PREFIX: 'Audit failed with HTTP',
  ERROR_AUDIT_FAILED: 'The audit could not complete. Please retry.',
  ERROR_NETWORK: 'Network error — please check your connection and retry.',
  ERROR_FETCH_UNAVAILABLE: 'Your browser cannot reach the audit service. Please refresh and retry.',
  IN_PROGRESS_TOOLTIP: 'Audit is already in progress for this organization.',
  // SCRUM-2938 S1: "compliance score" phrasing retired from user-facing copy.
  SCORECARD_TITLE: 'Audit scorecard',
  SCORECARD_EMPTY: 'Run your first audit to see your results.',
  SCORECARD_GAPS_HEADING: 'Open gaps',
  SCORECARD_RECOMMENDATIONS_HEADING: 'Recommended actions',
  SCORECARD_QUICK_WINS: 'Quick wins',
  SCORECARD_CRITICAL: 'Critical',
  SCORECARD_UPCOMING: 'Upcoming',
  SCORECARD_STANDARD: 'Other',
  SCORECARD_PER_JURISDICTION: 'Score by jurisdiction',
  SCORECARD_TIMELINE: 'Score over time',
  SCORECARD_LAST_AUDITED: 'Last audited',
  SCORECARD_EXPORT_PDF: 'Export PDF',
  SCORECARD_EXPORTING: 'Preparing PDF…',
  SCORECARD_DISCLAIMER:
    'This report reflects record status as of the audit date. It is not legal advice.',
  SCORECARD_LOADING: 'Loading…',
  SCORECARD_BACK_TO_DASHBOARD: '← Back to dashboard',
  SCORECARD_NO_JURISDICTION_DATA: 'No jurisdiction data.',
  SCORECARD_NO_GAPS: 'No open compliance gaps.',
  SCORECARD_TIMELINE_INSUFFICIENT: 'Not enough history yet.',
  SCORECARD_ORG_REQUIRED_TITLE: 'Compliance audits are organisation-scoped',
  SCORECARD_ORG_REQUIRED_BODY:
    'Create or join an organisation to run a compliance audit across every jurisdiction you operate in.',
  SCORECARD_ORG_REQUIRED_CTA: 'Create organisation',
} as const;

export const PRIVACY_NOTICE_LABELS = {
  TITLE: 'Privacy & Data Protection',
  DESCRIPTION: 'Information about how your data is protected under applicable laws.',
  // ── Per-jurisdiction notices ────────────────────────────────────────────────
  // Each block is the full public notice for one jurisdiction: title, summary,
  // and the four cells JurisdictionPrivacyNotices renders (regulator, rights,
  // cross-border transfer basis, breach-notification timeline).
  //
  // These four used to be inline literals in the component's JURISDICTION_NOTICES
  // table. They render on the PUBLIC, unauthenticated /privacy page, so §1.3 puts
  // them here — and living here is also what puts them under
  // copy-internal-scaffolding.test.ts, which is the guard that catches an
  // internal drafting note before it reaches a reader. A jurisdiction string
  // written back inline is outside that guard; PrivacyPage.copy-centralization
  // .test.tsx fails if one ever is.
  //
  // Every value below is a statement of external law or of a regulator's name.
  // Changing one is a legal edit, not a copy edit.

  FERPA_TITLE: 'FERPA (Family Educational Rights and Privacy Act)',
  FERPA_DESCRIPTION: 'Applies to education records. Your records are protected under 34 CFR Part 99. You have the right to access, amend, and control disclosure of your education records.',
  FERPA_REGULATOR: 'U.S. Department of Education',
  FERPA_RIGHTS: ['Access education records', 'Request amendments', 'Control disclosure', 'Opt out of directory information'],
  FERPA_TRANSFER_BASIS: 'N/A (domestic)',
  FERPA_BREACH_TIMELINE: 'N/A (funding withdrawal mechanism)',

  HIPAA_TITLE: 'HIPAA (Health Insurance Portability and Accountability Act)',
  HIPAA_DESCRIPTION: 'Applies to healthcare records. Protected health information is handled per 45 CFR Part 164 with technical safeguards including encryption, access controls, and audit logging.',
  HIPAA_REGULATOR: 'HHS Office for Civil Rights (OCR)',
  HIPAA_RIGHTS: ['Access PHI', 'Request amendments', 'Accounting of disclosures', 'Request restrictions', 'Confidential communications'],
  HIPAA_TRANSFER_BASIS: 'Business Associate Agreement (BAA)',
  HIPAA_BREACH_TIMELINE: '60 calendar days (BA to CE)',

  KENYA_TITLE: 'Kenya Data Protection Act 2019',
  KENYA_DESCRIPTION: 'Applies to data subjects in Kenya. Your personal data is processed lawfully under Sections 25-38. You have rights of access, correction, and erasure. Contact the ODPC for complaints.',
  KENYA_REGULATOR: 'Office of the Data Protection Commissioner (ODPC)',
  KENYA_RIGHTS: ['Access', 'Rectification', 'Erasure', 'Data portability', 'Object to processing'],
  KENYA_TRANSFER_BASIS: 'Standard Contractual Clauses (Section 48)',
  KENYA_BREACH_TIMELINE: '72 hours (controller to ODPC)',

  AUSTRALIA_TITLE: 'Australian Privacy Act 1988',
  AUSTRALIA_DESCRIPTION: 'Applies to data subjects in Australia. Your personal information is handled per the Australian Privacy Principles (APPs). You have rights of access and correction under APP 12-13.',
  AUSTRALIA_REGULATOR: 'Office of the Australian Information Commissioner (OAIC)',
  AUSTRALIA_RIGHTS: ['Access (APP 12)', 'Correction (APP 13)'],
  AUSTRALIA_TRANSFER_BASIS: 'APP 8 assessment + contractual provisions',
  AUSTRALIA_BREACH_TIMELINE: '30-day assessment window (NDB scheme)',

  SOUTH_AFRICA_TITLE: 'POPIA (Protection of Personal Information Act)',
  SOUTH_AFRICA_DESCRIPTION: 'Applies to data subjects in South Africa. Your personal information is processed per POPIA Sections 19-22. You have rights of access, correction, and objection.',
  SOUTH_AFRICA_REGULATOR: 'Information Regulator',
  SOUTH_AFRICA_RIGHTS: ['Access (Section 23)', 'Correction/deletion (Section 24)', 'Object to processing (Section 11)'],
  SOUTH_AFRICA_TRANSFER_BASIS: 'Section 72 binding agreement (SCCs)',
  SOUTH_AFRICA_BREACH_TIMELINE: 'As soon as reasonably possible',

  NIGERIA_TITLE: 'Nigeria Data Protection Act 2023',
  NIGERIA_DESCRIPTION: 'Applies to data subjects in Nigeria. Your personal data is protected under the NDPA. You have rights of access, rectification, and erasure.',
  NIGERIA_REGULATOR: 'Nigeria Data Protection Commission (NDPC)',
  NIGERIA_RIGHTS: ['Access', 'Rectification', 'Erasure', 'Data portability', 'Object', 'Restrict processing'],
  NIGERIA_TRANSFER_BASIS: 'Standard Contractual Clauses',
  NIGERIA_BREACH_TIMELINE: '72 hours (controller to NDPC)',

  BRAZIL_TITLE: 'LGPD (Lei Geral de Proteção de Dados)',
  BRAZIL_DESCRIPTION: 'Applies to data subjects in Brazil. Your personal data is processed lawfully under LGPD Articles 6-10. You have rights of access, correction, anonymization, portability, and deletion. Contact the ANPD for complaints.',
  BRAZIL_REGULATOR: 'Autoridade Nacional de Proteção de Dados (ANPD)',
  BRAZIL_RIGHTS: ['Access (Art. 18-I)', 'Correction (Art. 18-III)', 'Anonymization/deletion (Art. 18-IV)', 'Data portability (Art. 18-V)', 'Revoke consent (Art. 18-IX)'],
  BRAZIL_TRANSFER_BASIS: 'ANPD Standard Contractual Clauses (mandatory template)',
  BRAZIL_BREACH_TIMELINE: 'Reasonable time (ANPD determines specific deadline per incident)',

  SINGAPORE_TITLE: 'PDPA (Personal Data Protection Act 2012)',
  SINGAPORE_DESCRIPTION: 'Applies to data subjects in Singapore. Your personal data is protected under the PDPA. You have rights of access and correction. Organizations must obtain consent and provide notification before collecting data.',
  SINGAPORE_REGULATOR: 'Personal Data Protection Commission (PDPC)',
  SINGAPORE_RIGHTS: ['Access (§21)', 'Correction (§22)', 'Withdraw consent (§16)', 'Data portability (§26H)'],
  SINGAPORE_TRANSFER_BASIS: 'Comparable protection standard or ASEAN Model Contractual Clauses',
  SINGAPORE_BREACH_TIMELINE: '3 calendar days once classified as notifiable (500+ individuals)',

  MEXICO_TITLE: 'LFPDPPP (Ley Federal de Protección de Datos Personales en Posesión de los Particulares)',
  MEXICO_DESCRIPTION: 'Applies to data subjects in Mexico. Your personal data is protected under the LFPDPPP (2025 reform). You have ARCO rights: access, rectification, cancellation, and opposition. Consent is required for cross-border transfers.',
  MEXICO_REGULATOR: 'Secretaría de Anticorrupción y Buen Gobierno (SABG)',
  MEXICO_RIGHTS: ['Access (ARCO)', 'Rectification (ARCO)', 'Cancellation (ARCO)', 'Opposition (ARCO)'],
  MEXICO_TRANSFER_BASIS: 'Consent-based (must specify countries, recipients, purposes)',
  MEXICO_BREACH_TIMELINE: 'Without delay (no specific statutory timeline)',

  COLOMBIA_TITLE: 'Colombia Law 1581 of 2012 (Personal Data Protection)',
  COLOMBIA_DESCRIPTION: 'Applies to data subjects in Colombia. Your personal data is protected under Law 1581 + Decree 1377. You have rights of access, rectification, erasure, and consent revocation. US transfers rely on the SIC adequacy list.',
  COLOMBIA_REGULATOR: 'Superintendencia de Industria y Comercio (SIC)',
  COLOMBIA_RIGHTS: ['Access (Art. 8(a))', 'Rectification (Art. 8(c))', 'Deletion (Art. 8(e))', 'Consent revocation (Art. 8(d))', 'Complaint to SIC'],
  COLOMBIA_TRANSFER_BASIS: 'SIC adequacy list (US included) + SIC Model Contractual Clauses (Dec 2025)',
  COLOMBIA_BREACH_TIMELINE: '15 business days (controller to SIC)',

  THAILAND_TITLE: 'Thailand PDPA (Personal Data Protection Act 2019)',
  THAILAND_DESCRIPTION: 'Applies to data subjects in Thailand. Your personal data is protected under the PDPA. You have access, portability, objection, deletion, restriction, and rectification rights. Cross-border transfers use SCCs aligned with ASEAN MCCs or GDPR SCCs referencing Thai law.',
  THAILAND_REGULATOR: 'Personal Data Protection Committee (PDPC)',
  THAILAND_RIGHTS: ['Access (§30)', 'Portability (§31)', 'Object (§32)', 'Deletion (§33)', 'Restriction (§34)', 'Rectification (§35)', 'Withdraw consent (§19)'],
  THAILAND_TRANSFER_BASIS: 'SCCs aligned with ASEAN MCCs or GDPR SCCs referencing Thai PDPA',
  THAILAND_BREACH_TIMELINE: '72 hours (controller to PDPC)',

  MALAYSIA_TITLE: 'Malaysia PDPA 2010 (as amended 2024)',
  MALAYSIA_DESCRIPTION: 'Applies to data subjects in Malaysia. Your personal data is protected under the PDPA as amended in 2024. You have access, correction, consent withdrawal, and (from 2025) data portability rights. Cross-border transfers use a risk-based Transfer Impact Assessment framework.',
  MALAYSIA_REGULATOR: 'Personal Data Protection Commissioner (PDP Malaysia)',
  MALAYSIA_RIGHTS: ['Access (§30)', 'Correction (§34)', 'Withdraw consent (§38)', 'Prevent processing (§42)', 'Prevent direct marketing (§43)', 'Data portability (§43A)'],
  MALAYSIA_TRANSFER_BASIS: 'Risk-based Transfer Impact Assessment (§129 as amended 2024) + SCC-style contract terms',
  MALAYSIA_BREACH_TIMELINE: '72 hours (data user to PDP Commissioner, 2025 regulations)',

  DPF_TITLE: 'EU–US Personal Data Transfers',
  // SCRUM-2283: the prior copy falsely asserted "Arkova self-certifies under the
  // EU-US Data Privacy Framework". Arkova does NOT hold an active DPF
  // self-certification, so that claim is removed (R-7 claims gate). The
  // replacement lawful-transfer basis (e.g. executed EU Standard Contractual
  // Clauses) is COUNSEL-REQUIRED and must not be invented here — placeholder
  // pending legal review.
  DPF_DESCRIPTION: 'The lawful basis for transatlantic personal data transfers is under review by legal counsel and will be published here once confirmed. Individuals retain the right to access, correct, or delete their data and to file a complaint with their national data protection authority.',
  // The bracketed drafting note that used to close DPF_DESCRIPTION ("Counsel
  // review required — do not assert a specific transfer mechanism until
  // confirmed.") was an instruction to us, and it rendered verbatim on the
  // PUBLIC /privacy page. Removed. The instruction itself remains correct and
  // lives here, in a comment, where it belongs: do not name a transfer
  // mechanism in either string below until counsel confirms one.
  //
  // DPF_TRANSFER_BASIS is the "Cross-Border Transfer Basis" cell for the EU–US
  // notice. It previously read "...(counsel-required)", which tagged a public
  // notice as an open internal ticket. It now states the same position as a
  // deliberate disclosure — under review, and explicitly asserting nothing —
  // which is the §1.5 / §1.13 R-7 form: say what is NOT asserted.
  DPF_TRANSFER_BASIS: 'Under legal review — no specific transfer mechanism is asserted at this time',
  // The regulator for this notice is the reader's OWN supervisory authority, not
  // a body Arkova is certified by or answerable to — the same SCRUM-2283
  // reasoning that removed the DPF claim removed the DPF-panel reference here.
  DPF_REGULATOR: 'Your national data protection authority (EU/EEA)',
  DPF_RIGHTS: ['Access', 'Correction', 'Deletion', 'File complaint with your DPA'],
  DPF_BREACH_TIMELINE: 'Per applicable GDPR / national law',

  REGULATOR_LABEL: 'Regulator',
  RIGHTS_LABEL: 'Your Rights',
  TRANSFER_BASIS_LABEL: 'Cross-Border Transfer Basis',
  BREACH_TIMELINE_LABEL: 'Breach Notification Timeline',
  INFORMATION_OFFICER_LABEL: 'Information Officer',
} as const;

// ─── Source Provenance Display (CSI-03 / SCRUM-1599) ──────────────────────────

export const SOURCE_PROVENANCE_LABELS = {
  SECTION_TITLE: 'Source Provenance',
  EVIDENCE_LEVEL_LABEL: 'Evidence Level',
  SOURCE_URL_LABEL: 'Source',
  PROVIDER_LABEL: 'Provider',
  FETCHED_AT_LABEL: 'Captured',
  BADGE_ALT: 'Arkova Verified',
  SHARE_LINKEDIN_LABEL: 'Add to LinkedIn Profile',
  SHARE_LINKEDIN_DESCRIPTION: 'Use your Arkova verification URL as the Credential URL on LinkedIn.',
  PROOF_SECTION_TITLE: 'Evidence Package',
  PROOF_SECTION_DESCRIPTION: 'Cryptographic proof of source provenance included in the verification record.',
  // SCRUM-2913 (Lane 2 wiring, R-7 §1.13): this is a PROVENANCE link only —
  // "this record's evidence was sourced from this registry entry" — never a
  // claim that Arkova is listed, registered, or endorsed by Credential Engine.
  REGISTRY_REFERENCE_LABEL: 'Registry reference',
  REGISTRY_REFERENCE_DESCRIPTION: 'A source reference, not a Credential Engine listing or endorsement.',
} as const;

// ─── CTDL Data Link (public verify page structured-data export) ──────────────
// The public CTDL JSON-LD projection (GET /api/v1/credentials/:publicId/ctdl,
// services/worker/src/api/v1/credentials-ctdl.ts) is a mature, tested,
// standards-conformant endpoint with no UI surface anywhere in the product
// before this. Copy is a data-FORMAT description only — never a Registry
// membership / publication-status claim (R-7 / CE-06a, see
// services/worker/src/ctdl/ctdl-claims-guard.ts for the banned phrase set
// this wording is written to avoid: "listed", "published/live/appears in the
// Registry", etc.).
export const CTDL_DATA_LINK_LABELS = {
  SECTION_LABEL: 'Structured data',
  LINK_TEXT: 'CTDL data (JSON-LD)',
} as const;

// ─── LinkedIn Share (CSI-03 / SCRUM-1599) ─────────────────────────────────────

export const LINKEDIN_SHARE_LABELS = {
  CREDENTIAL_URL_LABEL: 'Credential URL for LinkedIn',
  COPY_URL: 'Copy verification URL',
  URL_COPIED: 'Verification URL copied to clipboard',
  URL_COPY_FAILED: 'Unable to copy verification URL',
  NOTE: 'Use this URL as the Credential URL when adding to your LinkedIn profile.',
  CREDENTIAL_URL_HELP: 'This links to your Arkova verification page, not a native LinkedIn badge.',
} as const;

// ─── Badge SVG (CSI-03 / SCRUM-1599) ─────────────────────────────────────────

export const BADGE_LABELS = {
  ALT_TEXT: 'Arkova Verified',
  ALT_TEXT_PREFIX: 'Arkova',
  TITLE: 'Arkova Verification Badge',
  STATUS_VERIFIED: 'Verified',
  STATUS_REVOKED: 'Revoked',
  STATUS_EXPIRED: 'Expired',
  STATUS_PENDING: 'Pending',
  STATUS_SUBMITTED: 'Submitted',
  STATUS_SUPERSEDED: 'Superseded',
  STATUS_UNAVAILABLE: 'Unavailable',
  verified: 'Verified',
  revoked: 'Revoked',
  expired: 'Expired',
  pending: 'Pending',
  submitted: 'Submitted',
  superseded: 'Superseded',
  unavailable: 'Unavailable',
} as const;

/** DPO/Information Officer contact — single source for all jurisdictions (REG-28) */
export const PRIVACY_CONTACT_EMAIL = 'privacy@arkova.ai';

/**
 * General support contact. Rendered as the account/data-deletion route on the
 * public /privacy page, so it is copy, not config — an address that reaches
 * nobody is a broken privacy representation, not a broken link.
 */
export const SUPPORT_CONTACT_EMAIL = 'support@arkova.ai';

// ─── Evidence Level Labels (CSI-03 / SCRUM-1599) ─────────────────────────────

export type EvidenceLevel =
  | 'issuer_anchored'
  | 'source_signed'
  | 'account_linked'
  | 'captured_url'
  | 'ai_captured';

export const EVIDENCE_LEVEL_LABELS = {
  issuer_anchored: 'Issuer Anchored',
  source_signed: 'Source Signed',
  account_linked: 'Account Linked',
  captured_url: 'Captured URL Evidence',
  ai_captured: 'AI-Captured Evidence',
} as const satisfies Record<EvidenceLevel, string>;

export const EVIDENCE_LEVEL_DESCRIPTIONS = {
  issuer_anchored: 'Verified directly with the issuing organization. The record was cryptographically anchored by the original issuer.',
  source_signed: 'The document source provided a cryptographic signature proving origin and integrity.',
  account_linked: 'Imported from a connected account. Proves the holder had access to that account — the originating organization did not vouch for this record.',
  captured_url: 'Captured from a public URL. The content was fetched and fingerprinted at the recorded time.',
  ai_captured: 'Extracted using AI from an uploaded document. Content was parsed and structured automatically.',
} as const satisfies Record<EvidenceLevel, string>;

// =============================================================================
// FINGERPRINT SOURCE (R19, CTO ruling 2026-07-28, advances SCRUM-2481)
// =============================================================================
// Distinguishes DOCUMENT-derived fingerprints (a real file's bytes, hashed
// client-side per §1.6) from RECORD-derived fingerprints (an issuing
// organization's asserted row content, hashed with no source document
// supplied — src/lib/csvParser.ts buildRowCanonical). Orthogonal to
// EvidenceLevel above (that axis is about credential SOURCE IMPORT
// authentication; this axis is about what was hashed to make `fingerprint`).
// R-7 claims gate: `issuer_record_attestation` copy must NEVER imply document
// custody or document verification — it states only that the issuer's
// asserted record content was fingerprinted.

export type FingerprintSource = 'document_bytes' | 'issuer_record_attestation';

export const FINGERPRINT_SOURCE_LABEL_HEADING = 'Fingerprint Source';

export const FINGERPRINT_SOURCE_LABELS = {
  document_bytes: 'Document Fingerprint',
  issuer_record_attestation: 'Issuer-Attested Record',
} as const satisfies Record<FingerprintSource, string>;

export const FINGERPRINT_SOURCE_DESCRIPTIONS = {
  document_bytes: "A source document's fingerprint was generated on your device and secured. Arkova never received the document itself.",
  issuer_record_attestation: 'No source document was supplied. The issuing organization asserted this record’s content directly, and that content — not a document — was fingerprinted and secured.',
} as const satisfies Record<FingerprintSource, string>;

/** Measured / asserted / NOT-asserted triad per §1.5, for the public verify page. */
export const FINGERPRINT_SOURCE_TRIAD = {
  document_bytes: {
    measured: 'The fingerprint of the document bytes provided on your device.',
    asserted: 'That this exact document existed, unmodified, at the time it was secured.',
    notAsserted: 'Who authored the document or whether its contents are accurate.',
  },
  issuer_record_attestation: {
    measured: 'The fingerprint of the record content the issuing organization submitted.',
    asserted: 'That the issuing organization submitted this exact record content — no source document was provided to Arkova.',
    notAsserted: 'That a source document exists, was reviewed, or was fingerprinted. This record was never in document form.',
  },
} as const satisfies Record<FingerprintSource, { measured: string; asserted: string; notAsserted: string }>;

// =============================================================================
// CONNECTOR-SOURCED FINGERPRINT (BUG-2026-08-13-010, §1.5 / §1.6A)
// =============================================================================
// A connector-sourced anchor's fingerprint commits the exact file bytes Arkova
// retrieved from the connected source at the moment of retrieval. Source
// services may regenerate the file on every download (proven against a live
// source during the 2026-08 soak: four retrievals of the same unchanged
// document produced four different fingerprints), so a fresh download is NOT
// expected to reproduce the fingerprint. Two claims failure modes, both
// avoided on purpose (§1.5 / R-7):
//   - never read as "this record is weaker" — the exact retrieved file IS
//     permanently secured;
//   - never name a vendor — the marker that keys this copy is recorded
//     classification, not independently provable vendor provenance.
// Distinct from FINGERPRINT_SOURCE above (what was fingerprinted) — this axis
// is whether the source system can be expected to reproduce those bytes.

export const CONNECTOR_FINGERPRINT_LABELS = {
  /** Shown in the re-verify section of a connector-sourced record's detail view. */
  REVERIFY_NOTE:
    'This record was secured from a connected source. Its fingerprint matches the exact file as retrieved at securing time. Downloading the document from the source again may produce a file with a different fingerprint, because some services regenerate the file on every download — verify against the originally retrieved copy.',
  /** Appended to the re-verify mismatch alert for connector-sourced records. */
  REVERIFY_MISMATCH_HINT:
    'This document came from a connected source. Some services regenerate the file on every download, so a freshly downloaded copy can carry a different fingerprint even when nothing changed. A mismatch here is not, on its own, evidence the document was altered. To match this record, use the exact file as originally retrieved.',
} as const;

/** Measured / asserted / NOT-asserted triad per §1.5 for connector-sourced records. */
export const CONNECTOR_FINGERPRINT_TRIAD = {
  measured:
    'The fingerprint of the document bytes retrieved from the connected source at the time this record was secured.',
  asserted:
    'That this exact retrieved file existed, unmodified, at the time it was secured.',
  notAsserted:
    'That downloading the document from the source again will produce the same fingerprint. Some services regenerate the file on each download, so a new copy may not match even when its content is unchanged.',
} as const;

/** Row-import (CSV bulk upload) issuer-attestation acknowledgement step. */
export const RECORD_ATTESTATION_LABELS = {
  SECTION_TITLE: 'Issuer Attestation Required',
  BODY: 'Some rows in this file have no fingerprint column mapped, so Arkova will fingerprint the row content you provide instead of a source document. This creates an issuer-attested record, not a document fingerprint.',
  CHECKBOX_LABEL: 'I am the issuing authority for these records and confirm the information above is accurate.',
  ACKNOWLEDGEMENT_REQUIRED_ERROR: 'Please confirm the issuer attestation before processing records without a mapped fingerprint column.',
} as const;

// =============================================================================
// VERSION RESOLUTION (SCRUM-1126)
// =============================================================================

export const VERSION_RESOLUTION_LABELS = {
  PAGE_TITLE: 'Version Conflicts',
  PAGE_SUBTITLE: 'Review and resolve documents with multiple pending versions.',
  EMPTY: 'No version conflicts pending review.',
  LOADING: 'Loading version conflicts…',
  ERROR: 'Unable to load version conflicts. Please try again.',
  SIBLING_COUNT_LABEL: 'Versions',
  actions: {
    APPROVE: 'Select as canonical',
    SKIP: 'Skip',
  },
} as const;

// ---------------------------------------------------------------------------
// SCRUM-2082 CSI-04D — Issuer Partners admin page
// ---------------------------------------------------------------------------

export const ISSUER_PARTNERSHIP_LABELS = {
  PAGE_TITLE: 'Issuer Partners',
  PAGE_SUBTITLE:
    'Manage connections to issuing partners. Each partner sends Arkova the records they issue so we can secure them on your behalf.',
  EMPTY_TITLE: 'No issuer partners connected',
  EMPTY_BODY:
    'Connect Credly or Accredible to start importing records your organisation issues. Setup keys are provided by the issuer’s admin tools.',
  EMPTY_PRIMARY_CTA: 'Connect an issuer',
  TABLE_HEADER_ISSUER: 'Issuer',
  TABLE_HEADER_ACCOUNT: 'Account',
  TABLE_HEADER_CONNECTED_AT: 'Connected',
  TABLE_HEADER_LAST_SYNC: 'Last sync',
  TABLE_HEADER_CREDENTIALS: 'Records',
  TABLE_HEADER_ACTIONS: 'Actions',
  ROW_LAST_SYNC_NEVER: 'Never',
  ROW_CREDENTIAL_COUNT_PENDING: '—',
  ROW_REVOKED_BADGE: 'Disconnected',
  DISCONNECT_CTA: 'Disconnect',
  DISCONNECT_DIALOG_TITLE: 'Disconnect issuer partner?',
  DISCONNECT_DIALOG_BODY:
    'New records from this issuer will stop importing. Existing secured records stay verified.',
  DISCONNECT_DIALOG_CONFIRM: 'Yes, disconnect',
  DISCONNECT_DIALOG_CANCEL: 'Cancel',
  CONNECT_CTA: 'Connect issuer',
  CONNECT_DIALOG_TITLE: 'Connect an issuer partner',
  CONNECT_DIALOG_BODY:
    'Choose the issuer you want to connect and paste the keys from their developer console.',
  CONNECT_FIELD_PROVIDER: 'Issuer',
  CONNECT_FIELD_PROVIDER_HELP:
    'Each issuer uses a different key shape. Pick yours below.',
  CONNECT_FIELD_ACCOUNT_ID: 'Account identifier',
  CONNECT_FIELD_ACCOUNT_LABEL: 'Friendly name (optional)',
  CONNECT_FIELD_CLIENT_ID: 'Client ID (Credly)',
  CONNECT_FIELD_CLIENT_SECRET: 'Client secret (Credly)',
  CONNECT_FIELD_API_KEY: 'API key',
  CONNECT_FIELD_KEY_LABEL: 'Key label (optional)',
  CONNECT_SUBMIT: 'Connect',
  CONNECT_CANCEL: 'Cancel',
  CONNECT_SUCCESS: 'Issuer partner connected.',
  CONNECT_ERROR: 'Unable to connect this issuer. Check the keys and try again.',
  LOADING: 'Loading issuer partners…',
  ERROR_LOAD: 'Unable to load issuer partners. Please refresh.',
  ERROR_DISCONNECT: 'Unable to disconnect. Please try again.',
  PROVIDER_NAMES: {
    credly: 'Credly',
    accredible: 'Accredible',
    udemy: 'Udemy',
  } as const,
} as const;

// =============================================================================
// QUEUE / INSTANT-SECURE UX CONTRACT (QUEUE-01 / SCRUM-2347)
// =============================================================================
// Frozen, user-visible labels for the queue-first vs. instant-secure securing
// experience. Keys are the lowercase QueueLifecycleState / CreditDebitState /
// SecuringPath / QueueSurface union members from src/lib/queueContract.ts —
// the test asserts a 1:1 mapping, so adding a state without a label fails CI.
//
// Terminology (CLAUDE.md §1.3): no banned terms. "Secured" is the terminal
// success word (internal code-name "anchored"); "Anchor Receipt" is the receipt;
// "Fingerprint" is the document identifier; "credit" is the funding unit.

/** User-visible badge label for each canonical queue lifecycle state. */
export const QUEUE_LIFECYCLE_LABELS = {
  pending: 'Pending',
  queued: 'In Queue',
  processing: 'Securing',
  materialized: 'Awaiting Confirmation',
  anchored: 'Secured',
  failed: 'Needs Attention',
  skipped: 'Skipped',
} as const;

/** One-line, plain-language description shown next to each lifecycle state. */
export const QUEUE_LIFECYCLE_DESCRIPTIONS = {
  pending: 'Your document is being prepared. It has not used any credits yet.',
  queued: 'Your document is in the queue to be secured. Queueing is free — no credits are used.',
  processing: 'Your document is being secured now.',
  materialized: 'Your document has its network receipt and is awaiting final confirmation.',
  // SCRUM-2495 claims review (§1.5): fingerprint is permanently secured, not the document.
  anchored: "Your document's fingerprint is permanently secured and independently verifiable.",
  failed: 'We could not secure this document. You were not charged. You can try again.',
  skipped: 'This document was not secured — it was a duplicate or you cancelled. No credits were used.',
} as const;

/**
 * Credit-charge state copy, mapped 1:1 to the credit-ledger model
 * (debit_and_enqueue + nightly reconciler; refunds are append-only reversing
 * rows). Charge happens at securing, never at queueing.
 */
export const CREDIT_DEBIT_LABELS = {
  spent: 'Credit used',
  pending: 'Credit pending',
  refunded: 'Credit refunded',
} as const;

/** Optional helper text expanding each credit-charge state. */
export const CREDIT_DEBIT_DESCRIPTIONS = {
  spent: '1 credit was used to secure this document instantly.',
  pending: 'A credit is reserved for this document and will be confirmed shortly.',
  refunded: '1 credit was returned to your balance.',
} as const;

/**
 * Distinct page titles for the three "queue" surfaces. Carson's premortem
 * (SCRUM-2347): never ship two surfaces both titled "Review queue". These are
 * deliberately distinct so a self-serve user is never shown the org dedup queue.
 */
export const QUEUE_SURFACE_TITLES = {
  consumer_secure_queue: 'Pending Documents',
  org_duplicate_review: 'Duplicate Review',
  org_approvals: 'Approvals',
} as const;

/**
 * Consumer-facing secure-queue surface copy (the NEW individual-facing list of
 * documents waiting to be secured). Title is shared with
 * QUEUE_SURFACE_TITLES.consumer_secure_queue.
 */
export const SECURE_QUEUE_LABELS = {
  PAGE_TITLE: 'Pending Documents',
  PAGE_SUBTITLE: 'Documents waiting to be secured. Queueing is free — credits are only used when you secure instantly.',
  ADD_TO_QUEUE: 'Add to Queue',
  SECURE_INSTANTLY: 'Secure Instantly',
  EMPTY_TITLE: 'Nothing waiting',
  EMPTY_DESC: 'Documents you add to the queue will appear here until they are secured.',
  COST_PREVIEW: 'Uses 1 credit. You have {n} remaining this cycle.',
  INSUFFICIENT_CREDITS: 'Not enough credits. Add credits or add to the queue (free).',
  NOT_CHARGED_FAILURE: 'We couldn’t secure your document right now. You were not charged. Please try again or add it to the queue.',
  QUEUED_TOAST: 'Added to the queue. No credits used.',
  SECURED_TOAST: 'Your document has been secured.',
} as const;

// ─── SCRUM-2481 badge honesty (Lane 3) ───────────────────────────────────────
//
// Purely additive, collision-safe block. Does NOT edit BADGE_LABELS,
// EVIDENCE_LEVEL_LABELS, or EVIDENCE_LEVEL_DESCRIPTIONS in place — those objects
// are edited by the copy.ts-touching soaking PRs. This block is HELD to land
// AFTER those PRs merge; until then EvidenceLevelBadge.tsx and
// SourceProvenanceDisplay.tsx carry local-const fallbacks with identical copy,
// so swapping the components to import from here is a no-op behaviour change.
//
// HONESTY INVARIANT (§1.3 / §1.5 / SCRUM-2481): the three non-issuer tiers
// (account_linked / captured_url / ai_captured) must never compose the word
// "Verified", "Issuer", "Authenticated" — or any banned §1.3 term — into their
// alt text or triad. Enforced by EvidenceLevelBadge.test.tsx + npm run lint:copy.

/** Per-tier alt / aria-label. Non-issuer tiers carry NO issuer-family wording. */
export const EVIDENCE_LEVEL_BADGE_ALT = {
  issuer_anchored:
    'Issuer Anchored: authenticated directly by the issuing organization.',
  source_signed:
    'Source Signed: the document source cryptographically signed this record, proving issuer origin.',
  account_linked:
    'Account Linked: imported from a connected account. Proves account access only; the originating organization did not vouch for this record.',
  captured_url:
    'Captured URL Evidence: fetched from a public web page. Records what was captured, not who published it.',
  ai_captured:
    'AI-Captured Evidence: extracted by AI from an uploaded document. Content parsed automatically; source identity not established.',
} as const satisfies Record<EvidenceLevel, string>;

/** Row labels for the measured / asserted / NOT-asserted triad (§1.5). */
export const EVIDENCE_TRIAD_LABELS = {
  MEASURED: 'Measured',
  ASSERTED: 'Asserted',
  NOT_ASSERTED: 'Not asserted',
} as const;

/**
 * Per-tier measured / asserted / NOT-asserted triad (§1.5 honesty).
 * Every non-issuer tier lists "issuer identity" under `notAsserted`.
 */
export const EVIDENCE_TRIAD = {
  issuer_anchored: {
    measured: 'The document fingerprint and the time it was anchored.',
    asserted: 'Issuer identity — anchored directly by the issuing organization.',
    notAsserted: 'The real-world facts the document describes (e.g. skills held).',
  },
  source_signed: {
    measured: 'The document fingerprint and the source signature.',
    asserted: 'Issuer origin — a cryptographic signature proves the source.',
    notAsserted: 'The real-world facts the document describes.',
  },
  account_linked: {
    measured: 'The fingerprint of the record imported from the connected account.',
    asserted: 'That the holder had access to the linked account.',
    notAsserted: 'Issuer identity — the originating organization did not vouch for this record.',
  },
  captured_url: {
    measured: 'The fingerprint of the page content and the time it was captured.',
    asserted: 'What was present at the public URL when it was captured.',
    notAsserted: 'Issuer identity — who published the page is not verified.',
  },
  ai_captured: {
    measured: 'The fingerprint of the uploaded document and its AI-extracted fields.',
    asserted: 'The structured content an AI parsed from the document.',
    notAsserted: 'Issuer identity — the source of the document is not established.',
  },
} as const satisfies Record<EvidenceLevel, { measured: string; asserted: string; notAsserted: string }>;

// =============================================================================
// S3 Lane-3 CE strings (CE-06a / SCRUM-2377) — Credential Engine publication
// status. Claims-review gate (CLAUDE.md §1.13 R-7): Credential Engine approved
// Arkova TO PUBLISH only — no Registry listing exists. Any CE status copy
// MUST use "approved to publish" wording; never assert a listing or any
// external status we do not hold. Enforced by src/lib/copy-claims-gate.test.ts
// (which scans this ENTIRE file, comments included) and
// services/worker/src/ctdl/ctdl-claims-guard.ts (runtime, fail-closed).
// =============================================================================

export const CE_PUBLICATION_COPY = {
  /** The one safe status wording — states exactly what we hold, nothing more. */
  STATUS_APPROVED_TO_PUBLISH: 'Approved to publish',
  /** Longer status detail for settings/status surfaces. */
  STATUS_DETAIL:
    'Credential Engine has approved Arkova to publish credential data. This approval does not assert any further external status.',
  /** Shown while publication remains switched off (the standing default). */
  PUBLICATION_OFF: 'Publication is not enabled.',
} as const;

// =============================================================================
// S3 Lane-3 AI strings (AI-03 template review — SCRUM-2383)
// One contiguous block by agreement across the three S3 streams — append-only,
// do not interleave other streams' strings here.
// =============================================================================

/**
 * Template-review panel (AI-03 MVP): the review/correct step shown after
 * on-device extraction. Low-confidence fields are visually flagged and must be
 * confirmed or corrected before the user can proceed.
 */
export const TEMPLATE_REVIEW_LABELS = {
  TITLE: 'Review Extracted Details',
  SUBTITLE:
    'Check each detail before continuing. Fields the AI was less sure about are highlighted and need your confirmation.',
  LOW_CONFIDENCE_BADGE: 'Needs your review',
  ACKNOWLEDGE_LABEL: 'This is correct',
  ACKNOWLEDGED_LABEL: 'Confirmed',
  EDITED_BADGE: 'Corrected',
  EDIT: 'Edit',
  SAVE: 'Save',
  CANCEL: 'Cancel',
  REVIEW_REQUIRED_NOTICE: 'Confirm or correct the highlighted fields to continue.',
  ALL_REVIEWED_NOTICE: 'All details reviewed. You can continue.',
} as const;

// =============================================================================
// OPS SLO DASHBOARD (SCRUM-2401 / OPS-03) — internal-only, platform-admin gated
// =============================================================================

export const OPS_SLO_LABELS = {
  PAGE_TITLE: 'Platform SLOs',
  PAGE_DESCRIPTION: 'Live operational health across securing, queues, credits, and delivery.',
  ACCESS_RESTRICTED_TITLE: 'Access Restricted',
  ACCESS_RESTRICTED_DESC: 'Platform SLO monitoring is only available to platform administrators.',
  RETURN_TO_DASHBOARD: 'Return to Dashboard',
  REFRESH: 'Refresh',
  ALL_CLEAR_BADGE: 'All SLOs Healthy',
  BREACH_BADGE: 'SLO Breach',
  UNAVAILABLE: 'Unavailable',
  LAST_CHECKED: 'Last checked',

  ANCHOR_SECURED_RATE_TITLE: 'Anchor Secure Rate',
  ANCHOR_SECURED_RATE_SUBTITLE: (secured: string, total: string) => `${secured} of ${total} secured`,
  ANCHOR_SECURED_RATE_UNAVAILABLE: 'Secure-rate cache not yet populated.',

  CONNECTOR_QUEUE_TITLE: 'Connector Queue Depth',
  CONNECTOR_QUEUE_SUBTITLE: (anchored: string, failed: string) => `${anchored} secured · ${failed} failed`,
  CONNECTOR_QUEUE_UNAVAILABLE: 'Queue depth temporarily unavailable.',

  CREDIT_CONSERVATION_TITLE: 'Credit Ledger Conservation',
  CREDIT_CONSERVATION_HEALTHY: 'Conservation holds',
  CREDIT_CONSERVATION_BREACH: (n: number) => `${n} organization${n === 1 ? '' : 's'} diverged`,
  CREDIT_CONSERVATION_SUBTITLE: (checked: string) => `${checked} organizations checked`,
  CREDIT_CONSERVATION_UNAVAILABLE: 'Conservation check temporarily unavailable.',

  WEBHOOK_DELIVERY_TITLE: 'Delivery Success Rate',
  WEBHOOK_DELIVERY_SUBTITLE: (success: string, total: string, hours: number) =>
    `${success} of ${total} delivered (last ${hours}h)`,
  WEBHOOK_DELIVERY_UNAVAILABLE: 'Delivery stats temporarily unavailable.',

  API_ERRORS_TITLE: 'Verification Error Rate',
  API_ERRORS_SUBTITLE: (errors: string, total: string, hours: number) =>
    `${errors} of ${total} requests failed (last ${hours}h)`,
  API_ERRORS_UNAVAILABLE: 'Request stats temporarily unavailable.',

  NO_DATA_YET: 'No data yet',
  FETCH_ERROR_TITLE: 'Unable to load platform SLOs',
} as const;

/**
 * Folders (SCRUM-2940) — user- and org-scoped record organization.
 * §1.3: user-facing copy uses "folder" / "records" / "documents" only,
 * never banned crypto terms.
 */
export const FOLDER_LABELS = {
  NAV_TITLE: 'Folders',
  ALL_RECORDS: 'All Records',
  UNFILED: 'Unfiled',
  NEW_FOLDER: 'New Folder',
  CREATE_TITLE: 'Create Folder',
  RENAME_TITLE: 'Rename Folder',
  DELETE_TITLE: 'Delete Folder',
  NAME_LABEL: 'Folder name',
  NAME_PLACEHOLDER: 'e.g. Invoices, Certificates',
  ASSIGN_TITLE: 'Move to Folder',
  ASSIGN_TRIGGER: 'Move to folder',
  REMOVE_FROM_FOLDER: 'Remove from folder',
  SAVE: 'Save',
  CANCEL: 'Cancel',
  CREATE: 'Create',
  DELETE_CONFIRM: (name: string) =>
    `Delete the folder "${name}"? Records inside it move to Unfiled — they are not deleted.`,
  EMPTY_TITLE: 'No folders yet',
  EMPTY_BODY: 'Create a folder to organize your records for easier browsing.',
  FOLDER_EMPTY: 'No records in this folder yet.',
  ERR_DUPLICATE_NAME: 'A folder with that name already exists.',
  ERR_CREATE: 'Could not create the folder. Please try again.',
  ERR_RENAME: 'Could not rename the folder. Please try again.',
  ERR_DELETE: 'Could not delete the folder. Please try again.',
  ERR_ASSIGN: 'Could not move the record. Please try again.',
  TOAST_CREATED: 'Folder created',
  TOAST_RENAMED: 'Folder renamed',
  TOAST_DELETED: 'Folder deleted',
  TOAST_ASSIGNED: 'Record moved',
  TOAST_UNFILED: 'Record removed from folder',
} as const;

/**
 * Spreadsheet dual-mode (W2 / F1, founder ruling 2026-07-28).
 * A dropped .csv/.xlsx/.xls/.tsv file is ambiguous: it could be a list of
 * individual records to import (the original bulk-issuance intent), or a
 * single non-credential spreadsheet the user wants secured as one document.
 * This copy backs the explicit choice shown between drop and dispatch —
 * neither mode is inferred silently. §1.3: no banned crypto/chain terms.
 */
export const SPREADSHEET_MODE_LABELS = {
  TITLE: 'How should this file be secured?',
  DESCRIPTION: 'Spreadsheets can go two ways — pick the one that matches this file.',
  RECORDS_OPTION: 'Import as a list of records',
  RECORDS_HINT: 'Each row becomes its own secured record. Use this for rosters, batches of documents, and similar lists.',
  DOCUMENT_OPTION: 'Secure this file as a document',
  DOCUMENT_HINT: 'The whole file is secured as a single record, the same as a PDF or Word document.',
  FILE_SIZE_LABEL: 'Size',
  CHOOSE_DIFFERENT_FILE: 'Choose a different file',
} as const;

// ─── QUEUE-01 / SCRUM-2894 (L2-A1) — Pending Documents page ─────────────────
//
// Append-only block (per CLAUDE.md §6 "Two PRs each appending..." guidance —
// titled distinctly, added at EOF to avoid colliding with the concurrent
// terminology-scrub / copy.ts PRs this sprint). Extends the existing
// SECURE_QUEUE_LABELS / SECURING_CHOICE_LABELS / SECURING_CHOICE_HINTS
// (defined above, ~line 3420) rather than duplicating them. §1.3-clean: no
// Wallet / Transaction / Hash / Blockchain / Bitcoin / Testnet / Mainnet /
// UTXO / Broadcast.

/** The consumer secure-queue page (/queue) — list + remove own items. */
export const SECURE_QUEUE_PAGE_LABELS = {
  BATCH_EXPLAINER: 'Queued documents are secured automatically once a day. No action needed — add more anytime.',
  REMOVE_BUTTON_ARIA: 'Remove from queue',
  REMOVE_CONFIRM_TITLE: 'Remove from queue?',
  REMOVE_CONFIRM_BODY: 'This document will not be secured. You can add it again later.',
  REMOVE_ACTION: 'Remove',
  REMOVE_TOAST: 'Removed from the queue.',
  REMOVE_FAILED: 'Could not remove this item. It may have already been secured or removed.',
  PERSONAL_TAB_LABEL: 'My Queue',
  ORG_TAB_LABEL: 'Organization Queue',
  ORG_QUEUE_SUBTITLE: "Documents your organization's members have queued.",
  OWNER_LABEL: 'Added by',
  ADMIN_REMOVE_UNAVAILABLE: "Removing another member's queued document isn't available yet.",
} as const;
