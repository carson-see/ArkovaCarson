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

/** Strip any trailing slashes. Non-regex form avoids SonarCloud S5852. */
function stripTrailingSlashes(s: string): string {
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * Normalized frontend base URL — trailing slash stripped once at module load.
 * config.frontendUrl is immutable after startup, so this does not need to be
 * recomputed on every URL build.
 */
const BASE = stripTrailingSlashes(config.frontendUrl);

/** Public verification page for an anchor, keyed by its `public_id`. */
export function buildVerifyUrl(publicId: string): string {
  return `${BASE}/verify/${publicId}`;
}

/** Public verification page for an attestation (separate route from anchor verify). */
export function buildAttestationVerifyUrl(publicId: string): string {
  return `${BASE}/verify/attestation/${publicId}`;
}

/** Public verification page for a digital signature. */
export function buildSignatureVerifyUrl(publicId: string): string {
  return `${BASE}/verify/signature/${publicId}`;
}

/** Internal record page (uses the internal anchor UUID, not public_id). */
export function buildRecordUrl(anchorId: string): string {
  return `${BASE}/records/${anchorId}`;
}

/** Recipient activation link with activation token as query param. */
export function buildActivateUrl(token: string): string {
  return `${BASE}/activate?token=${encodeURIComponent(token)}`;
}

/** Stripe Checkout success redirect — `{CHECKOUT_SESSION_ID}` is a literal Stripe placeholder. */
export const BILLING_SUCCESS_URL = `${BASE}/billing/success?session_id={CHECKOUT_SESSION_ID}`;

/** Stripe Checkout cancel redirect. */
export const BILLING_CANCEL_URL = `${BASE}/billing/cancel`;

/** Stripe customer portal return URL. */
export const BILLING_PORTAL_RETURN_URL = `${BASE}/settings`;

/** Admin pipeline health dashboard (used in pipeline-health alert emails). */
export const PIPELINE_DASHBOARD_URL = `${BASE}/admin/pipeline`;
