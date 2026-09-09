/**
 * Named Route Constants
 *
 * Central definition of all application routes.
 * Used by App.tsx routing and navigation components.
 */

import type { RouteDestination } from '@/hooks/useProfile';

export const ROUTES = {
  // Public routes (no auth required)
  LOGIN: '/login',
  SIGNUP: '/signup',
  VERIFY: '/verify/:publicId',
  VERIFY_FORM: '/verify',
  VERIFY_MY_RECORD: '/my-records/verify',
  ABOUT: '/about',
  PRIVACY: '/privacy',
  TERMS: '/terms',
  THIRD_PARTY_NOTICES: '/legal/third-party-notices',
  CONTACT: '/contact',
  EMBED_VERIFY: '/embed/verify/:publicId',
  SEARCH: '/search',
  ISSUER_REGISTRY: '/issuer/:orgId',
  PUBLIC_PROFILE: '/profile/:profileId',
  DEVELOPERS: '/developers',
  API_SANDBOX: '/developers/sandbox',
  CLE_API: '/cle',
  ACTIVATE: '/activate',
  ACCEPT_INVITE: '/accept-invite',
  HOW_IT_WORKS: '/how-it-works',
  USE_CASES: '/use-cases',
  ENTERPRISE: '/enterprise',
  INDEPENDENT_VERIFY: '/verify/independent',
  DATA_RETENTION: '/privacy/data-retention',
  AUDITOR_BATCH: '/organization/auditor-batch',
  COMPLIANCE_TRENDS: '/organization/compliance-trends',
  COMPLIANCE_SCORECARD: '/compliance/scorecard',

  // OAuth callback (Supabase redirects here after Google OAuth)
  AUTH_CALLBACK: '/auth/callback',

  // Onboarding routes (auth required, pre-setup)
  ONBOARDING_ROLE: '/onboarding/role',
  ONBOARDING_ORG: '/onboarding/org',

  // Authenticated routes
  DOCUMENTS: '/documents',
  MY_CREDENTIALS: '/my-credentials',
  DASHBOARD: '/dashboard',
  VAULT_LEGACY: '/vault',
  RECORDS: '/records',
  RECORD_DETAIL: '/records/:id',
  ORGANIZATIONS: '/organizations',
  ORG_PROFILE: '/organizations/:orgId',
  ORGANIZATION: '/organization',
  MEMBER_DETAIL: '/organization/member/:memberId',
  PROFILE: '/profile',
  SETTINGS: '/settings',
  SETTINGS_API_KEYS: '/settings/api-keys',
  SETTINGS_WEBHOOKS: '/settings/webhooks',
  CREDENTIAL_TEMPLATES: '/settings/credential-templates',
  HELP: '/help',
  REVIEW_PENDING: '/review-pending',

  // Consumer secure queue (QUEUE-01 / SCRUM-2894 — L2-A1). The
  // `consumer_secure_queue` surface from queueContract.ts's QUEUE_SURFACES —
  // distinct from ANCHOR_QUEUE (org_duplicate_review) below.
  SECURE_QUEUE: '/queue',

  // Attestations (Phase II)
  ATTESTATIONS: '/attestations',
  VERIFY_ATTESTATION: '/verify/attestation/:publicId',

  // Credential Portfolios (ATT-05)
  PORTFOLIO: '/portfolio/:portfolioId',

  // AI Intelligence routes (P8 Phase II)
  REVIEW_QUEUE: '/organization/review-queue',
  AI_REPORTS: '/organization/ai-reports',

  // Compliance Intelligence
  COMPLIANCE_DASHBOARD: '/organization/compliance',

  // Rules Engine (ARK-108)
  RULES: '/organization/rules',
  RULE_BUILDER: '/organization/rules/new',

  // Admin Onboarding Wizard (UX-01 — SCRUM-1027)
  ADMIN_ONBOARDING: '/organization/onboarding',

  // Anchor Queue (UX-02 — SCRUM-1028): PENDING_RESOLUTION collision review
  ANCHOR_QUEUE: '/organization/queue',

  // Version Conflicts (SCRUM-1126): version-conflict resolution
  VERSION_CONFLICTS: '/organization/version-conflicts',

  // Phase III — Signatures & Compliance Center (PH3-ESIG)
  VERIFY_SIGNATURE: '/verify/signature/:signaturePublicId',
  SIGNATURE_COMPLIANCE: '/organization/signature-compliance',

  // Admin routes (internal ops)
  ADMIN_OVERVIEW: '/admin/overview',
  ADMIN_HEALTH: '/admin/health',
  ADMIN_TREASURY: '/admin/treasury',
  ADMIN_PIPELINE: '/admin/pipeline',
  ADMIN_PAYMENTS: '/admin/payments',
  ADMIN_USERS: '/admin/users',
  ADMIN_RECORDS: '/admin/records',
  ADMIN_SUBSCRIPTIONS: '/admin/subscriptions',
  ADMIN_ORGANIZATIONS: '/admin/organizations',
  ADMIN_USER_DETAIL: '/admin/users/:id',
  ADMIN_CONTROLS: '/admin/controls',
  // SCRUM-2082 / CSI-04D — Issuer Partners admin (Credly, Accredible, Udemy)
  ADMIN_ISSUER_PARTNERSHIPS: '/admin/issuer-partnerships',
  // SCRUM-2401 (OPS-03) — Platform SLO dashboard (queue depth, secure rate,
  // credit conservation, delivery success)
  ADMIN_OPS_SLO: '/admin/ops-slo',

  // Billing routes
  BILLING: '/billing',
  // Plan selection + Stripe Checkout entry point. DISTINCT from BILLING:
  // /billing is the read-only status summary, /pricing is the only surface that
  // can start a purchase (PricingPage → startCheckout → worker
  // POST /api/checkout/session). Every "Upgrade" CTA must target this route —
  // pointing them at BILLING dead-ends the buy path.
  PRICING: '/pricing',
  BILLING_SUCCESS: '/billing/success',
  BILLING_CANCEL: '/billing/cancel',

  // Root redirect
  HOME: '/',
} as const;

