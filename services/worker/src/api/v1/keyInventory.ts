/**
 * Key Inventory API (COMP-05)
 *
 * GET /api/v1/signatures/key-inventory
 *
 * Returns a masked inventory of cryptographic keys for audit purposes.
 * Never exposes raw key material, ARNs, or resource paths (Constitution 1.4).
 *
 * Accessible to: admin, owner, compliance_officer roles only.
 */

import { Router, Request, Response } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';

const router = Router();

interface KeyInventoryEntry {
  key_id_masked: string;
  algorithm: string;
  purpose: string;
  provider: string;
  created_date: string | null;
  last_rotation_date: string | null;
  status: 'active' | 'pending_rotation' | 'retired';
}

/**
 * Mask a key ID for audit display.
 * Shows first 4 and last 4 characters, masking the middle.
 */
function maskKeyId(keyId: string): string {
  if (keyId.length <= 8) return '****';
  return `${keyId.slice(0, 4)}${'*'.repeat(Math.min(keyId.length - 8, 16))}${keyId.slice(-4)}`;
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.authUserId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Verify admin/compliance role
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

    // Build key inventory from configuration (never from actual key material)
    const inventory: KeyInventoryEntry[] = [];

    // Bitcoin signing key
    const kmsProvider = config.kmsProvider || 'local';
    if (kmsProvider === 'gcp') {
      inventory.push({
        key_id_masked: config.gcpKmsKeyResourceName ? maskKeyId(config.gcpKmsKeyResourceName) : '****',
        algorithm: 'ECDSA secp256k1',
        purpose: 'Network anchor signing',
        provider: 'GCP Cloud KMS',
        created_date: null,
        last_rotation_date: null,
        status: 'active',
      });
    } else if (kmsProvider === 'aws') {
      inventory.push({
        key_id_masked: config.bitcoinKmsKeyId ? maskKeyId(config.bitcoinKmsKeyId) : '****',
        algorithm: 'ECDSA secp256k1',
        purpose: 'Network anchor signing',
        provider: 'AWS KMS',
        created_date: null,
        last_rotation_date: null,
        status: 'active',
      });
    } else {
      inventory.push({
        key_id_masked: '****local****',
        algorithm: 'ECDSA secp256k1',
        purpose: 'Network anchor signing',
        provider: 'Local key (development)',
        created_date: null,
        last_rotation_date: null,
        status: 'active',
      });
    }

    // API key HMAC secret
    inventory.push({
      key_id_masked: '****hmac****',
      algorithm: 'HMAC-SHA256',
      purpose: 'API key verification',
      provider: 'Environment variable',
      created_date: null,
      last_rotation_date: null,
      status: config.apiKeyHmacSecret ? 'active' : 'pending_rotation',
    });

    // Webhook signing secret (per-endpoint, summarized)
    const { count } = await db
      .from('webhook_endpoints')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', membership.org_id)
      .eq('is_active', true);

    if (count && count > 0) {
      inventory.push({
        key_id_masked: '****webhook****',
        algorithm: 'HMAC-SHA256',
        purpose: 'Webhook payload signing',
        provider: 'Per-endpoint secrets',
        created_date: null,
        last_rotation_date: null,
        status: 'active',
      });
    }

    // 'COMPLIANCE' isn't in audit_events.event_category enum (migration 0006);
    // ADMIN is the closest match. target_type replaces the legacy resource_type.
    await db.from('audit_events').insert({
      event_type: 'KEY_INVENTORY_ACCESSED',
      event_category: 'ADMIN',
      org_id: membership.org_id,
      actor_id: userId,
      target_type: 'compliance',
      details: JSON.stringify({ key_count: inventory.length }),
    });

    res.json({
      inventory,
      total_keys: inventory.length,
      generated_at: new Date().toISOString(),
      note: 'Key material is never exposed. Contact security@arkova.ai for key ceremony records.',
    });
  } catch (err) {
    logger.error({
      error: err instanceof Error ? err.message : String(err),
    }, 'Key inventory request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as keyInventoryRouter };
