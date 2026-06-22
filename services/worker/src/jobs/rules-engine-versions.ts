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
import { z } from 'zod';
import type { Json } from '../types/database.types.js';
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

const VersionRecordInsertSchema = z.object({
  org_id: z.string().uuid(),
  external_file_id: z.string().min(1),
  fingerprint: z.string().min(1),
  source: z.string().min(1),
  status: z.literal('pending_review'),
  metadata: z.record(z.string(), z.unknown()),
});

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
  const { data, error } = await db
    .from('anchors')
    .select('id, fingerprint')
    .eq('org_id', orgId)
    .eq('metadata->>external_file_id', externalFileId)
    .eq('status', 'SECURED')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    // Fail closed: query errors must not be swallowed as "no conflict"
    logger.error(
      { error, orgId, externalFileId },
      'detectVersionConflict: query failed — failing closed',
    );
    throw new Error('detectVersionConflict query failed');
  }

  if (!data) {
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
    const row = {
      org_id: params.orgId,
      external_file_id: params.externalFileId,
      fingerprint: params.fingerprint,
      source: params.source,
      status: 'pending_review',
      metadata: params.metadata ?? {},
    };
    const parsed = VersionRecordInsertSchema.safeParse(row);
    if (!parsed.success) {
      logger.warn(
        { validationIssues: parsed.error.issues.map(issue => issue.path.join('.')) },
        'insertVersionRecord: invalid version record',
      );
      return { success: false, error: 'invalid version record' };
    }

    const { error } = await db
      .from('external_document_versions')
      .upsert(
        { ...parsed.data, metadata: parsed.data.metadata as Json },
        { onConflict: 'org_id,external_file_id,fingerprint', ignoreDuplicates: true },
      );

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
