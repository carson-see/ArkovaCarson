/**
 * Version Conflict Detection (SCRUM-1970 — SCRUM-1126)
 *
 * When the rules engine matches an event that carries an external_file_id,
 * this module checks whether that file has already been anchored in the same
 * org. Three outcomes:
 *
 *   1. No existing anchor → proceed normally (no conflict).
 *   2. Existing anchor with SAME fingerprint → idempotent skip (log info).
 *   3. Existing anchor with DIFFERENT fingerprint → version conflict detected.
 *      Insert a row into external_document_versions with status 'pending_review'.
 *      Do NOT create a new anchor — human review is required.
 *
 * The rules engine (`rules-engine.ts`) calls detectVersionConflict() after a
 * rule matches but before creating an anchor execution.
 */
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ConflictResult =
  | { conflict: false; idempotent?: undefined; existingAnchorId?: undefined }
  | { conflict: false; idempotent: true; existingAnchorId: string }
  | { conflict: true; existingAnchorId: string; existingFingerprint: string };

export interface InsertVersionRecordParams {
  orgId: string;
  externalFileId: string;
  fingerprint: string;
  source: string;
  metadata?: Record<string, unknown>;
}

export interface InsertVersionRecordResult {
  success: boolean;
  error?: string;
}

// ─── detectVersionConflict ──────────────────────────────────────────────────

/**
 * Check if an external_file_id already has a SECURED anchor in the given org.
 *
 * Returns one of three shapes:
 *   - { conflict: false } — no existing anchor, proceed with anchoring
 *   - { conflict: false, idempotent: true, existingAnchorId } — same fingerprint, skip
 *   - { conflict: true, existingAnchorId, existingFingerprint } — different fingerprint
 */
export async function detectVersionConflict(
  orgId: string,
  externalFileId: string,
  newFingerprint: string,
): Promise<ConflictResult> {
  try {
    // Look for an existing SECURED anchor with this external_file_id in the org
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('anchors')
      .select('id, fingerprint')
      .eq('org_id', orgId)
      .eq('external_file_id', externalFileId)
      .single();

    if (error || !data) {
      // No existing anchor found — proceed normally
      return { conflict: false };
    }

    const existingFingerprint = data.fingerprint as string;
    const existingAnchorId = data.id as string;

    if (existingFingerprint === newFingerprint) {
      // Same fingerprint — idempotent, skip without creating a new anchor
      logger.info(
        { orgId, externalFileId, anchorId: existingAnchorId },
        'Version conflict check: idempotent — same fingerprint already anchored',
      );
      return { conflict: false, idempotent: true, existingAnchorId };
    }

    // Different fingerprint — version conflict detected
    logger.info(
      { orgId, externalFileId, existingAnchorId, existingFingerprint, newFingerprint },
      'Version conflict detected: different fingerprint for previously-anchored file',
    );
    return { conflict: true, existingAnchorId, existingFingerprint };
  } catch (err) {
    logger.error(
      { error: err, orgId, externalFileId },
      'detectVersionConflict threw — treating as no conflict (fail-open for anchor creation)',
    );
    return { conflict: false };
  }
}

// ─── insertVersionRecord ────────────────────────────────────────────────────

/**
 * Insert a pending_review row into external_document_versions when a version
 * conflict is detected. Uses ON CONFLICT DO NOTHING on the unique constraint
 * so repeated processing is safe.
 */
export async function insertVersionRecord(
  params: InsertVersionRecordParams,
): Promise<InsertVersionRecordResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any)
      .from('external_document_versions')
      .insert({
        org_id: params.orgId,
        external_file_id: params.externalFileId,
        fingerprint: params.fingerprint,
        source: params.source,
        status: 'pending_review',
        metadata: params.metadata ?? {},
      });

    if (error) {
      logger.warn(
        { error, orgId: params.orgId, externalFileId: params.externalFileId },
        'insertVersionRecord: insert failed',
      );
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { error: err, orgId: params.orgId, externalFileId: params.externalFileId },
      'insertVersionRecord threw',
    );
    return { success: false, error: msg };
  }
}
