/**
 * CLE Compliance-Log Export Endpoint (SCRUM-1870 — CLE-R2)
 *
 * POST /api/v1/exports/cle-log
 *
 * Body: { user_id, jurisdiction (US state code), period_start, period_end, format: 'pdf' | 'json' }
 *
 * Mounted behind the v1 router's `requireAuth` (Supabase JWT) middleware, so
 * `req.authUserId` is the authenticated subject. This handler then:
 *   1. Validates the body with Zod (400 + structured details on failure).
 *   2. Enforces org/user scope — a caller may only export THEIR OWN records
 *      (cross-user `user_id` → 403; no org membership → 403).
 *   3. Delegates to the export worker, which generates PDF + JSON for the
 *      requested jurisdiction, uploads to Storage, and returns signed URLs + a
 *      metadata-only audit event.
 *
 * Rate limit (Constitution 1.10): 10 requests / user / hour. The 11th within
 * the window returns 429 with a `Retry-After` header. Enforced by the mounted
 * `cleLogExportRateLimiter` (in-memory bucket keyed on the user id), in a
 * SEPARATE scope from the CPE limiter so the two exports don't share a budget.
 *
 * Both formats are always generated and returned (the AC requires a signed URL
 * for BOTH PDF and JSON); `format` records the caller's primary intent for the
 * audit trail and future single-format optimisation.
 *
 * Reuses the CPE export endpoint pattern (SCRUM-1848) verbatim — same auth,
 * scope, Zod-400, and rate-limit idioms — plus the required `jurisdiction`
 * param.
 */
import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { rateLimit } from '../../utils/rateLimit.js';
import {
  generateCleLogExport,
  createSupabaseStorageAdapter,
  normalizeJurisdiction,
} from '../../exports/cle-log-export.js';

const router = Router();

/**
 * Per-user hourly rate limiter. Exported so it can be mounted in the v1 router
 * (and exercised directly in tests). Window = 1 hour, max = 10 → the 11th
 * request in the hour 429s. The `scope` (`cle-log-export`) is what keeps this
 * bucket separate from the CPE limiter sharing the same user key — `rateLimit`
 * prefixes the final key with `${scope}:` (see utils/rateLimit.ts), so the
 * keyGenerator returns ONLY the user id; prefixing it again here would produce
 * a redundant `cle-log-export:cle-log-export:<user>` key.
 */
export const cleLogExportRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  maxRequests: 10,
  scope: 'cle-log-export',
  keyGenerator: (req: Request) => req.authUserId ?? req.ip ?? 'unknown',
});

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const ExportRequestSchema = z
  .object({
    user_id: z.string().min(1),
    jurisdiction: z
      .string()
      .min(1)
      .refine((v) => normalizeJurisdiction(v) !== null, {
        message: 'jurisdiction must be a US state code (e.g. "CA" or "US-CA")',
      }),
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
  const { user_id, jurisdiction, period_start, period_end, format } = parsed.data;

  // 3. Org/user scope. A caller may only export their own records.
  if (user_id !== userId) {
    res.status(403).json({
      error: 'You may only export your own compliance log',
      request_id: requestId,
    });
    return;
  }

  try {
    // Use maybeSingle() + capture the error: a DB/operational failure here is a
    // server error (500), NOT "no org membership" (403). single() throws on
    // 0-rows and the previous code dropped the error entirely, so any DB fault
    // was silently misclassified as a 403 (CodeRabbit — same bug as CPE sibling).
    const { data: profile, error: profileError } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .maybeSingle();

    if (profileError) {
      // Operational failure — log the message only (no PII), return a generic
      // 500 with the request id so the caller can't tell apart "no org" from
      // "DB down" and no DB internals leak.
      logger.error(
        { error: profileError.message, requestId },
        'CLE log export profile lookup failed',
      );
      res.status(500).json({ error: 'Failed to generate CLE compliance log', request_id: requestId });
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
    const result = await generateCleLogExport(
      {
        userId,
        orgId,
        jurisdiction,
        periodStart: period_start,
        periodEnd: period_end,
        requestId,
      },
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
      jurisdiction: result.jurisdiction,
      requested_format: format,
      exports: result.exports,
    });
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : 'unknown', requestId },
      'CLE log export failed',
    );
    res.status(500).json({ error: 'Failed to generate CLE compliance log', request_id: requestId });
  }
});

export { router as cleLogExportRouter };
