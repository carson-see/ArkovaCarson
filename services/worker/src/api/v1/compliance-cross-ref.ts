/**
 * Cross-Reference API (NCE-15)
 *
 * POST /api/v1/compliance/cross-reference
 *
 * Jira: SCRUM-606
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { crossReferenceDocuments, type CrossRefAnchor } from '../../compliance/cross-reference.js';
import { getCallerOrgId } from '../../compliance/auth-helpers.js';

const router = Router();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

const CrossRefSchema = z.object({
  anchor_ids: z.array(z.string().uuid()).min(2).max(100),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = CrossRefSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { anchor_ids } = parsed.data;

  try {
    const orgId = await getCallerOrgId(req, res);
    if (!orgId) return;

    const { data: anchors, error } = await dbAny
      .from('anchors')
      .select('id, credential_type, title, extracted_metadata, org_id')
      .eq('org_id', orgId)
      .in('id', anchor_ids);

    if (error) {
      logger.error({ error }, 'Failed to load anchors for cross-reference');
      res.status(500).json({ error: 'Failed to load documents' });
      return;
    }

    if (!anchors || anchors.length === 0) {
      res.status(404).json({ error: 'No matching anchors found in your organization' });
      return;
    }

    const crossRefAnchors: CrossRefAnchor[] = anchors.map((a: Record<string, unknown>) => {
      const meta = (a.extracted_metadata as Record<string, unknown>) ?? {};
      return {
        id: a.id as string,
        credential_type: (a.credential_type as string) ?? 'OTHER',
        title: (a.title as string) ?? null,
        extracted_name: (meta.holder_name as string) ?? (meta.name as string) ?? null,
        extracted_date: (meta.issue_date as string) ?? (meta.date as string) ?? null,
        jurisdiction: (meta.jurisdiction as string) ?? (meta.state as string) ?? null,
        org_id: a.org_id as string,
      };
    });

    const result = crossReferenceDocuments(crossRefAnchors);

    res.json({
      ...result,
      anchor_ids_requested: anchor_ids.length,
      anchor_ids_found: anchors.length,
    });
  } catch (err) {
    logger.error({ error: err }, 'Unexpected error in cross-reference');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as complianceCrossRefRouter };
