/**
 * VAI-03: AI Accountability Report — One-Click Provenance Export
 *
 * POST /api/v1/ai-accountability-report
 *
 * Generates a complete AI provenance report for a single anchor:
 *   [Source Hash] → [AI Model/Version] → [Human Override Log] → [On-Chain Anchor]
 *
 * Supports PDF (legally formatted) and JSON (structured appendix) formats.
 * Designed for litigation discovery and regulatory audit.
 */

import { Router, Request, Response } from 'express';
import { jsPDF } from 'jspdf';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';

const router = Router();

function getNetworkLabel(): string {
  return config.bitcoinNetwork === 'mainnet' ? 'Bitcoin Mainnet' : 'Bitcoin Signet (Test)';
}

/** POST /api/v1/ai-accountability-report */
router.post('/', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { anchorId, format = 'pdf' } = req.body as { anchorId?: string; format?: 'pdf' | 'json' };
  if (!anchorId) {
    res.status(400).json({ error: 'anchorId is required' });
    return;
  }

  try {
    // Get user's org
    const { data: profile } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single();

    const orgId = profile?.org_id;

    // Fetch anchor by public_id
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: anchor } = await (db as any)
      .from('anchors')
      .select('id, public_id, fingerprint, filename, credential_type, status, chain_tx_id, chain_block_height, chain_timestamp, metadata, compliance_controls, created_at')
      .eq('public_id', anchorId)
      .single();

    if (!anchor) {
      res.status(404).json({ error: 'Anchor not found' });
      return;
    }

    // Verify org access
    if (anchor.org_id && orgId && anchor.org_id !== orgId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Fetch extraction manifests for this fingerprint
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: manifests } = await (db as any)
      .from('extraction_manifests')
      .select('model_id, model_version, extracted_fields, confidence_scores, manifest_hash, extraction_timestamp, prompt_version')
      .eq('fingerprint', anchor.fingerprint)
      .order('created_at', { ascending: false })
      .limit(5);

    // Fetch audit events (lifecycle + human overrides)
    const { data: auditEvents } = await db
      .from('audit_events')
      .select('event_type, details, created_at')
      .eq('target_id', anchor.id)
      .order('created_at', { ascending: true })
      .limit(50);

    const metadata = (anchor.metadata ?? {}) as Record<string, unknown>;
    const latestManifest = manifests && manifests.length > 0 ? manifests[0] : null;

    // Build report data
    const reportData = {
      generatedAt: new Date().toISOString(),
      generatedBy: 'Arkova AI Accountability Report v1',
      network: getNetworkLabel(),
      document: {
        publicId: anchor.public_id,
        filename: anchor.filename,
        credentialType: anchor.credential_type,
        status: anchor.status,
        createdAt: anchor.created_at,
      },
      provenanceChain: {
        sourceHash: anchor.fingerprint,
        aiExtraction: latestManifest ? {
          modelId: latestManifest.model_id,
          modelVersion: latestManifest.model_version,
          extractedFields: latestManifest.extracted_fields,
          confidenceScores: latestManifest.confidence_scores,
          manifestHash: latestManifest.manifest_hash,
          promptVersion: latestManifest.prompt_version,
          extractionTimestamp: latestManifest.extraction_timestamp,
        } : null,
        blockchainAnchor: {
          networkReceipt: anchor.chain_tx_id,
          blockHeight: anchor.chain_block_height,
          blockTimestamp: anchor.chain_timestamp,
          metadataHash: metadata._metadata_hash ?? null,
          extractionManifestHash: metadata._extraction_manifest_hash ?? null,
        },
      },
      complianceControls: anchor.compliance_controls ?? [],
      lifecycleEvents: auditEvents ?? [],
      disclaimers: [
        'This report is generated from immutable data stored on-chain and in the Arkova system.',
        'Source document fingerprints are SHA-256 hashes and cannot be reversed to reveal document contents.',
        'AI extraction confidence scores reflect model calibration at the time of extraction.',
        'Blockchain timestamps reflect network-observed time, not necessarily document creation time.',
        'This report is provided for audit and compliance purposes only.',
      ],
    };

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="accountability-report-${anchor.public_id}.json"`);
      res.json(reportData);
      return;
    }

    // Generate PDF
    const doc = new jsPDF();
    let y = 20;

    // Title
    doc.setFontSize(18);
    doc.text('AI Accountability Report', 105, y, { align: 'center' });
    y += 8;
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text('Arkova Computational Integrity Report', 105, y, { align: 'center' });
    y += 5;
    doc.text(`Generated: ${new Date().toISOString()}`, 105, y, { align: 'center' });
    y += 10;
    doc.setTextColor(0);

    // Section: Document Information
    doc.setFontSize(13);
    doc.text('1. Document Information', 14, y);
    y += 7;
    doc.setFontSize(9);
    const docInfo = [
      ['Verification ID', anchor.public_id],
      ['Filename', anchor.filename ?? 'N/A'],
      ['Credential Type', anchor.credential_type ?? 'N/A'],
      ['Status', anchor.status],
      ['Network', getNetworkLabel()],
      ['Created', anchor.created_at],
    ];
    for (const [label, value] of docInfo) {
      doc.setFont('helvetica', 'bold');
      doc.text(`${label}:`, 16, y);
      doc.setFont('helvetica', 'normal');
      doc.text(String(value), 55, y);
      y += 5;
    }
    y += 5;

    // Section: Cryptographic Proof
    doc.setFontSize(13);
    doc.text('2. Cryptographic Proof', 14, y);
    y += 7;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text('Source Fingerprint (SHA-256):', 16, y);
    y += 5;
    doc.setFont('courier', 'normal');
    doc.setFontSize(7);
    doc.text(anchor.fingerprint, 16, y);
    y += 6;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);

    if (anchor.chain_tx_id) {
      doc.setFont('helvetica', 'bold');
      doc.text('Network Receipt:', 16, y);
      doc.setFont('courier', 'normal');
      doc.setFontSize(7);
      doc.text(anchor.chain_tx_id, 55, y);
      y += 5;
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
    }
    if (anchor.chain_block_height) {
      doc.text(`Block Height: ${anchor.chain_block_height}`, 16, y);
      y += 5;
    }
    if (anchor.chain_timestamp) {
      doc.text(`Block Timestamp: ${anchor.chain_timestamp}`, 16, y);
      y += 5;
    }
    y += 5;

    // Section: AI Provenance Chain
    doc.setFontSize(13);
    doc.text('3. AI Provenance Chain', 14, y);
    y += 7;
    doc.setFontSize(9);

    if (latestManifest) {
      const aiInfo = [
        ['AI Model', `${latestManifest.model_id} (${latestManifest.model_version})`],
        ['Overall Confidence', `${((latestManifest.confidence_scores?.overall ?? 0) * 100).toFixed(1)}%`],
        ['Grounding Score', latestManifest.confidence_scores?.grounding
          ? `${(latestManifest.confidence_scores.grounding * 100).toFixed(1)}%`
          : 'N/A'],
        ['Manifest Hash', latestManifest.manifest_hash],
        ['Extraction Time', latestManifest.extraction_timestamp],
        ['Prompt Version', latestManifest.prompt_version ?? 'N/A'],
      ];
      for (const [label, value] of aiInfo) {
        doc.setFont('helvetica', 'bold');
        doc.text(`${label}:`, 16, y);
        doc.setFont('helvetica', 'normal');
        if (label === 'Manifest Hash') {
          doc.setFont('courier', 'normal');
          doc.setFontSize(7);
          doc.text(String(value), 55, y);
          doc.setFontSize(9);
          doc.setFont('helvetica', 'normal');
        } else {
          doc.text(String(value), 55, y);
        }
        y += 5;
      }

      // Extracted fields
      y += 3;
      doc.setFont('helvetica', 'bold');
      doc.text('Extracted Fields:', 16, y);
      y += 5;
      doc.setFont('helvetica', 'normal');
      const fields = latestManifest.extracted_fields as Record<string, unknown> ?? {};
      for (const [key, value] of Object.entries(fields)) {
        if (value !== null && value !== undefined) {
          doc.text(`  ${key}: ${String(value)}`, 18, y);
          y += 4;
          if (y > 270) {
            doc.addPage();
            y = 20;
          }
        }
      }
    } else {
      doc.text('No AI extraction manifest found for this document.', 16, y);
      y += 5;
    }
    y += 5;

    // Check for page break
    if (y > 240) {
      doc.addPage();
      y = 20;
    }

    // Section: Lifecycle Timeline
    doc.setFontSize(13);
    doc.text('4. Lifecycle Timeline', 14, y);
    y += 7;
    doc.setFontSize(9);
    const events = auditEvents ?? [];
    if (events.length === 0) {
      doc.text('No lifecycle events recorded.', 16, y);
      y += 5;
    } else {
      for (const event of events) {
        const eventData = event as { event_type: string; details: string; created_at: string };
        doc.setFont('helvetica', 'bold');
        doc.text(`${eventData.created_at}`, 16, y);
        doc.setFont('helvetica', 'normal');
        doc.text(`${eventData.event_type}: ${eventData.details ?? ''}`, 60, y);
        y += 5;
        if (y > 270) {
          doc.addPage();
          y = 20;
        }
      }
    }
    y += 5;

    // Section: Disclaimers
    if (y > 250) {
      doc.addPage();
      y = 20;
    }
    doc.setFontSize(13);
    doc.text('5. Disclaimers', 14, y);
    y += 7;
    doc.setFontSize(8);
    doc.setTextColor(80);
    for (const disclaimer of reportData.disclaimers) {
      const lines = doc.splitTextToSize(disclaimer, 180);
      doc.text(lines, 16, y);
      y += lines.length * 4 + 2;
    }

    // Output PDF
    const pdfBuffer = Buffer.from(doc.output('arraybuffer'));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="accountability-report-${anchor.public_id}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    logger.error({ error: err, anchorId }, 'AI accountability report generation failed');
    res.status(500).json({ error: 'Report generation failed' });
  }
});

export { router as aiAccountabilityReportRouter };
