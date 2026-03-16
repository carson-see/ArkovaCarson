/**
 * AI Reports Endpoint (P8-S16)
 *
 * POST /api/v1/ai/reports — Create and generate a report
 * GET  /api/v1/ai/reports — List reports for org
 * GET  /api/v1/ai/reports/:reportId — Get a single report
 */

import { Router, Request, Response } from 'express';
import {
  CreateReportSchema,
  createReport,
  generateReport,
  listReports,
  getReport,
} from '../../ai/report-generator.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// POST / — Create and generate a report
router.post('/', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const parsed = CreateReportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_error', details: parsed.error.issues });
    return;
  }

  try {
    const { data: profile } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single();

    if (!profile?.org_id) {
      res.status(403).json({ error: 'Organization membership required' });
      return;
    }

    const reportId = await createReport(
      profile.org_id,
      userId,
      parsed.data.reportType,
      parsed.data.title,
      parsed.data.parameters ?? {},
    );

    if (!reportId) {
      res.status(500).json({ error: 'Failed to create report' });
      return;
    }

    // Generate in background (non-blocking)
    generateReport(reportId).catch((err) => {
      logger.error({ error: err, reportId }, 'Background report generation failed');
    });

    res.status(201).json({ reportId, status: 'QUEUED' });
  } catch (err) {
    logger.error({ error: err }, 'Failed to create report');
    res.status(500).json({ error: 'Failed to create report' });
  }
});

// GET / — List reports
router.get('/', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const { data: profile } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single();

    if (!profile?.org_id) {
      res.status(403).json({ error: 'Organization membership required' });
      return;
    }

    const limit = Math.max(0, parseInt(req.query.limit as string, 10) || 20);
    const offset = Math.max(0, parseInt(req.query.offset as string, 10) || 0);

    const reports = await listReports(profile.org_id, Math.min(limit, 100), offset);
    res.json({ reports });
  } catch (err) {
    logger.error({ error: err }, 'Failed to list reports');
    res.status(500).json({ error: 'Failed to list reports' });
  }
});

// GET /:reportId — Get single report
router.get('/:reportId', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { reportId } = req.params;
  if (!reportId) {
    res.status(400).json({ error: 'reportId is required' });
    return;
  }

  try {
    // Get profile org FIRST, then do org-scoped lookup
    const { data: profile } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single();

    if (!profile?.org_id) {
      res.status(403).json({ error: 'Organization membership required' });
      return;
    }

    const report = await getReport(reportId);
    // Return 404 for any not-found OR unauthorized — avoids leaking existence
    if (!report || report.orgId !== profile.org_id) {
      res.status(404).json({ error: 'Report not found' });
      return;
    }

    res.json(report);
  } catch (err) {
    logger.error({ error: err, reportId }, 'Failed to get report');
    res.status(500).json({ error: 'Failed to get report' });
  }
});

export { router as aiReportsRouter };
