/**
 * Compliance Check Endpoint (Phase 1.5)
 *
 * POST /api/v1/compliance/check
 *
 * Checks an entity against regulatory records, SEC filings, and attestations.
 * Returns compliance status with supporting evidence from anchored records.
 *
 * Pricing: $0.01 per request (x402)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

const router = Router();

const ComplianceCheckSchema = z.object({
  entity_name: z.string().min(1).max(200),
  entity_type: z.enum(['individual', 'organization']).default('organization'),
  check_types: z.array(z.enum([
    'sec_filings',
    'sanctions',
    'regulatory_actions',
    'attestations',
    'all',
  ])).default(['all']),
  jurisdiction: z.string().max(100).optional(),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = ComplianceCheckSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { entity_name, entity_type, check_types, jurisdiction } = parsed.data;
  const checkAll = check_types.includes('all');
  const sanitizedName = entity_name.replace(/[%_]/g, '');

  try {
    const findings: Array<{
      category: string;
      severity: 'info' | 'warning' | 'critical';
      source: string;
      title: string;
      date: string | null;
      source_url: string | null;
      anchor_status: string | null;
    }> = [];

    // 1. SEC filings check
    if (checkAll || check_types.includes('sec_filings')) {
      const { data: secRecords } = await dbAny
        .from('public_records')
        .select('id, title, source_url, record_type, metadata, created_at')
        .eq('source', 'edgar')
        .ilike('title', `%${sanitizedName}%`)
        .order('created_at', { ascending: false })
        .limit(20);

      for (const rec of secRecords ?? []) {
        findings.push({
          category: 'sec_filing',
          severity: 'info',
          source: 'SEC EDGAR',
          title: rec.title ?? 'SEC Filing',
          date: rec.created_at,
          source_url: rec.source_url,
          anchor_status: null,
        });
      }
    }

    // 2. Regulatory actions check
    if (checkAll || check_types.includes('regulatory_actions')) {
      const { data: regRecords } = await dbAny
        .from('public_records')
        .select('id, title, source_url, record_type, metadata, created_at')
        .eq('source', 'federal_register')
        .ilike('title', `%${sanitizedName}%`)
        .order('created_at', { ascending: false })
        .limit(20);

      for (const rec of regRecords ?? []) {
        const recType = rec.record_type as string;
        findings.push({
          category: 'regulatory_action',
          severity: recType === 'rule' ? 'warning' : 'info',
          source: 'Federal Register',
          title: rec.title ?? 'Regulatory Document',
          date: rec.created_at,
          source_url: rec.source_url,
          anchor_status: null,
        });
      }
    }

    // 3. Attestations check
    if (checkAll || check_types.includes('attestations')) {
      const { data: attestations } = await dbAny
        .from('attestations')
        .select('id, public_id, attestation_type, subject_identifier, attester_name, status, claims, created_at')
        .ilike('subject_identifier', `%${sanitizedName}%`)
        .order('created_at', { ascending: false })
        .limit(20);

      for (const att of attestations ?? []) {
        findings.push({
          category: 'attestation',
          severity: att.status === 'REVOKED' ? 'critical' : 'info',
          source: `Attestation by ${att.attester_name}`,
          title: `${att.attestation_type}: ${att.subject_identifier}`,
          date: att.created_at,
          source_url: null,
          anchor_status: att.status,
        });
      }
    }

    // Compute risk score
    const criticalCount = findings.filter(f => f.severity === 'critical').length;
    const warningCount = findings.filter(f => f.severity === 'warning').length;
    let risk_level: 'low' | 'medium' | 'high' = 'low';
    if (criticalCount > 0) risk_level = 'high';
    else if (warningCount > 2) risk_level = 'medium';

    res.json({
      entity: {
        name: entity_name,
        type: entity_type,
        jurisdiction: jurisdiction ?? null,
      },
      compliance_status: risk_level === 'low' ? 'clear' : 'review_required',
      risk_level,
      total_findings: findings.length,
      findings_by_severity: {
        critical: criticalCount,
        warning: warningCount,
        info: findings.filter(f => f.severity === 'info').length,
      },
      findings,
      checked_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ error: err }, 'compliance-check: unexpected error');
    res.status(500).json({ error: 'Compliance check failed' });
  }
});

export { router as complianceCheckRouter };
