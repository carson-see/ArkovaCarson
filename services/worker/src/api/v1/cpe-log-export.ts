/**
 * CPE Compliance-Log Export Endpoint (SCRUM-1859 / SCRUM-1848 — CPE-R2)
 *
 * POST /api/v1/exports/cpe-log
 *
 * Body: { user_id, period_start, period_end, format: 'pdf' | 'json' }
 *
 * Mounted behind the v1 router's `requireAuth` (Supabase JWT) middleware, so
 * `req.authUserId` is the authenticated subject. This handler then:
 *   1. Validates the body with Zod (400 + structured details on failure).
 *   2. Enforces org/user scope — a caller may only export THEIR OWN records
 *      (cross-user `user_id` → 403; no org membership → 403).
 *   3. Delegates to the export worker, which generates PDF + JSON, uploads to
 *      Storage, and returns signed URLs + a metadata-only audit event.
 *
 * Rate limit (Constitution 1.10): 10 requests / user / hour. The 11th within
 * the window returns 429 with a `Retry-After` header. Enforced by the mounted
 * `cpeLogExportRateLimiter` (in-memory bucket keyed on the user id), mirroring
 * the existing `/credits` and `/ai/*` per-user limiters.
 *
 * `format` is ADVISORY ONLY. Both artifacts are always generated and returned
 * (the AC requires a signed URL for BOTH PDF and JSON, and the response always
 * carries `exports.pdf` and `exports.json`). The validated `format` value is
 * echoed back as `requested_format` to record the caller's primary intent for
 * the audit trail and a possible future single-format optimisation; it does NOT
 * select or filter which artifacts are built or returned.
 */
import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { rateLimit } from '../../utils/rateLimit.js';
import {
  generateCpeLogExport,
  createSupabaseStorageAdapter,
} from '../../exports/cpe-log-export.js';

const router = Router();

/**
 * Per-user hourly rate limiter. Exported so it can be mounted in the v1 router
 * (and exercised directly in tests). Window = 1 hour, max = 10 → the 11th
 * request in the hour 429s. Bucket scope keeps it separate from other limiters
 * sharing the same user key.
 */
export const cpeLogExportRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  maxRequests: 10,
  // `scope` already namespaces the bucket (rateLimit() prepends `${scope}:`),
  // so the keyGenerator returns only the caller identifier — otherwise the key
  // becomes `cpe-log-export:cpe-log-export:<user>`. Mirrors batchRateLimiter.
  scope: 'cpe-log-export',
  keyGenerator: (req: Request) => req.authUserId ?? req.ip ?? 'unknown',
});

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const ExportRequestSchema = z
  .object({
    user_id: z.string().min(1),
    period_start: z.string().regex(DATE_ONLY, 'period_start must be YYYY-MM-DD'),
    period_end: z.string().regex(DATE_ONLY, 'period_end must be YYYY-MM-DD'),
    format: z.enum(['pdf', 'json']),
  })
  .strict()
  .refine((v) => v.period_start <= v.period_end, {
    message: 'period_end must be on or after period_start',
    path: ['period_end'],
  });

router.post('/', async (req: Request, res: Response) => {
  const requestId = randomUUID();

  // 1. Auth (defense in depth — the router also gates with requireAuth).
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required', request_id: requestId });
    return;
  }

  // 2. Validate.
  const parsed = ExportRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid request',
      request_id: requestId,
      details: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        code: i.code,
        message: i.message,
      })),
    });
    return;
  }
  const { user_id, period_start, period_end, format } = parsed.data;

  // 3. Org/user scope. A caller may only export their own records.
  if (user_id !== userId) {
    res.status(403).json({
      error: 'You may only export your own compliance log',
      request_id: requestId,
    });
    return;
  }

  try {
    // `.maybeSingle()` (not `.single()`) so a genuinely-absent profile resolves
    // to `data: null` rather than raising PGRST116 "0 rows". We MUST inspect
    // `error`: a DB/operational failure is a 500, not a 403 — masking it as
    // "no org membership" hides the real fault. Only a successful query that
    // returns a null org_id is a true 403.
    const { data: profile, error: profileError } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .maybeSingle();

    if (profileError) {
      // Log message only (no PII / no profile row contents).
      logger.error(
        { error: profileError.message, requestId },
        'CPE log export: profile lookup failed',
      );
      res.status(500).json({
        error: 'Failed to generate CPE compliance log',
        request_id: requestId,
      });
      return;
    }

    const orgId = (profile as { org_id: string | null } | null)?.org_id ?? null;
    if (!orgId) {
      res.status(403).json({
        error: 'Organization membership required',
        request_id: requestId,
      });
      return;
    }

    // 4. Generate (PDF + JSON), upload, sign.
    const result = await generateCpeLogExport(
      { userId, orgId, periodStart: period_start, periodEnd: period_end, requestId },
      {
        db,
        storage: createSupabaseStorageAdapter(db),
        logger,
        frontendUrl: config.frontendUrl,
      },
    );

    res.status(200).json({
      request_id: result.request_id,
      record_count: result.record_count,
      // SCRUM-2378 (CPE-01): in-period records excluded because they are not
      // yet SECURED. Additive field (§1.8) — the FE renders an inline notice.
      excluded_count: result.excluded_count,
      // Advisory echo only — both `exports.pdf` and `exports.json` are always
      // present regardless of `format`; this just records the caller's intent.
      requested_format: format,
      exports: result.exports,
    });
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : 'unknown', requestId },
      'CPE log export failed',
    );
    res.status(500).json({ error: 'Failed to generate CPE compliance log', request_id: requestId });
  }
});

export { router as cpeLogExportRouter };
