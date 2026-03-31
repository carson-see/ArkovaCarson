/**
 * VAI-02: ZK Proof Verification Endpoint
 *
 * POST /api/v1/ai/zk-verify — Verify a stored ZK proof for an extraction manifest.
 * No feature gate — verification is always available even if proof generation is disabled.
 *
 * Accepts: { manifestHash: string } or { fingerprint: string }
 * Returns: { verified, proofProtocol, circuitVersion, verificationTimeMs, poseidonHash }
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { verifyZkProof } from '../../ai/zk-proof.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

const ZkVerifyRequestSchema = z.object({
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
}).refine(
  (data) => data.manifestHash || data.fingerprint,
  { message: 'Either manifestHash or fingerprint is required' },
);

router.post('/', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const parsed = ZkVerifyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'validation_error',
      message: parsed.error.errors[0]?.message ?? 'Invalid request',
    });
    return;
  }

  const { manifestHash, fingerprint } = parsed.data;

  try {
    // Look up manifest with ZK proof
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (db as any)
      .from('extraction_manifests')
      .select(
        'manifest_hash, fingerprint, zk_proof, zk_public_signals, zk_proof_protocol, zk_circuit_version, zk_poseidon_hash, zk_proof_generated_at, zk_proof_generation_ms',
      );

    if (manifestHash) {
      query = query.eq('manifest_hash', manifestHash);
    } else if (fingerprint) {
      query = query.eq('fingerprint', fingerprint);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      res.status(404).json({
        error: 'not_found',
        message: 'No extraction manifest found',
      });
      return;
    }

    // Check if ZK proof exists
    if (!data.zk_proof) {
      res.json({
        verified: false,
        reason: 'no_proof',
        message: 'No ZK proof has been generated for this manifest',
        manifestHash: data.manifest_hash,
        fingerprint: data.fingerprint,
      });
      return;
    }

    // Verify the proof
    const startMs = Date.now();
    const verified = await verifyZkProof(data.zk_proof, data.zk_public_signals);
    const verificationTimeMs = Date.now() - startMs;

    res.json({
      verified,
      proofProtocol: data.zk_proof_protocol,
      circuitVersion: data.zk_circuit_version,
      poseidonHash: data.zk_poseidon_hash,
      manifestHash: data.manifest_hash,
      fingerprint: data.fingerprint,
      proofGeneratedAt: data.zk_proof_generated_at,
      proofGenerationMs: data.zk_proof_generation_ms,
      verificationTimeMs,
    });
  } catch (err) {
    logger.error({ error: err, userId }, 'ZK proof verification failed');
    res.status(500).json({
      error: 'verification_failed',
      message: 'Failed to verify ZK proof',
    });
  }
});

export { router as aiZkVerifyRouter };
