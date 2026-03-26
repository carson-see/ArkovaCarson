/**
 * Identity Verification API (IDT WS1)
 *
 * Endpoints for Stripe Identity KYC verification:
 *   POST /api/v1/identity/session — Create a verification session
 *   GET  /api/v1/identity/status  — Get current verification status
 *
 * Constitution 1.4: Never expose Stripe session secrets or PII in logs.
 * Constitution 1.6: Document content never leaves user device — KYC is identity-only.
 */

import { Router, Request, Response } from 'express';
import { stripe } from '../../stripe/client.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { db } from '../../utils/db.js';

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
