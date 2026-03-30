/**
 * VAI-01: AI Provenance Query Endpoint
 *
 * GET /api/v1/ai/provenance/:fingerprint — Queryable provenance chain:
 *   Source Document → AI Extraction → Blockchain Anchor
 *
 * Returns the complete audit trail for a document's AI extraction:
 * - Source hash (fingerprint)
 * - AI model identity + version
 * - Extracted fields + confidence scores
 * - Manifest hash (cryptographic binding)
 * - Linked anchor details (chain TX, block height, status)
 */

import { Router, Request, Response } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

/** GET /api/v1/ai/provenance/:fingerprint */
router.get('/:fingerprint', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { fingerprint } = req.params;
  if (!fingerprint || !/^[a-f0-9]{64}$/i.test(fingerprint)) {
    res.status(400).json({ error: 'Invalid fingerprint — must be 64-char hex SHA-256' });
    return;
  }

  try {
    // Get user's org for RLS-compatible query scope
    const { data: profile } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single();

    const orgId = profile?.org_id;

    // Fetch extraction manifests for this fingerprint
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: manifests, error: manifestError } = await (db as any)
      .from('extraction_manifests')
      .select('id, fingerprint, model_id, model_version, extracted_fields, confidence_scores, manifest_hash, anchor_id, extraction_timestamp, prompt_version, created_at')
      .eq('fingerprint', fingerprint.toLowerCase())
      .order('created_at', { ascending: false })
      .limit(10);

    if (manifestError) {
      logger.error({ error: manifestError, fingerprint }, 'Failed to query extraction manifests');
      res.status(500).json({ error: 'Failed to query provenance data' });
      return;
    }

    if (!manifests || manifests.length === 0) {
      res.status(404).json({
        error: 'not_found',
        message: 'No extraction manifests found for this fingerprint',
      });
      return;
    }

    // Verify user has access (must be in same org or own the manifest)
    const firstManifest = manifests[0];
    if (firstManifest.org_id && orgId && firstManifest.org_id !== orgId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Fetch linked anchor details for all manifest anchor_ids
    const anchorIds = manifests
      .map((m: { anchor_id?: string }) => m.anchor_id)
      .filter(Boolean) as string[];

    let anchors: Record<string, unknown>[] = [];
    if (anchorIds.length > 0) {
      const { data: anchorData } = await db
        .from('anchors')
        .select('id, public_id, fingerprint, status, chain_tx_id, chain_block_height, chain_timestamp, credential_type, created_at')
        .in('id', anchorIds);

      if (anchorData) {
        anchors = anchorData as unknown as Record<string, unknown>[];
      }
    }

    // Build provenance chain response
    const anchorMap = new Map(anchors.map((a) => [a.id as string, a]));

    const provenanceChain = manifests.map((m: Record<string, unknown>) => {
      const linkedAnchor = m.anchor_id ? anchorMap.get(m.anchor_id as string) : null;

      return {
        // Source
        sourceHash: m.fingerprint,
        // AI Extraction
        extraction: {
          modelId: m.model_id,
          modelVersion: m.model_version,
          extractedFields: m.extracted_fields,
          confidenceScores: m.confidence_scores,
          manifestHash: m.manifest_hash,
          promptVersion: m.prompt_version,
          timestamp: m.extraction_timestamp,
        },
        // Blockchain Anchor (if linked)
        anchor: linkedAnchor ? {
          publicId: linkedAnchor.public_id,
          status: linkedAnchor.status,
          networkReceipt: linkedAnchor.chain_tx_id,
          blockHeight: linkedAnchor.chain_block_height,
          blockTimestamp: linkedAnchor.chain_timestamp,
          credentialType: linkedAnchor.credential_type,
          anchoredAt: linkedAnchor.created_at,
        } : null,
      };
    });

    res.json({
      fingerprint: fingerprint.toLowerCase(),
      manifestCount: manifests.length,
      provenanceChain,
    });
  } catch (err) {
    logger.error({ error: err, fingerprint }, 'AI provenance query failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as aiProvenanceRouter };
