/**
 * Organization Verification API (IDT WS4)
 *
 * Endpoints for org EIN verification and domain verification:
 *   POST /api/v1/org/verify-ein          — Submit EIN for verification
 *   POST /api/v1/org/verify-domain       — Start domain verification (email-based)
 *   POST /api/v1/org/confirm-domain      — Confirm domain with verification token
 *   POST /api/v1/org/dev-verify          — Dev-only: auto-verify org for testing
 *   GET  /api/v1/org/verification-status — Get current verification status
 *
 * Constitution 1.4: EIN is L3 Confidential — never logged.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { db as _db } from '../../utils/db.js';
import { sendEmail } from '../../email/sender.js';
import { buildDomainVerificationEmail } from '../../email/templates.js';

// IDT WS4 columns (domain_verified, ein_tax_id, etc.) are in the DB via migration 0128
// but not yet in generated types. Use untyped client for org verification queries.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = _db as any;

export const orgVerificationRouter = Router();

const isDev = config.nodeEnv === 'development' || config.nodeEnv === 'test';

/** Helper to get userId from request */
function getUserId(req: Request): string | undefined {
  return (req as unknown as { userId?: string }).userId;
}

/** Helper to get user's org_id */
async function getUserOrgId(userId: string): Promise<string | null> {
  const { data } = await db
    .from('profiles')
    .select('org_id')
    .eq('id', userId)
    .single();
  return data?.org_id ?? null;
}

/**
 * POST /api/v1/org/verify-ein
 *
 * Submit EIN/Tax ID for organization verification.
 * Checks for duplicates. Sets verification to PENDING.
 */
