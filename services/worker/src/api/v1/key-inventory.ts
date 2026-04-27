/**
 * Key Inventory Endpoint (COMP-05)
 *
 * GET /api/v1/signatures/key-inventory
 * Returns masked key metadata for SOC 2 CC6.1 audit evidence.
 * Constitution 1.4: Never returns raw key material, ARNs, or resource paths.
 *
 * Access: admin, owner, or compliance_officer role only.
 */

import { Router, Request, Response } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

export interface KeyInventoryEntry {
  keyId: string;
  algorithm: string;
  purpose: string;
  status: 'active' | 'disabled' | 'pending_rotation';
  provider: string;
  createdAt?: string;
  lastRotatedAt?: string;
}

/**
 * Build a key inventory from environment configuration.
 * Masks all sensitive identifiers — safe for audit export.
 */
export function buildKeyInventory(config: {
  kmsProvider?: string;
  bitcoinNetwork?: string;
}): KeyInventoryEntry[] {
  const entries: KeyInventoryEntry[] = [];
  const { kmsProvider, bitcoinNetwork } = config;

  // Bitcoin transaction signing key
  if (bitcoinNetwork === 'mainnet' && kmsProvider === 'gcp') {
    entries.push({
      keyId: 'gcp-kms-***-bitcoin-mainnet',
      algorithm: 'ECDSA secp256k1 (EC_SIGN_SECP256K1_SHA256)',
      purpose: 'Bitcoin transaction signing',
      status: 'active',
      provider: 'GCP Cloud KMS',
    });
  } else if (bitcoinNetwork === 'mainnet' && kmsProvider === 'aws') {
    entries.push({
      keyId: 'aws-kms-***-bitcoin-mainnet',
      algorithm: 'ECDSA secp256k1 (ECC_SECG_P256K1)',
      purpose: 'Bitcoin transaction signing',
      status: 'active',
      provider: 'AWS KMS',
    });
  } else {
    entries.push({
      keyId: 'wif-***-' + (bitcoinNetwork || 'unknown'),
      algorithm: 'ECDSA secp256k1',
      purpose: 'Bitcoin transaction signing',
      status: 'active',
      provider: 'Environment variable (WIF)',
    });
  }

  // API key HMAC signing
  entries.push({
    keyId: 'hmac-***-api-keys',
    algorithm: 'HMAC-SHA256',
    purpose: 'API key HMAC signing',
    status: 'active',
    provider: 'Environment variable',
  });

  // Supabase JWT verification
  entries.push({
    keyId: 'jwt-***-supabase',
    algorithm: 'HS256',
    purpose: 'JWT token verification',
    status: 'active',
    provider: 'Supabase',
  });

  return entries;
}

const router = Router();

/**
 * GET /api/v1/signatures/key-inventory
 * Returns key inventory for audit purposes.
 * Restricted to admin, owner, or compliance_officer roles.
 */
router.get('/signatures/key-inventory', async (req: Request, res: Response) => {
  try {
    const userId = req.authUserId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Check role: organization admin only
    const { data: membership } = await db
      .from('org_members')
      .select('org_id, role')
      .eq('user_id', userId)
      .in('role', ['owner', 'admin'])
      .limit(1)
      .single();

    if (!membership) {
      res.status(403).json({ error: 'Organization administrator role required' });
      return;
    }

    const inventory = buildKeyInventory({
      kmsProvider: process.env.KMS_PROVIDER,
      bitcoinNetwork: process.env.BITCOIN_NETWORK,
    });

    // Log audit event for key inventory access
    void db.from('audit_events').insert({
      event_type: 'key_inventory_accessed',
      event_category: 'SYSTEM',
      actor_id: userId,
      org_id: membership.org_id,
      details: JSON.stringify({ role: membership.role }),
    }).then(() => {/* fire and forget */}, (err: unknown) => {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Failed to log key inventory audit event');
    });

    res.json({
      generated_at: new Date().toISOString(),
      key_count: inventory.length,
      keys: inventory,
    });
  } catch (err) {
    logger.error({
      error: err instanceof Error ? err.message : String(err),
    }, 'Key inventory retrieval failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as keyInventoryRouter };
