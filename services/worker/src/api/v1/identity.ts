/**
 * Identity Verification API (IDT WS1)
 *
 * Endpoints for Stripe Identity KYC verification:
 *   POST /api/v1/identity/session    — Create a verification session
 *   GET  /api/v1/identity/status     — Get current verification status
 *   POST /api/v1/identity/dev-verify — Dev-only: bypass KYC for testing
 *
 * Constitution 1.4: Never expose Stripe session secrets or PII in logs.
 * Constitution 1.6: Document content never leaves user device — KYC is identity-only.
 */

import { Router, Request, Response } from 'express';
import { stripe } from '../../stripe/client.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { db } from '../../utils/db.js';

const isDev = config.nodeEnv === 'development' || config.nodeEnv === 'test';

export const identityRouter = Router();

/**
 * POST /api/v1/identity/session
 *
 * Creates a Stripe Identity VerificationSession for the authenticated user.
 * Returns the client_secret for the frontend to mount the Stripe Identity modal.
 */
identityRouter.post('/session', async (req: Request, res: Response) => {
  try {
    const userId = (req as unknown as { userId?: string }).userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Check if user already has a pending or verified session
    const { data: profile, error: profileError } = await db
      .from('profiles')
      .select('identity_verification_status, identity_verification_session_id')
      .eq('id', userId)
      .single();

    if (profileError) {
      logger.error({ error: profileError }, 'Failed to fetch profile for identity verification');
      res.status(500).json({ error: 'Failed to fetch profile' });
      return;
    }

    if (profile.identity_verification_status === 'verified') {
      res.status(400).json({ error: 'Identity already verified' });
      return;
    }

    // If there's a pending session, retrieve it instead of creating a new one
    if (profile.identity_verification_status === 'pending' && profile.identity_verification_session_id) {
      try {
        const existingSession = await stripe.identity.verificationSessions.retrieve(
          profile.identity_verification_session_id,
        );

        if (existingSession.status === 'requires_input') {
          // Session still active — return its client secret
          res.json({
            sessionId: existingSession.id,
            clientSecret: existingSession.client_secret,
            status: existingSession.status,
          });
          return;
        }
        // Otherwise fall through to create a new session
      } catch {
        // Session expired or invalid — create a new one
        logger.info('Previous identity session expired, creating new one');
      }
    }

    // Create a new Stripe Identity VerificationSession
    const session = await stripe.identity.verificationSessions.create({
      type: 'document',
      metadata: {
        user_id: userId,
      },
      options: {
        document: {
          require_matching_selfie: true,
        },
      },
    });

    // Update profile with the new session ID
    const { error: updateError } = await db
      .from('profiles')
      .update({
        identity_verification_session_id: session.id,
        identity_verification_status: 'pending',
      })
      .eq('id', userId);

    if (updateError) {
      logger.error({ error: updateError }, 'Failed to update profile with verification session');
      // Don't fail — the session was created, user can still proceed
    }

    logger.info({ userId, sessionStatus: session.status }, 'Identity verification session created');

    res.json({
      sessionId: session.id,
      clientSecret: session.client_secret,
      status: session.status,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to create identity verification session');
    res.status(500).json({ error: 'Failed to create verification session' });
  }
});

/**
 * GET /api/v1/identity/status
 *
 * Returns the current identity verification status for the authenticated user.
 */
identityRouter.get('/status', async (req: Request, res: Response) => {
  try {
    const userId = (req as unknown as { userId?: string }).userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { data: profile, error } = await db
      .from('profiles')
      .select('identity_verification_status, identity_verified_at')
      .eq('id', userId)
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to fetch verification status' });
      return;
    }

    res.json({
      status: profile.identity_verification_status ?? 'unstarted',
      verifiedAt: profile.identity_verified_at ?? null,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to fetch identity verification status');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/identity/dev-verify
 *
 * Development/testing only: bypass Stripe Identity and auto-verify the user.
 * Blocked in production. Uses service_role to update verification fields.
 */
identityRouter.post('/dev-verify', async (req: Request, res: Response) => {
  if (!isDev) {
    res.status(403).json({ error: 'Dev-verify is not available in production' });
    return;
  }

  try {
    const userId = (req as unknown as { userId?: string }).userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { data: profile, error: profileError } = await db
      .from('profiles')
      .select('identity_verification_status')
      .eq('id', userId)
      .single();

    if (profileError) {
      res.status(500).json({ error: 'Failed to fetch profile' });
      return;
    }

    if (profile.identity_verification_status === 'verified') {
      res.status(400).json({ error: 'Identity already verified' });
      return;
    }

    // Bypass KYC via SECURITY DEFINER RPC (bypasses trigger)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: rpcError } = await (db.rpc as any)('dev_bypass_kyc', { p_user_id: userId });

    if (rpcError) {
      logger.error({ error: rpcError }, 'Failed to dev-verify user');
      res.status(500).json({ error: 'Failed to verify identity' });
      return;
    }

    // Log audit event
    await db.from('audit_events').insert({
      actor_id: userId,
      event_type: 'IDENTITY_VERIFIED',
      event_category: 'ADMIN',
      details: 'Identity verified via dev bypass (testing only)',
    });

    logger.info({ userId }, 'Identity dev-verified (testing bypass)');

    res.json({
      status: 'verified',
      verifiedAt: new Date().toISOString(),
      provider: 'dev_bypass',
    });
  } catch (error) {
    logger.error({ error }, 'Failed to dev-verify identity');
    res.status(500).json({ error: 'Internal server error' });
  }
});
