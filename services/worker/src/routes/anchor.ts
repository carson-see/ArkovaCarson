/**
 * Anchor Routes
 *
 * Public anchor verification and recipient management.
 * Extracted from index.ts as part of ARCH-1 refactor.
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

export const anchorRouter = Router();

anchorRouter.use(corsMiddleware);

/**
 * POST /api/verify-anchor
 * Public anchor verification — accepts fingerprint hash, NOT files.
 * Constitution 1.6: Documents never leave the user's device.
 */
anchorRouter.post('/verify-anchor', rateLimiters.checkout, async (req, res) => {
  const { fingerprint } = req.body as { fingerprint?: string };

  if (!fingerprint) {
    res.status(400).json({ error: 'fingerprint is required (64-char hex SHA-256)' });
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
    res.status(500).json({ error: 'Verification failed' });
  }
});

/**
 * POST /api/recipients
 * Recipient management — BETA-04 (Auto-Create User on Admin Upload)
 */
anchorRouter.post('/recipients', rateLimiters.checkout, async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { email, orgId, fullName, credentialLabel } = req.body as {
    email?: string;
    orgId?: string;
    fullName?: string;
    credentialLabel?: string;
  };

  if (!email || !orgId) {
    res.status(400).json({ error: 'email and orgId are required' });
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
    res.status(500).json({ error: 'Failed to create recipient' });
  }
});

/**
 * DELETE /api/account
 * Account Deletion — GDPR Art. 17 Right to Erasure (PII-02)
 */
anchorRouter.delete('/account', rateLimiters.checkout, async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    await handleAccountDelete(userId, { db, logger }, req, res);
  } catch (error) {
    logger.error({ error }, 'Account deletion failed');
    res.status(500).json({ error: 'Account deletion failed' });
  }
});