orgVerificationRouter.post('/verify-ein', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const orgId = await getUserOrgId(userId);
    if (!orgId) {
      res.status(400).json({ error: 'You must belong to an organization' });
      return;
    }

    const { ein } = req.body as { ein?: string };
    if (!ein || ein.trim().length < 5) {
      res.status(400).json({ error: 'Valid EIN/Tax ID is required (minimum 5 characters)' });
      return;
    }

    const cleanEin = ein.trim();

    // Check for duplicate EIN
    const { data: existing } = await db
      .from('organizations')
      .select('id, display_name')
      .eq('ein_tax_id', cleanEin)
      .neq('id', orgId)
      .maybeSingle();

    if (existing) {
      res.status(409).json({
        error: 'This EIN/Tax ID is already registered to another organization',
      });
      return;
    }

    // Update org with EIN and set to PENDING verification
    const { error: updateError } = await db
      .from('organizations')
      .update({
        ein_tax_id: cleanEin,
        verification_status: 'PENDING',
      })
      .eq('id', orgId);

    if (updateError) {
      logger.error({ error: updateError }, 'Failed to update org EIN');
      res.status(500).json({ error: 'Failed to submit EIN' });
      return;
    }

    // Log audit event (never log the actual EIN)
    await db.from('audit_events').insert({
      actor_id: userId,
      event_type: 'ORG_EIN_SUBMITTED',
      event_category: 'ADMIN',
      target_type: 'organization',
      target_id: orgId,
      details: 'EIN/Tax ID submitted for verification',
    });

    logger.info({ orgId }, 'Organization EIN submitted for verification');

    res.json({ status: 'PENDING', message: 'EIN submitted. Complete domain verification to finish.' });
  } catch (error) {
    logger.error({ error }, 'Failed to verify org EIN');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/org/verify-domain
 *
 * Start domain verification via email. Generates a verification token
 * and sends it to admin@<domain> (or in dev mode, returns it directly).
 */
orgVerificationRouter.post('/verify-domain', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const orgId = await getUserOrgId(userId);
    if (!orgId) {
      res.status(400).json({ error: 'You must belong to an organization' });
      return;
    }

    // Get org domain
    const { data: org, error: orgError } = await db
      .from('organizations')
      .select('domain, domain_verified')
      .eq('id', orgId)
      .single();

    if (orgError || !org) {
      res.status(500).json({ error: 'Failed to fetch organization' });
      return;
    }

    if (!org.domain) {
      res.status(400).json({ error: 'Organization must have a domain set before verification' });
      return;
    }

    if (org.domain_verified) {
      res.status(400).json({ error: 'Domain already verified' });
      return;
    }

    // Generate verification token (6-digit code for email, plus full token for URL)
    const token = crypto.randomBytes(32).toString('hex');
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h expiry

    const { error: updateError } = await db
      .from('organizations')
      .update({
        domain_verification_token: `${code}:${token}`,
        domain_verification_token_expires_at: expiresAt,
      })
      .eq('id', orgId);

    if (updateError) {
      logger.error({ error: updateError }, 'Failed to set domain verification token');
      res.status(500).json({ error: 'Failed to start domain verification' });
      return;
    }

    logger.info({ orgId, domain: org.domain }, 'Domain verification started');

    // In dev mode, return the code directly (no email sending)
    if (isDev) {
      res.json({
        status: 'pending',
        message: `Verification code generated for ${org.domain}`,
        devCode: code, // Only returned in dev mode
        domain: org.domain,
      });
      return;
    }

    // Send verification email to admin@domain via Resend
    const recipientEmail = `admin@${org.domain}`;
    const { subject, html } = buildDomainVerificationEmail({
      domain: org.domain,
      verificationCode: code,
    });

    const emailResult = await sendEmail({
      to: recipientEmail,
      subject,
      html,
      emailType: 'domain_verification',
      actorId: userId,
      orgId,
    });

    if (!emailResult.success) {
      logger.warn({ error: emailResult.error, orgId, domain: org.domain }, 'Failed to send domain verification email');
    }

    res.json({
      status: 'pending',
      message: `Verification email sent to ${recipientEmail}. Check your inbox.`,
      domain: org.domain,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to start domain verification');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/org/confirm-domain
 *
 * Confirm domain verification with the 6-digit code.
 * On success, sets domain_verified = true and if EIN is also set, VERIFIED status.
 */
orgVerificationRouter.post('/confirm-domain', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const orgId = await getUserOrgId(userId);
    if (!orgId) {
      res.status(400).json({ error: 'You must belong to an organization' });
      return;
    }

    const { code } = req.body as { code?: string };
    if (!code || code.trim().length < 6) {
      res.status(400).json({ error: 'Verification code is required' });
      return;
    }

    const { data: org, error: orgError } = await db
      .from('organizations')
      .select('domain_verification_token, domain_verification_token_expires_at, ein_tax_id, domain_verified')
      .eq('id', orgId)
      .single();

    if (orgError || !org) {
      res.status(500).json({ error: 'Failed to fetch organization' });
      return;
    }

    if (org.domain_verified) {
      res.status(400).json({ error: 'Domain already verified' });
      return;
    }

    if (!org.domain_verification_token) {
      res.status(400).json({ error: 'No pending domain verification. Start verification first.' });
      return;
    }

    // Check expiry
    if (org.domain_verification_token_expires_at &&
        new Date(org.domain_verification_token_expires_at) < new Date()) {
      res.status(400).json({ error: 'Verification code has expired. Please start over.' });
      return;
    }

    // Verify code (stored as "code:token")
    const storedCode = org.domain_verification_token.split(':')[0];
    if (storedCode !== code.trim()) {
      res.status(400).json({ error: 'Invalid verification code' });
      return;
    }

    // Domain verified! Update org.
    // If EIN is also set, fully verify the org.
    const isFullyVerified = !!org.ein_tax_id;

    const { error: updateError } = await db
      .from('organizations')
      .update({
        domain_verified: true,
        domain_verification_method: 'email',
        domain_verified_at: new Date().toISOString(),
        domain_verification_token: null,
        domain_verification_token_expires_at: null,
        ...(isFullyVerified ? { verification_status: 'VERIFIED' } : {}),
      })
      .eq('id', orgId);

    if (updateError) {
      logger.error({ error: updateError }, 'Failed to confirm domain verification');
      res.status(500).json({ error: 'Failed to verify domain' });
      return;
    }

    await db.from('audit_events').insert({
      actor_id: userId,
      event_type: isFullyVerified ? 'ORG_VERIFIED' : 'ORG_DOMAIN_VERIFIED',
      event_category: 'ADMIN',
      target_type: 'organization',
      target_id: orgId,
      details: isFullyVerified
        ? 'Organization fully verified (EIN + domain)'
        : 'Organization domain verified via email',
    });

    logger.info({ orgId, fullyVerified: isFullyVerified }, 'Domain verification confirmed');

    res.json({
      domainVerified: true,
      verificationStatus: isFullyVerified ? 'VERIFIED' : 'PENDING',
      message: isFullyVerified
        ? 'Organization fully verified!'
        : 'Domain verified. Submit EIN/Tax ID to complete verification.',
    });
  } catch (error) {
    logger.error({ error }, 'Failed to confirm domain verification');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/org/dev-verify
 *
 * Dev-only: bypass all verification and set org to VERIFIED.
 */
orgVerificationRouter.post('/dev-verify', async (req: Request, res: Response) => {
  if (!isDev) {
    res.status(403).json({ error: 'Dev-verify is not available in production' });
    return;
  }

  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const orgId = await getUserOrgId(userId);
    if (!orgId) {
      res.status(400).json({ error: 'You must belong to an organization' });
      return;
    }

    const { error: updateError } = await db
      .from('organizations')
      .update({
        verification_status: 'VERIFIED',
        domain_verified: true,
        domain_verification_method: 'email',
        domain_verified_at: new Date().toISOString(),
        ein_tax_id: 'DEV-00-0000000',
      })
      .eq('id', orgId);

    if (updateError) {
      logger.error({ error: updateError }, 'Failed to dev-verify org');
      res.status(500).json({ error: 'Failed to verify organization' });
      return;
    }

    await db.from('audit_events').insert({
      actor_id: userId,
      event_type: 'ORG_VERIFIED',
      event_category: 'ADMIN',
      target_type: 'organization',
      target_id: orgId,
      details: 'Organization verified via dev bypass (testing only)',
    });

    logger.info({ orgId }, 'Organization dev-verified (testing bypass)');

    res.json({ status: 'VERIFIED', message: 'Organization verified (dev bypass)' });
  } catch (error) {
    logger.error({ error }, 'Failed to dev-verify org');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/org/verification-status
 *
 * Get current org verification status including domain and EIN.
 */
orgVerificationRouter.get('/verification-status', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const orgId = await getUserOrgId(userId);
    if (!orgId) {
      res.status(400).json({ error: 'You must belong to an organization' });
      return;
    }

    const { data: org, error } = await db
      .from('organizations')
      .select('verification_status, domain, domain_verified, domain_verification_method, domain_verified_at, ein_tax_id')
      .eq('id', orgId)
      .single();

    if (error || !org) {
      res.status(500).json({ error: 'Failed to fetch organization' });
      return;
    }

    res.json({
      verificationStatus: org.verification_status ?? 'UNVERIFIED',
      domain: org.domain,
      domainVerified: org.domain_verified ?? false,
      domainVerificationMethod: org.domain_verification_method,
      domainVerifiedAt: org.domain_verified_at,
      hasEin: !!org.ein_tax_id,
      // Never return the actual EIN value — L3 Confidential
    });
  } catch (error) {
    logger.error({ error }, 'Failed to fetch org verification status');
    res.status(500).json({ error: 'Internal server error' });
  }
});
