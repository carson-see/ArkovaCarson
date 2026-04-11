/**
 * Centralized URL builders (SCRUM-637)
 *
 * Dedupes the `${config.frontendUrl}/...` template literal pattern that was
 * sprinkled across ~20 production call sites (billing, attestations, verify,
 * GRC adapters, recipients, pipeline-health, etc.). A single source of truth
 * for user-facing URLs makes frontend route changes a one-line refactor and
 * eliminates drift between modules.
 *
 * Import as: `import { buildVerifyUrl } from '../lib/urls';`
 */

import { config } from '../config.js';

/** Remove trailing slash so builders can unconditionally prefix with `/`. */
function base(): string {
  return config.frontendUrl.replace(/\/+$/, '');
}

/**
 * Public verification page for an anchor, keyed by its `public_id`.
 *
 * Null/undefined are tolerated (coerced to '') to match the pre-existing
 * anchor-submit.ts pattern: `${config.frontendUrl}/verify/${existing.public_id ?? ''}`.
 */
export function buildVerifyUrl(publicId: string | null | undefined): string {
  return `${base()}/verify/${publicId ?? ''}`;
}

/** Public verification page for an attestation (separate route from anchor verify). */
export function buildAttestationVerifyUrl(publicId: string): string {
  return `${base()}/verify/attestation/${publicId}`;
}

/** Internal record page (uses the internal anchor UUID, not public_id). */
export function buildRecordUrl(anchorId: string): string {
  return `${base()}/records/${anchorId}`;
}

/** Recipient activation link with activation token as query param. */
export function buildActivateUrl(token: string): string {
  return `${base()}/activate?token=${encodeURIComponent(token)}`;
}

/** Stripe Checkout success redirect — `{CHECKOUT_SESSION_ID}` is a literal Stripe placeholder. */
export function buildBillingSuccessUrl(): string {
  return `${base()}/billing/success?session_id={CHECKOUT_SESSION_ID}`;
}

/** Stripe Checkout cancel redirect. */
export function buildBillingCancelUrl(): string {
  return `${base()}/billing/cancel`;
}

/** Stripe customer portal return URL. */
export function buildBillingPortalReturnUrl(): string {
  return `${base()}/settings`;
}

/** Admin pipeline health dashboard (used in pipeline-health alert emails). */
export function buildPipelineDashboardUrl(): string {
  return `${base()}/admin/pipeline`;
}
