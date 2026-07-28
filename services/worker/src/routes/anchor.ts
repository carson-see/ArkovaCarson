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
import { rateLimiters } from '../utils/rateLimit.js';
import { corsMiddleware, extractAuthUserId } from './middleware.js';
// DEBT-3: Static imports — circular dependency resolved by router extraction
import { verifyAnchorByFingerprint } from '../api/verify-anchor.js';
import { createPendingRecipient } from '../api/recipients.js';
import { handleAccountDelete } from '../api/account-delete.js';
import { handleAccountExport } from '../api/account-export.js';
import { sendEmail } from '../email/sender.js';
import { buildInvitationEmail } from '../email/templates.js';
import { isCallerOrgAdmin } from '../api/_org-auth.js';
import { buildInviteAcceptUrl } from '../lib/urls.js';
import {
  getInvitationPreview,
  acceptInvitation,
  InvitationError,
  type InvitationErrorCode,
} from '../api/invitations.js';

export const anchorRouter = Router();

anchorRouter.use(corsMiddleware);

/** DX-3: Standardized error response helper */
function sendError(res: import('express').Response, statusCode: number, code: string, message: string) {
  res.status(statusCode).json({ error: { code, message } });
}

/**
 * POST /api/verify-anchor
 * Public anchor verification — accepts fingerprint hash, NOT files.
 * Constitution 1.6: Documents never leave the user's device.
 */
anchorRouter.post('/verify-anchor', rateLimiters.checkout, async (req, res) => {
  const { fingerprint } = req.body as { fingerprint?: string };

  if (!fingerprint) {
    sendError(res, 400, 'invalid_request', 'fingerprint is required (64-char hex SHA-256)');
    return;
  }

  try {
    const lookup = {
      async lookupByFingerprint(fp: string) {
        const { data } = await db
          .from('anchors')
          .select('fingerprint, status, chain_tx_id, chain_block_height, chain_timestamp, public_id, created_at, credential_type')
          .eq('fingerprint', fp)
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!data) return null;

        return {
          fingerprint: data.fingerprint,
          status: data.status,
          chain_tx_id: data.chain_tx_id,
          chain_block_height: data.chain_block_height,
          chain_block_timestamp: data.chain_timestamp,
          public_id: data.public_id,
          created_at: data.created_at,
          credential_type: data.credential_type,
        };
      },
    };

    const result = await verifyAnchorByFingerprint(fingerprint, lookup);
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Anchor verification failed');
    sendError(res, 500, 'verification_failed', 'Verification failed');
  }
});

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
 *
 * SCRUM-3012: `invitationId` (the uuid the `invite_member` RPC returns) is now
 * REQUIRED. It is used to look up the invitation's real `token` so the emailed
 * link can carry it (`/accept-invite?token=...`) — previously the link was
 * built as `/login?invite=true&org=...`, dropping the token entirely, so
 * nothing could ever accept the invitation. The lookup also double-checks the
 * invitation's own `org_id`/`email` match the request (defense in depth on
 * top of the `isCallerOrgAdmin` gate below).
 */
anchorRouter.post('/send-invitation-email', rateLimiters.checkout, async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) {
    sendError(res, 401, 'authentication_required', 'Authentication required');
    return;
  }

  const { email, orgId, orgName, role, inviterName, invitationId } = req.body as {
    email?: string;
    orgId?: string;
    orgName?: string;
    role?: string;
    inviterName?: string;
    invitationId?: string;
  };

  if (!email || !orgId || !orgName || !invitationId) {
    sendError(res, 400, 'invalid_request', 'email, orgId, orgName, and invitationId are required');
    return;
  }

  try {
    if (!(await isCallerOrgAdmin(userId, orgId))) {
      sendError(res, 403, 'forbidden', 'Only organization admins can send invitation emails');
      return;
    }

    const { data: invitation, error: invitationError } = await db
      .from('invitations')
      .select('token, org_id, email')
      .eq('id', invitationId)
      .maybeSingle();

    if (invitationError) {
      logger.error({ error: invitationError, invitationId }, 'Invitation lookup failed');
      sendError(res, 500, 'internal_error', 'Failed to look up invitation');
      return;
    }
    if (
      !invitation?.token ||
      invitation.org_id !== orgId ||
      invitation.email.toLowerCase() !== email.toLowerCase()
    ) {
      sendError(res, 404, 'invitation_not_found', 'Invitation not found');
      return;
    }

    const inviteUrl = buildInviteAcceptUrl(invitation.token);

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

    // SCRUM-3012: honest response — no fake success. `result.success` already
    // reflects the real Resend outcome (sender.ts no longer reports a
    // production RESEND_API_KEY gap as a success either), so this is a
    // straight pass-through, not a new claim.
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

/** SCRUM-3012: InvitationError.code -> HTTP status for the accept/preview routes. */
const INVITATION_ERROR_STATUS: Record<InvitationErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  expired: 410,
  already_used: 410,
  email_mismatch: 403,
  account_exists: 409,
  internal_error: 500,
};

const invitationDeps = { db, logger };

/**
 * GET /api/invitations/:token
 * Public preview for the /accept-invite page — org name + validity, no auth.
 * Rate-limited like other unauthenticated auth-adjacent routes.
 */
anchorRouter.get('/invitations/:token', rateLimiters.auth, async (req, res) => {
  try {
    const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
    const preview = await getInvitationPreview(invitationDeps, token ?? '');
    res.json(preview);
  } catch (error) {
    if (error instanceof InvitationError) {
      sendError(res, INVITATION_ERROR_STATUS[error.code], error.code, error.message);
      return;
    }
    logger.error({ error }, 'Invitation preview failed');
    sendError(res, 500, 'internal_error', 'Failed to load invitation');
  }
});

/**
 * POST /api/invitations/accept
 * Provisions the invited membership — creates the auth account when the
 * caller has no session (new invitee), or joins the org directly when the
 * caller is already authenticated and owns the invited address.
 * Auth is OPTIONAL here by design: an unauthenticated caller with a valid
 * password creates a brand-new account; see invitations.ts for the full
 * decision tree.
 */
anchorRouter.post('/invitations/accept', rateLimiters.auth, async (req, res) => {
  const callerId = await extractAuthUserId(req);

  const { token, password, fullName } = req.body as {
    token?: string;
    password?: string;
    fullName?: string;
  };

  if (!token) {
    sendError(res, 400, 'invalid_request', 'token is required');
    return;
  }

  try {
    const result = await acceptInvitation(invitationDeps, { token, password, fullName, callerId });
    res.json({
      success: true,
      orgId: result.orgId,
      orgName: result.orgName,
      verificationRequired: result.verificationRequired,
      verificationEmailSent: result.verificationEmailSent,
    });
  } catch (error) {
    if (error instanceof InvitationError) {
      sendError(res, INVITATION_ERROR_STATUS[error.code], error.code, error.message);
      return;
    }
    logger.error({ error }, 'Invitation accept failed');
    sendError(res, 500, 'internal_error', 'Failed to accept invitation');
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
