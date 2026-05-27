/**
 * SCRUM-1872: DocuSign notarization completed job handler.
 *
 * Processes queued `docusign.notarization_completed` jobs. Each job:
 *   1. Validates payload via Zod
 *   2. Looks up the legally_binding_attestations row by docusign_envelope_id
 *   3. Verifies org_id match (cross-tenant guard)
 *   4. Verifies status is pending_notarization
 *   5. Updates row: pending_notarization → notarized with notary metadata
 *   6. Writes a NOTARIZATION_COMPLETED audit event (non-fatal)
 *
 * Constitution refs:
 *   - 1.4: Never expose org_id publicly, cross-tenant guard mandatory
 *   - 1.2: Zod on every write path
 *   - 1.7: Tests first (see .test.ts)
 */

import { z } from 'zod';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { processNextJob } from '../utils/jobQueue.js';

export const DOCUSIGN_NOTARIZATION_COMPLETED_JOB_TYPE = 'docusign.notarization_completed';
const DEFAULT_JOB_LIMIT = 10;
const MAX_JOB_LIMIT = 100;

// ── Zod payload schema ──────────────────────────────────────────────

export const DocusignNotarizationCompletedJobPayload = z.object({
  org_id: z.string().uuid(),
  integration_id: z.string().min(1),
  account_id: z.string().min(1),
  envelope_id: z.string().min(1),
  rule_event_id: z.string().min(1),
  notary_name: z.string().min(1).nullable().optional().default(null),
  notary_commission_state: z.string().min(1).nullable().optional().default(null),
  notary_commission_number: z.string().min(1).nullable().optional().default(null),
  notarization_completed_at: z.string().min(1),
});

export type DocusignNotarizationCompletedJobPayloadT = z.infer<
  typeof DocusignNotarizationCompletedJobPayload
>;

// ── Result types ────────────────────────────────────────────────────

export interface NotarizationJobResult {
  success: boolean;
  lbaId?: string;
  previousStatus?: string;
  newStatus?: string;
  reason?: string;
}

// ── LBA row shape (select columns) ─────────────────────────────────

interface LbaRow {
  id: string;
  attestation_id: string;
  status: string;
  docusign_envelope_id: string | null;
  attesting_org_id: string;
}

// ── Core job processor ──────────────────────────────────────────────

