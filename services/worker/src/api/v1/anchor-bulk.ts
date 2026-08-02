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
import { ensureOrgNotSuspended } from '../../utils/orgSuspensionGuard.js';
import { requireOrgQuota } from '../../middleware/perOrgRateLimit.js';
import { submitJob } from '../../utils/jobQueue.js';
import { buildProfessionalEducationJobPayload } from '../../compliance/professional-education.js';
import {
  isProfessionalEducationSchemaReady,
  professionalEducationSchemaUnavailableBody,
} from '../../utils/professionalEducationSchemaGate.js';
import { chunkForInFilter } from '../../utils/postgrest-filter.js';

const router = Router();

const FINGERPRINT_REGEX = /^[a-fA-F0-9]{64}$/;

const CREDENTIAL_TYPES = [
  'DEGREE', 'LICENSE', 'CERTIFICATE', 'TRANSCRIPT', 'PROFESSIONAL', 'CPE', 'CLE',
  'BADGE', 'ATTESTATION', 'FINANCIAL', 'LEGAL', 'INSURANCE', 'SEC_FILING', 'PATENT',
  'REGULATION', 'PUBLICATION', 'CHARITY', 'ACCREDITATION', 'FINANCIAL_ADVISOR',
  'BUSINESS_ENTITY', 'RESUME', 'MEDICAL', 'MILITARY', 'IDENTITY',
  'CONTRACT_PRESIGNING', 'CONTRACT_POSTSIGNING', 'OTHER',
] as const;

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

async function consumeAnchorCreateQuota(
  req: Request,
  res: Response,
  delta: number,
): Promise<boolean> {
  const quota = requireOrgQuota({
    kind: 'anchors_created',
    mode: 'daily',
    getOrgId: (quotaReq) => quotaReq.apiKey?.orgId ?? null,
    getDelta: () => delta,
  });
  let allowed = false;
  await quota(req, res, () => {
    allowed = true;
  });
  return allowed;
}

