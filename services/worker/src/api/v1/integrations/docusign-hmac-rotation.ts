/**
 * SCRUM-2043 — HMAC key rotation logic for DocuSign Connect (SOC 2 CC6.1).
 *
 * Pure functions with DI — same pattern as reconciliation/nonce-sweep.
 * Two operations:
 *   1. rotateHmacKey — generates a new key and appends it (max 2).
 *   2. retireHmacKey — removes an old key by created_at timestamp.
 */

import crypto from 'node:crypto';
import { logger } from '../../../utils/logger.js';

export interface HmacKeyEntry {
  key: string;
  created_at: string;
  label?: string;
}

export interface IntegrationRow {
  id: string;
  org_id: string;
  account_id: string;
  hmac_keys: HmacKeyEntry[] | null;
}

export interface RotationDeps {
  getIntegration(integrationId: string): Promise<IntegrationRow | null>;
  updateHmacKeys(integrationId: string, keys: HmacKeyEntry[]): Promise<{ error: unknown }>;
  generateKey?(): string;
  now?(): Date;
}

const MAX_HMAC_KEYS = 2;

export interface RotateResult {
  ok: boolean;
  new_key?: string;
  total_keys?: number;
  error?: string;
}

export interface RetireResult {
  ok: boolean;
  remaining_keys?: number;
  error?: string;
}

export async function rotateHmacKey(
  args: { orgId: string; integrationId: string },
  deps: RotationDeps,
): Promise<RotateResult> {
  const integration = await deps.getIntegration(args.integrationId);
  if (!integration) {
    return { ok: false, error: 'integration_not_found' };
  }
  if (integration.org_id !== args.orgId) {
    return { ok: false, error: 'org_mismatch' };
  }

  const existing = integration.hmac_keys ?? [];
  if (existing.length >= MAX_HMAC_KEYS) {
    return { ok: false, error: 'max_keys_reached' };
  }

  const generate = deps.generateKey ?? (() => crypto.randomBytes(32).toString('base64'));
  const now = (deps.now?.() ?? new Date());
  const newKey = generate();
  const label = `rotated-${now.toISOString().slice(0, 10)}`;

  const updated = [
    ...existing,
    { key: newKey, created_at: now.toISOString(), label },
  ];

  const { error } = await deps.updateHmacKeys(args.integrationId, updated);
  if (error) {
    const msg = typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: string }).message)
      : String(error);
    logger.error({ integrationId: args.integrationId, error: msg }, 'HMAC key rotation DB update failed');
    return { ok: false, error: `update_failed: ${msg}` };
  }

  return { ok: true, new_key: newKey, total_keys: updated.length };
}

export async function retireHmacKey(
  args: { orgId: string; integrationId: string; retireCreatedAt: string },
  deps: RotationDeps,
): Promise<RetireResult> {
  const integration = await deps.getIntegration(args.integrationId);
  if (!integration) {
    return { ok: false, error: 'integration_not_found' };
  }
  if (integration.org_id !== args.orgId) {
    return { ok: false, error: 'org_mismatch' };
  }

  const existing = integration.hmac_keys;
  if (!existing || existing.length === 0) {
    return { ok: false, error: 'no_keys_configured' };
  }

  const targetIndex = existing.findIndex((e) => e.created_at === args.retireCreatedAt);
  if (targetIndex === -1) {
    return { ok: false, error: 'key_not_found' };
  }

  const remaining = existing.filter((_, i) => i !== targetIndex);
  if (remaining.length === 0) {
    return { ok: false, error: 'cannot_retire_last_key' };
  }

  const { error } = await deps.updateHmacKeys(args.integrationId, remaining);
  if (error) {
    const msg = typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: string }).message)
      : String(error);
    logger.error({ integrationId: args.integrationId, error: msg }, 'HMAC key retire DB update failed');
    return { ok: false, error: `update_failed: ${msg}` };
  }

  return { ok: true, remaining_keys: remaining.length };
}
