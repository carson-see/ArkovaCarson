/**
 * Account Deletion Endpoint — GDPR Art. 17 Right to Erasure (PII-02)
 *
 * DELETE /api/account
 *
 * Authenticates the user via Supabase JWT, then:
 * 1. Calls anonymize_user_data() RPC to scrub PII from audit_events + ai_usage_events
 * 2. Soft-deletes the profile (sets deleted_at)
 * 3. Deletes the Supabase auth user (terminates all sessions)
 *
 * Constitution 1.4: Never log PII. Only log user ID.
 */

import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from '../utils/logger.js';
import { callRpc } from '../utils/rpc.js';

export interface AccountDeleteDeps {
  db: SupabaseClient;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export async function handleAccountDelete(
  userId: string,
  deps: AccountDeleteDeps,
  _req: Request,
  res: Response,
): Promise<void> {
  const { db, logger } = deps;

  try {
    // 1. Verify user exists and isn't already deleted
    const { data: profile, error: profileError } = await db
      .from('profiles')
      .select('id, deleted_at')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      logger.warn({ userId }, 'Account deletion requested for non-existent profile');
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    if (profile.deleted_at) {
      res.status(409).json({ error: 'Account already deleted' });
      return;
    }

    // 2. Anonymize PII in audit trail (GDPR Art. 17)
    const { error: anonymizeError } = await callRpc(
      db,
      'anonymize_user_data',
      { p_user_id: userId },
    );

    if (anonymizeError) {
      logger.error({ userId, error: anonymizeError }, 'Failed to anonymize user data');
      res.status(500).json({ error: 'Failed to process account deletion' });
      return;
    }

    // 3. Soft-delete profile
    const { error: deleteError } = await db
      .from('profiles')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', userId);

    if (deleteError) {
      logger.error({ userId, error: deleteError }, 'Failed to soft-delete profile');
      res.status(500).json({ error: 'Failed to process account deletion' });
      return;
    }

    // 4. Delete auth user (terminates all sessions)
    const { error: authDeleteError } = await db.auth.admin.deleteUser(userId);

    if (authDeleteError) {
      // Non-fatal: profile is already soft-deleted. Log and continue.
      logger.error({ userId, error: authDeleteError }, 'Failed to delete auth user (profile already soft-deleted)');
    }

    logger.info(
      { userId, success: true },
      'Account deleted successfully (GDPR Art. 17)',
    );

    res.json({
      success: true,
      message: 'Your account has been deleted and all personal data has been anonymized.',
    });
  } catch (error) {
    logger.error({ userId, error }, 'Account deletion failed unexpectedly');
    res.status(500).json({ error: 'Account deletion failed' });
  }
}
