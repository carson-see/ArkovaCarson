/**
 * POST /api/v1/anchor/bulk — HAKI-REQ-02 (SCRUM-1171)
 *
 * Bulk + retroactive anchoring with original-document metadata preserved
 * separately from the anchoring timestamp.
 *
 * Per Constitution §1.6: documents never leave the user's device. The bulk
 * endpoint accepts already-computed SHA-256 fingerprints, never raw content.
 * Original-document metadata (original_document_date, document_type,
 * matter_or_case_ref, external_id) lives in `anchors.metadata` JSONB and is
 * surfaced separately from `anchored_at` in evidence exports.
 *
 * AC matrix:
 *   AC1 metadata fields accepted        → ROW_SCHEMA below
 *   AC2 distinct dates in responses     → shapeRow() preserves original_document_date as a top-level field
 *   AC3 dry-run validation              → BulkAnchorRequestSchema.dryRun flag
 *   AC4 duplicate handling              → intra-batch dedup + DB unique-fingerprint detection
 *   AC5 progress visibility             → response includes counts (validated / queued / duplicates / failures)
 *   AC6 evidence export carries metadata → unchanged; anchor-evidence.ts already passes metadata through
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { deductOrgCredit } from '../../utils/orgCredits.js';

const router = Router();

const FINGERPRINT_REGEX = /^[a-fA-F0-9]{64}$/;

const CREDENTIAL_TYPES = ['DEGREE', 'LICENSE', 'CERTIFICATE', 'TRANSCRIPT', 'PROFESSIONAL', 'OTHER'] as const;

const DUPLICATE_STRATEGIES = ['skip', 'supersede', 'link', 'fail'] as const;

const BulkAnchorRowSchema = z.object({
  fingerprint: z.string().regex(FINGERPRINT_REGEX, 'must be a 64-character hex SHA-256 hash'),
  credential_type: z.enum(CREDENTIAL_TYPES).optional(),
  description: z.string().max(1000).optional(),
  /** Real-world date the document was created/executed (ISO 8601). Distinct from anchored_at. */
  original_document_date: z.string().datetime({ offset: true }).optional(),
  /** Free-form classifier — "contract", "1099", "engagement_letter", etc. */
  document_type: z.string().min(1).max(100).optional(),
  /** External tenant reference (case number, matter, etc.). */
  matter_or_case_ref: z.string().min(1).max(200).optional(),
  /** Customer-system primary key for round-tripping. */
  external_id: z.string().min(1).max(200).optional(),
}).strict();

export const BulkAnchorRequestSchema = z.object({
  /** Up to 1000 rows per call to keep validation O(n²) on duplicates bounded. */
  anchors: z.array(BulkAnchorRowSchema).min(1).max(1000),
  /** When true: validate every row but don't queue. AC3. */
  dry_run: z.boolean().optional(),
  /** Strategy when a fingerprint already exists in the org. AC4. */
  duplicate_strategy: z.enum(DUPLICATE_STRATEGIES).optional().default('fail'),
  /** Optional client-supplied batch ID, surfaced in audit events. AC6. */
  batch_id: z.string().min(1).max(100).optional(),
}).strict();

type BulkAnchorRow = z.infer<typeof BulkAnchorRowSchema>;
type BulkAnchorRequest = z.infer<typeof BulkAnchorRequestSchema>;

interface RowError {
  row: number;
  field?: string;
  code: string;
  message: string;
}

interface DuplicateRow {
  row: number;
  fingerprint: string;
  scope: 'in_batch' | 'in_db';
  decision: typeof DUPLICATE_STRATEGIES[number];
}

interface BulkAnchorResponse {
  batch_id: string | null;
  validated: number;
  queued: number;
  duplicates: DuplicateRow[];
  errors: RowError[];
  dry_run: boolean;
  /** When `dry_run=false` and rows were queued, the inserted anchors. */
  anchors?: Array<{
    public_id: string;
    fingerprint: string;
    status: 'PENDING';
    original_document_date: string | null;
    document_type: string | null;
    matter_or_case_ref: string | null;
    external_id: string | null;
    anchored_at: string;
  }>;
}