router.post('/', async (req: Request, res: Response) => {
  if (!req.apiKey) {
    res.status(401).json({ error: 'API key required. Include X-API-Key header.' });
    return;
  }
  const orgId = req.apiKey.orgId;

  // SCRUM-1667 — sub-org suspension guard, gated by
  // ENABLE_ORG_SUSPENSION_GUARD (default off). Same default-off
  // rollout as anchor-submit + anchor-pre-signing.
  if (process.env.ENABLE_ORG_SUSPENSION_GUARD === 'true' && orgId) {
    const suspensionGuard = await ensureOrgNotSuspended(orgId);
    if (!suspensionGuard.ok) {
      const status = suspensionGuard.code === 'org_suspended' ? 403 : 503;
      res.status(status).json({
        error: suspensionGuard.code,
        message: suspensionGuard.message,
      });
      return;
    }
  }

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

  if (!isProfessionalEducationSchemaReady() && body.anchors.some((row) => row.credential_type === 'CPE')) {
    res.status(503).json(professionalEducationSchemaUnavailableBody('anchor-bulk:cpe'));
    return;
  }

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
  let existingFingerprints: Set<string>;
  try {
    existingFingerprints = await fetchExistingFingerprints(orgId, [...inBatchSeen.keys()]);
  } catch (err) {
    // FAIL CLOSED. This check is the only thing between a re-submitted batch
    // and a second set of anchors that are created AND billed. Treating an
    // unreadable answer as "no duplicates exist" is what turned a 400 on the
    // filter into duplicate anchors on a customer invoice; the previous
    // `logger.warn` + continue was exactly that.
    //
    // Log the driver's error CODE only — a Postgres/PostgREST `.message`
    // routinely echoes the offending value back verbatim, and a fingerprint
    // must not reach the logs (§1.1).
    logger.error(
      {
        pgCode: (err as { pgCode?: string } | null)?.pgCode ?? null,
        orgId,
        fingerprintCount: inBatchSeen.size,
      },
      'bulk-anchor: duplicate check failed — refusing the batch rather than risking duplicate billed anchors',
    );
    res.status(503).json({
      error: 'duplicate_check_unavailable',
      message:
        'Could not determine whether these fingerprints already exist. No anchors were created and no credits were consumed. Please retry.',
    });
    return;
  }

  const dbDuplicates: DuplicateRow[] = body.anchors
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => existingFingerprints.has(normalizeFingerprint(row.fingerprint)))
    .map(({ row, i }) => ({
      row: i,
      fingerprint: row.fingerprint,
      scope: 'in_db' as const,
      decision: body.duplicate_strategy,
    }));

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
  const dbDupFingerprints = new Set<string>(dbDuplicates.map((d) => normalizeFingerprint(d.fingerprint)));

  const queueable = body.anchors
    .map((row, originalRow) => ({ row, originalRow }))
    .filter(({ row, originalRow }) => {
      if (dropRowsAtBatchIndex.has(originalRow)) return false;
      if (dbDupFingerprints.has(normalizeFingerprint(row.fingerprint))) return false;
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

  if (!(await consumeAnchorCreateQuota(req, res, queueable.length))) {
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
    const { row, originalRow } = queueable[i];
    try {
      const metadata = buildMetadata(row, body.batch_id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (db as any)
        .from('anchors')
        .insert({
          org_id: orgId,
          user_id: req.apiKey.userId,
          fingerprint: normalizeFingerprint(row.fingerprint),
          credential_type: row.credential_type ?? null,
          status: 'PENDING',
          metadata,
        })
        .select('id, public_id, fingerprint, created_at, credential_type, metadata')
        .single();

      if (error || !data) {
        // Log sanitized Postgres diagnostics server-side for debugging but never expose
        // internal database identifiers (table names, constraint names, pg
        // error codes) to API clients — SonarCloud security hotspot.
        const pgCode = (error as { code?: string } | null)?.code;
        logger.error(
          { pgCode, orgId, batchRow: originalRow },
          'bulk-anchor: insert failed',
        );
        const clientMessage = pgCode === '23505'
          ? 'A conflicting anchor record already exists.'
          : 'Failed to create anchor record.';
        errors.push({ row: originalRow, code: 'insert_failed', message: clientMessage });
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

      enqueueProfessionalEducationExtraction({
        id: data.id,
        public_id: data.public_id,
        fingerprint: data.fingerprint,
        credential_type: data.credential_type ?? row.credential_type ?? null,
        org_id: orgId,
        user_id: req.apiKey.userId,
        metadata: (data.metadata as Record<string, unknown> | null | undefined) ?? metadata,
      });
    } catch (err) {
      // Log only sanitized diagnostics; never leak fingerprint/error details.
      const errorName = err instanceof Error ? err.name : typeof err;
      logger.error({ errorName, orgId, batchRow: originalRow }, 'bulk-anchor: unexpected insert error');
      errors.push({
        row: originalRow,
        code: 'unexpected_error',
        message: 'An unexpected error occurred. Contact support if this persists.',
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

/**
 * The one normalization for a fingerprint on this route.
 *
 * The insert lower-cases before writing, so every row this endpoint creates is
 * stored lower-case. `anchors.fingerprint` is `character(64)` and PostgREST
 * compares it byte-for-byte, so a comparison that skips this is case-sensitive
 * against a case-normalized column — which is how an upper-case resubmission
 * of an existing document matched nothing and was re-created and re-billed.
 * `trim` guards the bpchar padding an under-length legacy value could carry.
 */
function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.trim().toLowerCase();
}

/** Error carrying only a driver code — never a message that could echo a fingerprint. */
class DuplicateCheckError extends Error {
  constructor(readonly pgCode: string | null, chunkStart: number) {
    super(`bulk-anchor: duplicate check failed at chunk offset ${chunkStart}`);
    this.name = 'DuplicateCheckError';
  }
}

/**
 * Which of `fingerprints` already exist on an anchor in this org.
 *
 * Two things this must get right, both of which it previously got wrong:
 *
 *  - **Width.** The Zod cap is 1000 rows of 64-char hex, and the PostgREST URL
 *    budget is exhausted at ~122 of them. A single `.in()` over the whole set
 *    took 400 Bad Request. `chunkForInFilter` owns the width; this function
 *    does not get to pick one.
 *  - **Failure.** postgrest-js RESOLVES a 400 as `{ data: null, error }`
 *    rather than throwing, so `const { data } = await …` silently produced an
 *    empty set and the surrounding `catch` never ran.
 *
 * Throws on the FIRST failed chunk rather than counting failures: this is
 * deliberately stricter than `assertNotAllChunksFailed`, which only refuses
 * the all-failed case. A partially-read dedup answer is not a weaker signal
 * here — it is a wrong one, and every fingerprint it misses becomes an anchor
 * the customer is charged for twice.
 */
async function fetchExistingFingerprints(
  orgId: string | null,
  fingerprints: string[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  if (fingerprints.length === 0) return existing;

  // Ask about BOTH the caller's casing and the normalized casing we insert
  // with. Extra values in an existence probe can only find more matches, never
  // fewer, so this is safe against rows written before the insert path
  // normalized — and it costs nothing for the common all-lower-case batch.
  const variants = [
    ...new Set(fingerprints.flatMap((f) => [f, normalizeFingerprint(f)])),
  ];

  for (const { values, start } of chunkForInFilter(variants)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('anchors')
      .select('fingerprint')
      .eq('org_id', orgId)
      .in('fingerprint', values);

    if (error) {
      throw new DuplicateCheckError((error as { code?: string } | null)?.code ?? null, start);
    }

    for (const row of (data ?? []) as Array<{ fingerprint: string | null }>) {
      if (row.fingerprint) existing.add(normalizeFingerprint(row.fingerprint));
    }
  }

  return existing;
}

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

function enqueueProfessionalEducationExtraction(anchor: {
  id?: string;
  public_id: string | null;
  fingerprint: string | null;
  credential_type: string | null;
  org_id: string | null;
  user_id: string | null;
  metadata: Record<string, unknown> | null;
}): void {
  if (!anchor.id) return;
  if (!isProfessionalEducationSchemaReady()) return;

  const payload = buildProfessionalEducationJobPayload({ ...anchor, id: anchor.id });
  if (!payload) return;

  void submitJob({
    type: 'professional_education.metadata_extraction',
    payload,
    priority: 20,
    max_attempts: 5,
  }).catch((error: unknown) => {
    logger.warn({ error, anchorId: anchor.id }, 'Failed to enqueue professional education extraction job');
  });
}

export { router as anchorBulkRouter };
