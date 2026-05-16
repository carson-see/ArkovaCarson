/**
 * Version Conflict Detector (SCRUM-1970 / SCRUM-1126)
 *
 * When a rule-matched event has an external_file_id, checks if an anchor
 * already exists for that file in the org:
 *
 *   - No existing anchor → "no_conflict" (first version, queue normally)
 *   - Same fingerprint → "same_fingerprint" (idempotent skip)
 *   - Different fingerprint → "version_conflict" (create version record, notify admin)
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { emitOrgAdminNotifications } from '../notifications/dispatcher.js';

export type VersionConflictOutcome = 'no_conflict' | 'same_fingerprint' | 'version_conflict';

export interface VersionConflictResult {
  outcome: VersionConflictOutcome;
  version_id?: string;
  existing_anchor_id?: string;
}

export interface VersionConflictInput {
  org_id: string;
  external_file_id: string | undefined;
  fingerprint: string;
  filename?: string;
  source: string;
  trigger_event_id?: string;
}

export async function checkVersionConflict(input: VersionConflictInput): Promise<VersionConflictResult> {
  if (!input.external_file_id) {
    return { outcome: 'no_conflict' };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existingAnchors, error: fetchError } = await (db as any)
    .from('anchors')
    .select('id, fingerprint, status')
    .eq('org_id', input.org_id)
    .eq('status', 'SECURED')
    .is('deleted_at', null)
    .limit(1);

  if (fetchError || !existingAnchors) {
    logger.warn({ error: fetchError, org_id: input.org_id, external_file_id: input.external_file_id },
      'Version conflict check: anchor query failed — treating as no conflict');
    return { outcome: 'no_conflict' };
  }

  if (existingAnchors.length === 0) {
    return { outcome: 'no_conflict' };
  }

  const existing = existingAnchors[0] as { id: string; fingerprint: string };

  if (existing.fingerprint === input.fingerprint) {
    return { outcome: 'same_fingerprint', existing_anchor_id: existing.id };
  }

  // Different fingerprint — version conflict detected
  const versionNumber = await getNextVersionNumber(input.org_id, input.external_file_id);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inserted, error: insertError } = await (db as any)
    .from('external_document_versions')
    .insert({
      org_id: input.org_id,
      external_file_id: input.external_file_id,
      fingerprint: input.fingerprint,
      source: input.source,
      version_number: versionNumber,
      filename: input.filename ?? null,
      status: 'pending_review',
      trigger_event_id: input.trigger_event_id ?? null,
      metadata: { previous_anchor_id: existing.id },
    })
    .select('id')
    .single();

  if (insertError) {
    logger.error({ error: insertError, org_id: input.org_id, external_file_id: input.external_file_id },
      'Version conflict: failed to insert version record');
    return { outcome: 'no_conflict' };
  }

  const versionId = (inserted as { id: string } | null)?.id;

  // Emit notification for org admins
  await emitOrgAdminNotifications({
    type: 'document.version_conflict',
    organizationId: input.org_id,
    payload: {
      external_file_id: input.external_file_id,
      filename: input.filename,
      source: input.source,
      existing_anchor_id: existing.id,
      new_fingerprint: input.fingerprint,
      version_id: versionId,
    },
  });

  return {
    outcome: 'version_conflict',
    version_id: versionId,
    existing_anchor_id: existing.id,
  };
}

async function getNextVersionNumber(orgId: string, externalFileId: string): Promise<number> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('external_document_versions')
      .select('version_number')
      .eq('org_id', orgId)
      .eq('external_file_id', externalFileId)
      .order('version_number', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) return 2;
    return ((data as { version_number: number }).version_number ?? 1) + 1;
  } catch {
    return 2;
  }
}
