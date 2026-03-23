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
  PRIVACY: '/privacy',
  TERMS: '/terms',
  CONTACT: '/contact',
  EMBED_VERIFY: '/embed/verify/:publicId',
  SEARCH: '/search',
  ISSUER_REGISTRY: '/issuer/:orgId',
  DEVELOPERS: '/developers',
  CLE_API: '/cle',

  // OAuth callback (Supabase redirects here after Google OAuth)
  AUTH_CALLBACK: '/auth/callback',

  // Onboarding routes (auth required, pre-setup)
  ONBOARDING_ROLE: '/onboarding/role',
  ONBOARDING_ORG: '/onboarding/org',

  // Authenticated routes
  DOCUMENTS: '/documents',
  MY_CREDENTIALS: '/my-credentials',
  DASHBOARD: '/dashboard',
  RECORDS: '/records',
  RECORD_DETAIL: '/records/:id',
  ORGANIZATIONS: '/organizations',
  ORG_PROFILE: '/organizations/:orgId',
  ORG_MEMBERS: '/organizations/:orgId/members',
  ORG_RECORDS: '/organizations/:orgId/records',
  ORG_SETTINGS: '/organizations/:orgId/settings',
  ORGANIZATION: '/organization',
  MEMBER_DETAIL: '/organization/member/:memberId',
  SETTINGS: '/settings',
  SETTINGS_API_KEYS: '/settings/api-keys',
  SETTINGS_WEBHOOKS: '/settings/webhooks',
  CREDENTIAL_TEMPLATES: '/settings/credential-templates',
  HELP: '/help',
  REVIEW_PENDING: '/review-pending',

  // Attestations (Phase II)
  ATTESTATIONS: '/attestations',
  VERIFY_ATTESTATION: '/verify/attestation/:publicId',

  // AI Intelligence routes (P8 Phase II)
  REVIEW_QUEUE: '/organization/review-queue',
  AI_REPORTS: '/organization/ai-reports',

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

  // Billing routes
  BILLING: '/billing',
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
    case '/vault':
    case '/dashboard':
      return ROUTES.DASHBOARD;
  }
}

/** Destinations that indicate the user has completed onboarding */
export const MAIN_APP_DESTINATIONS: RouteDestination[] = ['/vault', '/dashboard'];

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

/** Build an org profile URL for a given org ID */
export function orgProfilePath(orgId: string): string {
  return `/organizations/${orgId}`;
}

/** Build an issuer registry URL for a given org ID */
export function issuerRegistryPath(orgId: string): string {
  return `/issuer/${orgId}`;
}

/** Production-safe base URL — prefers VITE_APP_URL, falls back to production domain */
export function getAppBaseUrl(): string {
  const rawBaseUrl = import.meta.env.VITE_APP_URL || 'https://app.arkova.ai';
  return rawBaseUrl.replace(/\/+$/, '');
}

/** Build a full verification URL for a given public ID */
export function verifyUrl(publicId: string): string {
  return `${getAppBaseUrl()}${verifyPath(publicId)}`;
}