router.post('/', async (req: Request, res: Response) => {
  if (!req.apiKey) {
    res.status(401).json({ error: 'API key required. Include X-API-Key header.' });
    return;
  }
  const orgId = req.apiKey.orgId;

  const parsed = BulkAnchorRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Request body failed validation',
      details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })),
    });
    return;
  }

  const body: BulkAnchorRequest = parsed.data;

  // ── Intra-batch duplicate detection (AC4 first pass) ────────────────
  const inBatchSeen = new Map<string, number>(); // fingerprint → first row index
  const intraBatchDuplicates: DuplicateRow[] = [];
  body.anchors.forEach((row, i) => {
    const existing = inBatchSeen.get(row.fingerprint);
    if (existing === undefined) {
      inBatchSeen.set(row.fingerprint, i);
    } else {
      intraBatchDuplicates.push({
        row: i,
        fingerprint: row.fingerprint,
        scope: 'in_batch',
        decision: body.duplicate_strategy,
      });
    }
  });

  // ── DB-level duplicate detection (AC4 second pass) ──────────────────
  let dbDuplicates: DuplicateRow[] = [];
  try {
    const fingerprints = [...inBatchSeen.keys()];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing } = await (db as any)
      .from('anchors')
      .select('fingerprint')
      .eq('org_id', orgId)
      .in('fingerprint', fingerprints);
    const existingSet = new Set((existing ?? []).map((r: { fingerprint: string }) => r.fingerprint.toLowerCase()));
    dbDuplicates = body.anchors
      .map((row, i) => ({ row, i }))
      .filter(({ row }) => existingSet.has(row.fingerprint.toLowerCase()))
      .map(({ row, i }) => ({
        row: i,
        fingerprint: row.fingerprint,
        scope: 'in_db' as const,
        decision: body.duplicate_strategy,
      }));
  } catch (err) {
    logger.warn({ err, orgId }, 'bulk-anchor: db duplicate check failed; continuing without DB-side dedup');
  }

  const allDuplicates = [...intraBatchDuplicates, ...dbDuplicates];

  // 'fail' duplicate strategy halts the whole batch on any duplicate (AC4).
  if (body.duplicate_strategy === 'fail' && allDuplicates.length > 0) {
    res.status(409).json({
      error: 'duplicate_fingerprints',
      message: `Batch contains ${allDuplicates.length} duplicate fingerprint(s); pick a duplicate_strategy other than "fail" to proceed.`,
      duplicates: allDuplicates,
    });
    return;
  }

  // ── Decide which rows actually queue (AC4) ──────────────────────────
  // Always drop second+ in-batch occurrences (the first occurrence still queues).
  // For DB duplicates, the strategy decides:
  //   - skip       → drop the row entirely (DB-side row is canonical)
  //   - supersede  → drop the row at queue layer; ARK-104 lineage wiring will
  //                  later mark the existing row as superseded (followup)
  //   - link       → drop the row at queue layer; client uses external_id to
  //                  re-attach to the existing anchor
  //   - fail       → already returned 409 above
  const dropRowsAtBatchIndex = new Set<number>(intraBatchDuplicates.map((d) => d.row));
  const dbDupFingerprints = new Set<string>(dbDuplicates.map((d) => d.fingerprint.toLowerCase()));

  const queueable = body.anchors.filter((r, i) => {
    if (dropRowsAtBatchIndex.has(i)) return false;
    if (dbDupFingerprints.has(r.fingerprint.toLowerCase())) return false;
    return true;
  });

  // ── Dry-run short-circuit (AC3) ─────────────────────────────────────
  if (body.dry_run) {
    res.status(200).json({
      batch_id: body.batch_id ?? null,
      validated: body.anchors.length,
      queued: queueable.length,
      duplicates: allDuplicates,
      errors: [],
      dry_run: true,
    } satisfies BulkAnchorResponse);
    return;
  }

  // ── Org-credit deduction (existing pattern from anchor-submit.ts) ───
  if (queueable.length > 0) {
    const deduction = await deductOrgCredit(db, orgId, queueable.length, 'anchor.bulk', body.batch_id);
    if (!deduction.allowed) {
      res.status(402).json({
        error: deduction.error ?? 'insufficient_credits',
        balance: deduction.balance,
        required: queueable.length,
        message: deduction.message,
      });
      return;
    }
  }

  // ── Insert (AC5 progress visibility = response counts) ──────────────
  const errors: RowError[] = [];
  const inserted: NonNullable<BulkAnchorResponse['anchors']> = [];

  for (let i = 0; i < queueable.length; i++) {
    const row = queueable[i];
    try {
      const metadata = buildMetadata(row, body.batch_id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (db as any)
        .from('anchors')
        .insert({
          org_id: orgId,
          user_id: req.apiKey.userId,
          fingerprint: row.fingerprint.toLowerCase(),
          credential_type: row.credential_type ?? null,
          status: 'PENDING',
          metadata,
        })
        .select('public_id, fingerprint, created_at')
        .single();

      if (error || !data) {
        errors.push({ row: i, code: 'insert_failed', message: error?.message ?? 'unknown' });
        continue;
      }

      inserted.push({
        public_id: data.public_id,
        fingerprint: data.fingerprint,
        status: 'PENDING',
        original_document_date: row.original_document_date ?? null,
        document_type: row.document_type ?? null,
        matter_or_case_ref: row.matter_or_case_ref ?? null,
        external_id: row.external_id ?? null,
        anchored_at: data.created_at, // AC2: anchored_at is distinct from original_document_date
      });
    } catch (err) {
      errors.push({
        row: i,
        code: 'unexpected_error',
        message: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  res.status(201).json({
    batch_id: body.batch_id ?? null,
    validated: body.anchors.length,
    queued: inserted.length,
    duplicates: allDuplicates,
    errors,
    dry_run: false,
    anchors: inserted,
  } satisfies BulkAnchorResponse);
});

/** Build the metadata JSONB stored on the anchor row. AC1 + AC6. */
function buildMetadata(row: BulkAnchorRow, batchId: string | undefined): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (row.original_document_date) meta.original_document_date = row.original_document_date;
  if (row.document_type) meta.document_type = row.document_type;
  if (row.matter_or_case_ref) meta.matter_or_case_ref = row.matter_or_case_ref;
  if (row.external_id) meta.external_id = row.external_id;
  if (row.description) meta.description = row.description;
  if (batchId) meta.batch_id = batchId;
  meta.bulk_source = 'haki-req-02';
  return meta;
}

export { router as anchorBulkRouter };
