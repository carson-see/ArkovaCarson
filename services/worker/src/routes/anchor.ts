/**
 * Anchor Routes
 *
 * Public anchor verification and recipient management.
 * Extracted from index.ts as part of ARCH-1 refactor.
 *
 * DX-3: Consistent error format: { error: { code, message } }
 */

import { Router } from 'express';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { rateLimiters } from '../utils/rateLimit.js';
import { corsMiddleware, extractAuthUserId } from './middleware.js';
// DEBT-3: Static imports — circular dependency resolved by router extraction
import { createPendingRecipient } from '../api/recipients.js';
import { handleAccountDelete } from '../api/account-delete.js';
import { handleAccountExport } from '../api/account-export.js';
import { sendEmail } from '../email/sender.js';
import { buildInvitationEmail } from '../email/templates.js';
import { isCallerOrgAdmin } from '../api/_org-auth.js';

export const anchorRouter = Router();

anchorRouter.use(corsMiddleware);

/** DX-3: Standardized error response helper */
function sendError(res: import('express').Response, statusCode: number, code: string, message: string) {
  res.status(statusCode).json({ error: { code, message } });
}

// ─── REMOVED: POST /api/verify-anchor ────────────────────────────────────────
//
// DO NOT RE-ADD THIS ROUTE. It was an unauthenticated fingerprint oracle.
//
// Added 2026-03-14 (`1ca06c122`) and mounted at `app.use('/api', anchorRouter)`
// with no auth middleware, it queried `anchors` through the **service_role**
// client (RLS bypassed) filtering only on `deleted_at IS NULL` — no status
// filter. Live at `https://app.arkova.ai/api/verify-anchor` via the
// `vercel.json` `/api/:path*` rewrite, and advertised as a no-auth endpoint in
// `public/llms.txt`.
//
// A hit returned `status` (PENDING / SUBMITTED / SUPERSEDED / EXPIRED /
// REVOKED anchors all disclosed, none of which we deliberately publish),
// `anchor_timestamp`, `network_receipt_id`, `credential_type`, and
// `record_uri` — the `public_id` **capability** the owner chose to share. A
// miss returned a bare `{ verified: false }`, so hit and miss were trivially
// distinguishable on an indexed, non-timing-out lookup. That converted mere
// possession of a fingerprint into the shareable record link, and thence into
// whatever `get_public_anchor` serves.
//
// It also bypassed `get_public_anchor_by_fingerprint` entirely, so the
// SQL-side SECURED-only hardening (migration 0386) did not cover it.
//
// It had ZERO first-party consumers: the public verify form queries Supabase
// directly (`src/components/verify/VerificationForm.tsx`), the edge MCP
// `verify_document` tool calls the `get_public_anchor_by_fingerprint` RPC, and
// the SDKs use `/api/v1/verify/:publicId` + `/api/v2/*`.
//
// Fingerprint verification is served by the authenticated, scope-gated
// surfaces: `GET /api/v2/verify/:fingerprint` and
// `GET /api/v2/fingerprints/:fingerprint` (`read:records`). `public_id`-keyed
// public verification remains at `GET /api/v1/verify/:publicId`.
//
// Regression cover: `anchor-verify-fingerprint-oracle.test.ts`.

/**
 * POST /api/recipients
 * Recipient management — BETA-04 (Auto-Create User on Admin Upload)
 */
anchorRouter.post('/recipients', rateLimiters.checkout, async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) {
    sendError(res, 401, 'authentication_required', 'Authentication required');
    return;
  }

  const { email, orgId, fullName, credentialLabel } = req.body as {
    email?: string;
    orgId?: string;
    fullName?: string;
    credentialLabel?: string;
  };

  if (!email || !orgId) {
    sendError(res, 400, 'invalid_request', 'email and orgId are required');
    return;
  }

  try {
    const result = await createPendingRecipient({
      email,
      orgId,
      fullName,
      credentialLabel,
      actorId: userId,
    });
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Recipient creation failed');
    sendError(res, 500, 'internal_error', 'Failed to create recipient');
  }
});

/**
 * POST /api/send-invitation-email
 * Sends an invitation email to a newly invited org member.
 * Called by frontend after invite_member RPC succeeds.
 * Requires authenticated org admin.
 */
anchorRouter.post('/send-invitation-email', rateLimiters.checkout, async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) {
    sendError(res, 401, 'authentication_required', 'Authentication required');
    return;
  }

  const { email, orgId, orgName, role, inviterName } = req.body as {
    email?: string;
    orgId?: string;
    orgName?: string;
    role?: string;
    inviterName?: string;
  };

  if (!email || !orgId || !orgName) {
    sendError(res, 400, 'invalid_request', 'email, orgId, and orgName are required');
    return;
  }

  try {
    if (!(await isCallerOrgAdmin(userId, orgId))) {
      sendError(res, 403, 'forbidden', 'Only organization admins can send invitation emails');
      return;
    }

    // Build the invite URL — links to the app's signup/login page with invitation context
    const frontendUrl = config.frontendUrl;
    const inviteUrl = `${frontendUrl}/login?invite=true&org=${encodeURIComponent(orgId)}`;

    const { subject, html } = buildInvitationEmail({
      recipientEmail: email,
      organizationName: orgName,
      inviterName,
      role: role ?? 'INDIVIDUAL',
      inviteUrl,
    });

    const result = await sendEmail({
      to: email,
      subject,
      html,
      emailType: 'invitation',
      actorId: userId,
      orgId,
    });

    if (result.success) {
      res.json({ sent: true, messageId: result.messageId });
    } else {
      sendError(res, 500, 'email_failed', result.error ?? 'Failed to send invitation email');
    }
  } catch (error) {
    logger.error({ error }, 'Invitation email send failed');
    sendError(res, 500, 'internal_error', 'Failed to send invitation email');
  }
});

/**
 * DELETE /api/account
 * Account Deletion — GDPR Art. 17 Right to Erasure (PII-02)
 */
anchorRouter.delete('/account', rateLimiters.checkout, async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) {
    sendError(res, 401, 'authentication_required', 'Authentication required');
    return;
  }

  try {
    await handleAccountDelete(userId, { db, logger }, req, res);
  } catch (error) {
    logger.error({ error }, 'Account deletion failed');
    sendError(res, 500, 'internal_error', 'Account deletion failed');
  }
});

/**
 * GET /api/account/export
 * Data Subject Rights — Access + Portability (REG-11 / SCRUM-572)
 * GDPR Art. 15 + Art. 20, Kenya DPA s. 31, Australia APP 12, POPIA s. 23, NDPA.
 * Rate-limited to 1 export per 24h at the DB layer via can_export_user_data().
 */
anchorRouter.get('/account/export', rateLimiters.checkout, async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) {
    sendError(res, 401, 'authentication_required', 'Authentication required');
    return;
  }

  try {
    await handleAccountExport(userId, { db, logger }, req, res);
  } catch (error) {
    logger.error({ error }, 'Data export failed');
    sendError(res, 500, 'internal_error', 'Data export failed');
  }
});
