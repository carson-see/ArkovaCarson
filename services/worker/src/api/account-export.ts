/**
 * Data Export Endpoint — GDPR Art. 15 (access) + Art. 20 (portability) (REG-11)
 *
 * GET /api/account/export
 *
 * Authenticates the user via Supabase JWT, then:
 * 1. Checks the 24h rate limit via `can_export_user_data` RPC
 * 2. Records a `data_subject_requests` row with type=export, status=processing
 *    (required audit record under GDPR Art. 30 + Kenya DPA Part VI)
 * 3. Gathers all user-scoped data: profile, user's anchors, user's audit events
 * 4. Marks the request row completed
 * 5. Returns a JSON blob with Content-Disposition: attachment so browsers
 *    download it as a file
 *
 * Constitution 1.4: never log email or full_name. Only log user id + row counts.
 */

import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from '../utils/logger.js';

export interface AccountExportDeps {
  db: SupabaseClient;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}

/** Shape of the JSON export returned to the subject. */
interface ExportPayload {
  schema: 'arkova.data-export.v1';
  generated_at: string;
  request: {
    id: string;
    type: 'export';
    legal_basis: string;
  };
  subject: {
    profile: Record<string, unknown>;
  };
  data: {
    anchors: unknown[];
    audit_events: unknown[];
  };
}

export async function handleAccountExport(
  userId: string,
  deps: AccountExportDeps,
  _req: Request,
  res: Response,
): Promise<void> {
  const { db, logger } = deps;

  try {
    // 1. Load profile (also confirms account exists / isn't tombstoned)
    const { data: profile, error: profileError } = await db
      .from('profiles')
      .select('id, email, full_name, role, org_id, created_at, updated_at')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      logger.warn({ userId }, 'Data export requested for non-existent profile');
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    // 2. Rate limit (1 export per 24 hours, per REG-11 acceptance criteria)
    const { data: allowed, error: rateError } = await db.rpc(
      'can_export_user_data',
      { p_user_id: userId },
    );

    if (rateError) {
      logger.error({ userId, error: rateError }, 'Rate-limit RPC failed');
      res.status(500).json({ error: 'Failed to process export request' });
      return;
    }

    if (allowed === false) {
      logger.info({ userId }, 'Data export rejected: 24h rate limit');
      res.status(429).json({
        error: 'You have already exported your data in the last 24 hours. Please wait and try again later.',
      });
      return;
    }

    // 3. Record the request (required audit trail under GDPR Art. 30 + Kenya
    //    DPA Part VI). Stored BEFORE gathering so we have a record even if
    //    gathering fails partway through.
    const { data: requestRow, error: insertError } = await db
      .from('data_subject_requests')
      .insert({
        user_id: userId,
        request_type: 'export',
        status: 'processing',
      })
      .select()
      .single();

    if (insertError || !requestRow) {
      logger.error({ userId, error: insertError }, 'Failed to record data subject request');
      res.status(500).json({ error: 'Failed to process export request' });
      return;
    }

    // 4. Gather user-scoped data. Each query is a best-effort read — if one
    //    table errors we still return what we have rather than failing the
    //    entire export (the subject's right of access is not conditional on
    //    every subsystem being healthy).
    const [anchorsResult, auditResult] = await Promise.all([
      db
        .from('anchors')
        .select('id, public_id, fingerprint, status, created_at, chain_timestamp, chain_tx_id, revoked_at, revocation_reason')
        .eq('created_by', userId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(10000),
      db
        .from('audit_events')
        .select('id, event_type, event_category, target_type, target_id, details, created_at')
        .eq('actor_id', userId)
        .order('created_at', { ascending: false })
        .limit(10000),
    ]);

    const anchors = anchorsResult.data ?? [];
    const auditEvents = auditResult.data ?? [];

    // 5. Build the export payload
    const payload: ExportPayload = {
      schema: 'arkova.data-export.v1',
      generated_at: new Date().toISOString(),
      request: {
        id: (requestRow as { id: string }).id,
        type: 'export',
        legal_basis:
          'GDPR Art. 15 (right of access) + Art. 20 (right to data portability); Kenya DPA s. 31; Australia APP 12; South Africa POPIA s. 23; Nigeria NDPA',
      },
      subject: {
        profile: profile as Record<string, unknown>,
      },
      data: {
        anchors,
        audit_events: auditEvents,
      },
    };

    // 6. Mark request completed (note: we do this AFTER building the payload
    //    but BEFORE sending the response, so the audit row reflects actual
    //    completion not just "finished processing")
    await db
      .from('data_subject_requests')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        details: {
          anchor_count: anchors.length,
          audit_event_count: auditEvents.length,
        },
      })
      .eq('id', (requestRow as { id: string }).id);

    logger.info(
      {
        userId,
        requestId: (requestRow as { id: string }).id,
        anchorCount: anchors.length,
        auditEventCount: auditEvents.length,
      },
      'Data export completed',
    );

    // 7. Trigger file download
    const filename = `arkova-export-${userId}-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(payload);
  } catch (error) {
    logger.error({ userId, error }, 'Data export failed unexpectedly');
    res.status(500).json({ error: 'Data export failed' });
  }
}