/** Map a RouteDestination from useProfile to an actual route path */
export function destinationToRoute(destination: RouteDestination): string {
  switch (destination) {
    case '/auth':
      return ROUTES.LOGIN;
    case '/onboarding/role':
      return ROUTES.ONBOARDING_ROLE;
    case '/onboarding/org':
      return ROUTES.ONBOARDING_ORG;
    case '/review-pending':
      return ROUTES.REVIEW_PENDING;
    case ROUTES.VAULT_LEGACY:
    case '/dashboard':
      return ROUTES.DASHBOARD;
  }
}

/** Destinations that indicate the user has completed onboarding */
export const MAIN_APP_DESTINATIONS: RouteDestination[] = [ROUTES.VAULT_LEGACY, ROUTES.DASHBOARD];

/** Build a verify URL for a given public ID */
export function verifyPath(publicId: string): string {
  return `/verify/${publicId}`;
}

/** Build a record detail URL for a given record ID */
export function recordDetailPath(id: string): string {
  return `/records/${id}`;
}

/** Build a member detail URL for a given member ID */
export function memberDetailPath(memberId: string): string {
  return `/organization/member/${memberId}`;
}

/** Build a public member profile URL for a public profile ID */
export function publicProfilePath(profileId: string): string {
  return `/profile/${profileId}`;
}

/** Build an org profile URL for a given org ID */
export function orgProfilePath(orgId: string): string {
  return `/organizations/${orgId}`;
}

/** Build an issuer registry URL for a given org ID */
export function issuerRegistryPath(orgId: string): string {
  return `/issuer/${orgId}`;
}

/**
 * The canonical, permanent origin for public verification links.
 *
 * NEVER env-driven. `getAppBaseUrl()` below is deliberately overridable via
 * `VITE_APP_URL` so in-app links follow whatever host the app is being served
 * from — right for a share sheet, wrong for anything archived. Artifacts that
 * outlive the build that produced them must use `canonicalVerifyUrl()`.
 */
export const CANONICAL_APP_ORIGIN = 'https://app.arkova.ai';

/** Production-safe base URL — prefers VITE_APP_URL, falls back to production domain */
export function getAppBaseUrl(): string {
  const rawBaseUrl = import.meta.env.VITE_APP_URL || CANONICAL_APP_ORIGIN;
  return rawBaseUrl.replace(/\/+$/, '');
}

/**
 * Build a full verification URL for a given public ID, honouring `VITE_APP_URL`.
 *
 * For LIVE UI only — a share sheet, a copy-link button, an on-screen QR — where
 * pointing at the host the user is already on is correct. Do NOT use it for
 * anything the user keeps: see `canonicalVerifyUrl()`.
 */
export function verifyUrl(publicId: string): string {
  return `${getAppBaseUrl()}${verifyPath(publicId)}`;
}

/**
 * Build a verification URL for an ARCHIVED artifact — a downloaded certificate,
 * an emailed proof, anything that outlives the build that produced it.
 *
 * Always the production origin, never `VITE_APP_URL`. `.env.example` ships
 * `VITE_APP_URL=http://localhost:5173`, and preview deploys set it to an
 * ephemeral host, so a build-time value baked into a permanent PDF resolves to
 * localhost or a dead preview host forever. The document cannot be reissued
 * once it has been handed to an auditor, so it gets the URL that will still
 * work — not the one this particular build happened to be served from.
 *
 * It reads no environment at all, which also keeps its callers runnable outside
 * a Vite transform (`import.meta.env` is undefined under plain `tsx`/node).
 */
export function canonicalVerifyUrl(publicId: string): string {
  return `${CANONICAL_APP_ORIGIN}${verifyPath(publicId)}`;
}