export async function processDocusignNotarizationCompletedJob(
  rawPayload: unknown,
): Promise<NotarizationJobResult> {
  // Validate payload
  let payload: DocusignNotarizationCompletedJobPayloadT;
  try {
    payload = DocusignNotarizationCompletedJobPayload.parse(rawPayload);
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      'DocuSign notarization job: invalid payload',
    );
    return { success: false, reason: 'invalid_payload' };
  }

  // Look up the LBA row by docusign_envelope_id + org_id (org-scoped to prevent cross-tenant info leak)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: lba, error: lookupError } = await (db as any)
    .from('legally_binding_attestations')
    .select('id, attestation_id, status, docusign_envelope_id, attesting_org_id')
    .eq('docusign_envelope_id', payload.envelope_id)
    .eq('attesting_org_id', payload.org_id)
    .maybeSingle();

  if (lookupError) {
    logger.error(
      { error: lookupError, envelopeId: payload.envelope_id },
      'DocuSign notarization job: LBA lookup failed',
    );
    return { success: false, reason: 'lookup_failed' };
  }

  const row = lba as LbaRow | null;
  if (!row) {
    logger.warn(
      { envelopeId: payload.envelope_id },
      'DocuSign notarization job: no LBA found for envelope',
    );
    return { success: false, reason: 'lba_not_found' };
  }

  // Cross-tenant guard: org_id from webhook must match LBA's attesting_org_id
  if (row.attesting_org_id !== payload.org_id) {
    logger.error(
      {
        envelopeId: payload.envelope_id,
        expectedOrg: row.attesting_org_id,
        payloadOrg: payload.org_id,
      },
      'DocuSign notarization job: cross-tenant mismatch — rejecting',
    );
    return { success: false, reason: 'org_mismatch' };
  }

  // Status guard: must be pending_notarization
  if (row.status !== 'pending_notarization') {
    logger.warn(
      { lbaId: row.id, currentStatus: row.status, envelopeId: payload.envelope_id },
      'DocuSign notarization job: LBA not in pending_notarization status',
    );
    return { success: false, reason: 'wrong_status' };
  }

  // Update: pending_notarization → notarized with notary metadata
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: updated, error: updateError } = await (db as any)
    .from('legally_binding_attestations')
    .update({
      status: 'notarized',
      notary_name: payload.notary_name ?? null,
      notary_commission_state: payload.notary_commission_state ?? null,
      notary_commission_number: payload.notary_commission_number ?? null,
      notarization_completed_at: payload.notarization_completed_at,
    })
    .eq('id', row.id)
    .eq('status', 'pending_notarization') // Optimistic lock
    .select('id');

  if (updateError) {
    logger.error(
      { error: updateError, lbaId: row.id },
      'DocuSign notarization job: LBA update failed',
    );
    return { success: false, reason: 'update_failed' };
  }

  if (!updated || (updated as unknown[]).length === 0) {
    logger.warn(
      { lbaId: row.id },
      'DocuSign notarization job: LBA status changed during update — skipped',
    );
    return { success: false, reason: 'race_condition' };
  }

  logger.info(
    { lbaId: row.id, attestationId: row.attestation_id, envelopeId: payload.envelope_id },
    'DocuSign notarization completed: LBA updated to notarized',
  );

  // Audit event — non-fatal
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  void (db as any).from('audit_events').insert({
    event_type: 'NOTARIZATION_COMPLETED',
    event_category: 'COMPLIANCE',
    actor_id: 'system',
    target_type: 'legally_binding_attestation',
    target_id: row.id,
    org_id: payload.org_id,
    details: JSON.stringify({
      attestation_id: row.attestation_id,
      envelope_id: payload.envelope_id,
      notary_name: payload.notary_name,
    }),
  }).then(({ error: auditErr }: { error: unknown }) => {
    if (auditErr) logger.warn({ error: auditErr, lbaId: row.id }, 'Notarization audit event insert failed');
  }).catch(() => { /* non-fatal */ });

  return {
    success: true,
    lbaId: row.id,
    previousStatus: 'pending_notarization',
    newStatus: 'notarized',
  };
}

// ── Queue runner ────────────────────────────────────────────────────

export interface NotarizationJobRunResult {
  claimed: number;
  completed: number;
  failed: number;
  dead: number;
  updateFailed: number;
  jobIds: string[];
}

export async function runDocusignNotarizationCompletedJobs(
  options: { limit?: number } = {},
): Promise<NotarizationJobRunResult> {
  const rawLimit = options.limit ?? DEFAULT_JOB_LIMIT;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_JOB_LIMIT, Math.max(1, Math.trunc(rawLimit)))
    : DEFAULT_JOB_LIMIT;

  const result: NotarizationJobRunResult = {
    claimed: 0,
    completed: 0,
    failed: 0,
    dead: 0,
    updateFailed: 0,
    jobIds: [],
  };

  for (let i = 0; i < limit; i++) {
    const processed = await processNextJob(
      DOCUSIGN_NOTARIZATION_COMPLETED_JOB_TYPE,
      async (job) => {
        await processDocusignNotarizationCompletedJob(job.payload);
      },
    );
    if (!processed.claimed) break;

    result.claimed += 1;
    if (processed.jobId) result.jobIds.push(processed.jobId);
    if (processed.status === 'completed') result.completed += 1;
    if (processed.status === 'failed') result.failed += 1;
    if (processed.status === 'dead') result.dead += 1;
    if (processed.status === 'update_failed') result.updateFailed += 1;
  }

  return result;
}
