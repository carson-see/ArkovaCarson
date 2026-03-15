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

  // Onboarding routes (auth required, pre-setup)
  ONBOARDING_ROLE: '/onboarding/role',
  ONBOARDING_ORG: '/onboarding/org',

  // Authenticated routes
  MY_CREDENTIALS: '/my-credentials',
  DASHBOARD: '/dashboard',
  RECORDS: '/records',
  RECORD_DETAIL: '/records/:id',
  ORGANIZATION: '/organization',
  SETTINGS: '/settings',
  SETTINGS_API_KEYS: '/settings/api-keys',
  SETTINGS_WEBHOOKS: '/settings/webhooks',
  CREDENTIAL_TEMPLATES: '/settings/credential-templates',
  HELP: '/help',
  REVIEW_PENDING: '/review-pending',

  // Admin routes (internal ops)
  ADMIN_TREASURY: '/admin/treasury',

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

/** Build an issuer registry URL for a given org ID */
export function issuerRegistryPath(orgId: string): string {
  return `/issuer/${orgId}`;
}
