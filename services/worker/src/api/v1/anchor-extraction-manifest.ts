import { Router, Request, Response } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

router.get('/:publicId/extraction-manifest', async (req: Request, res: Response) => {
  const { publicId } = req.params;

  if (!publicId || publicId.length < 3) {
    res.status(400).json({ error: 'Invalid anchor ID' });
    return;
  }

  try {
    const { data: anchor, error: anchorError } = await dbAny
      .from('anchors')
      .select('fingerprint')
      .eq('public_id', publicId)
      .single();

    if (anchorError || !anchor) {
      res.status(404).json({ error: 'Anchor not found' });
      return;
    }

    const { data: manifests, error: manifestError } = await dbAny
      .from('extraction_manifests')
      .select('fingerprint, model_id, model_version, extracted_fields, confidence_scores, manifest_hash, prompt_version, extraction_timestamp, zk_proof, zk_circuit_version')
      .eq('fingerprint', anchor.fingerprint)
      .order('extraction_timestamp', { ascending: false })
      .limit(1);

    if (manifestError) {
      logger.error({ error: manifestError, publicId }, 'Extraction manifest query failed');
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    if (!manifests || manifests.length === 0) {
      res.status(404).json({ error: 'No extraction manifest found for this anchor' });
      return;
    }

    const m = manifests[0] as Record<string, unknown>;

    res.json({
      public_id: publicId,
      manifest: {
        fingerprint: m.fingerprint,
        model_id: m.model_id,
        model_version: m.model_version,
        extracted_fields: m.extracted_fields,
        confidence_scores: m.confidence_scores,
        manifest_hash: m.manifest_hash,
        prompt_version: m.prompt_version,
        extraction_timestamp: m.extraction_timestamp,
        zk_proof: m.zk_proof ?? null,
        zk_circuit_version: m.zk_circuit_version ?? null,
      },
    });
  } catch (error) {
    logger.error({ error, publicId }, 'Extraction manifest lookup failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as anchorExtractionManifestRouter };
