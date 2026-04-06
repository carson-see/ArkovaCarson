/**
 * Signature Compliance API Routes — Phase III
 *
 * GET  /api/v1/signatures/:id/audit-proof  — Per-signature audit proof package
 * GET  /api/v1/signatures/export           — Bulk export (JSON/CSV)
 * GET  /api/v1/signatures/soc2-evidence    — SOC 2 evidence bundle
 *
 * Story: PH3-ESIG-03 (SCRUM-424)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import {
  generateAuditProof,
  bulkExportSignatures,
  generateSoc2EvidenceBundle,
  generateGdprArticle30Export,
  generateEidasComplianceReport,
} from '../../signatures/compliance/auditProofExporter.js';

const router = Router();

/**
 * GET /api/v1/signatures/:id/audit-proof
 * Generate a comprehensive audit proof package for a signature.
 */
router.get('/signatures/:id/audit-proof', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const proof = await generateAuditProof(id);
    if (!proof) {
      res.status(404).json({ error: 'Signature not found' });
      return;
    }

    res.json(proof);
  } catch (err) {
    logger.error('Audit proof generation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/signatures/export
 * Bulk export signatures as JSON or CSV.
 */
router.get('/signatures/export', async (req: Request, res: Response) => {
  try {
    const userId = req.authUserId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const querySchema = z.object({
      format: z.enum(['json', 'csv']).default('json'),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      status: z.string().optional(),
    });

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid parameters', details: parsed.error.issues });
      return;
    }

    // Get user's org
    const { data: membership } = await db
      .from('org_members')
      .select('org_id')
      .eq('user_id', userId)
      .limit(1)
      .single();

    if (!membership) {
      res.status(403).json({ error: 'No organization membership found' });
      return;
    }

    const result = await bulkExportSignatures({
      orgId: membership.org_id,
      format: parsed.data.format,
      from: parsed.data.from,
      to: parsed.data.to,
      status: parsed.data.status,
    });

    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.data);
  } catch (err) {
    logger.error('Bulk export failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/signatures/soc2-evidence
 * Generate a SOC 2 evidence bundle for the signature subsystem.
 */
router.get('/signatures/soc2-evidence', async (req: Request, res: Response) => {
  try {
    const userId = req.authUserId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const querySchema = z.object({
      from: z.string().datetime(),
      to: z.string().datetime(),
    });

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'from and to date parameters required', details: parsed.error.issues });
      return;
    }

    // Get user's org
    const { data: membership } = await db
      .from('org_members')
      .select('org_id, role')
      .eq('user_id', userId)
      .in('role', ['owner', 'admin', 'compliance_officer'])
      .limit(1)
      .single();

    if (!membership) {
      res.status(403).json({ error: 'Admin, owner, or compliance officer role required for SOC 2 evidence' });
      return;
    }

    const bundle = await generateSoc2EvidenceBundle(
      membership.org_id,
      parsed.data.from,
      parsed.data.to,
    );

    res.json(bundle);
  } catch (err) {
    logger.error('SOC 2 evidence generation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/signatures/gdpr-article30
 * GDPR Article 30 Record of Processing Activities for the signature subsystem.
 */
router.get('/signatures/gdpr-article30', async (req: Request, res: Response) => {
  try {
    const userId = req.authUserId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { data: membership } = await db
      .from('org_members')
      .select('org_id, role')
      .eq('user_id', userId)
      .in('role', ['owner', 'admin', 'compliance_officer'])
      .limit(1)
      .single();

    if (!membership) {
      res.status(403).json({ error: 'Admin, owner, or compliance officer role required' });
      return;
    }

    const report = await generateGdprArticle30Export(membership.org_id);
    res.json(report);
  } catch (err) {
    logger.error('GDPR Article 30 export failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/signatures/eidas-report
 * eIDAS compliance report: qualified signatures, QTSP usage, certificate status.
 */
router.get('/signatures/eidas-report', async (req: Request, res: Response) => {
  try {
    const userId = req.authUserId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const querySchema = z.object({
      from: z.string().datetime(),
      to: z.string().datetime(),
    });

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'from and to date parameters required', details: parsed.error.issues });
      return;
    }

    const { data: membership } = await db
      .from('org_members')
      .select('org_id, role')
      .eq('user_id', userId)
      .in('role', ['owner', 'admin', 'compliance_officer'])
      .limit(1)
      .single();

    if (!membership) {
      res.status(403).json({ error: 'Admin, owner, or compliance officer role required' });
      return;
    }

    const report = await generateEidasComplianceReport(
      membership.org_id,
      parsed.data.from,
      parsed.data.to,
    );

    res.json(report);
  } catch (err) {
    logger.error('eIDAS compliance report failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as signatureComplianceRouter };
