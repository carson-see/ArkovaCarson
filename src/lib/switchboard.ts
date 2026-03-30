/**
 * Switchboard Feature Flags
 *
 * Client-side flag checking with server enforcement.
 * All production-sensitive flags are enforced server-side.
 */

import { supabase } from './supabase';

// =============================================================================
// FLAG DEFINITIONS
// =============================================================================

/**
 * Available switchboard flags with their defaults
 */
export const FLAGS = {
  ENABLE_PROD_NETWORK_ANCHORING: false,
  ENABLE_OUTBOUND_WEBHOOKS: false,
  ENABLE_NEW_CHECKOUTS: true,
  ENABLE_REPORTS: true,
  MAINTENANCE_MODE: false,
  ENABLE_BATCH_ANCHORING: false,
  ENABLE_AI_EXTRACTION: true,
  ENABLE_SEMANTIC_SEARCH: true,
  ENABLE_AI_FRAUD: true,
  ENABLE_AI_REPORTS: true,
  ENABLE_ATTESTATION_ANCHORING: true,
  ENABLE_PUBLIC_RECORDS_INGESTION: true,
  ENABLE_PUBLIC_RECORD_ANCHORING: true,
  ENABLE_PUBLIC_RECORD_EMBEDDINGS: true,
  ENABLE_VERIFICATION_API: true,
  ENABLE_X402_PAYMENTS: true,
} as const;

export type FlagId = keyof typeof FLAGS;

// =============================================================================
// FLAG CHECKING
// =============================================================================

// Track which flags have already logged an error to avoid console spam
const _flagErrorLogged = new Set<string>();

// In-memory flag cache with TTL to avoid RPC on every call
const FLAG_CACHE_TTL_MS = 30_000; // 30 seconds
const _flagCache = new Map<string, { value: boolean; expires: number }>();

/** @internal Test-only helper to reset cache between tests */
export function _clearCacheForTest(): void {
  _flagCache.clear();
  _flagErrorLogged.clear();
}

/**
 * Get a flag value from the server (cached for 30s to avoid RPC per call)
 */
export async function getFlag(flagId: FlagId): Promise<boolean> {
  // Check cache first
  const cached = _flagCache.get(flagId);
  if (cached && Date.now() < cached.expires) {
    return cached.value;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.rpc as any)('get_flag', {
      p_flag_key: flagId,
    });

    if (error) {
      // Log each flag error only once to avoid console spam when DB lacks the RPC
      if (!_flagErrorLogged.has(flagId)) {
        _flagErrorLogged.add(flagId);
        console.warn(`Switchboard: flag ${flagId} unavailable, using default (${FLAGS[flagId]})`);
      }
      const defaultVal = FLAGS[flagId];
      _flagCache.set(flagId, { value: defaultVal, expires: Date.now() + FLAG_CACHE_TTL_MS });
      return defaultVal;
    }

    // Clear error state on success (flag became available)
    _flagErrorLogged.delete(flagId);
    const val = data as boolean;
    _flagCache.set(flagId, { value: val, expires: Date.now() + FLAG_CACHE_TTL_MS });
    return val;
  } catch {
    const defaultVal = FLAGS[flagId];
    _flagCache.set(flagId, { value: defaultVal, expires: Date.now() + FLAG_CACHE_TTL_MS });
    return defaultVal;
  }
}

/**
 * Get all flags
 */
export async function getAllFlags(): Promise<Record<FlagId, boolean>> {
  // Use any to bypass type checking since new tables aren't in generated types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('switchboard_flags')
    .select('id, value');

  if (error) {
    console.error('Failed to fetch flags:', error);
    return { ...FLAGS } as Record<FlagId, boolean>;
  }

  const flags: Record<FlagId, boolean> = { ...FLAGS };

  for (const row of (data || []) as Array<{ id: string; value: boolean }>) {
    if (row.id in flags) {
      flags[row.id as FlagId] = row.value;
    }
  }

  return flags;
}

// =============================================================================
// FLAG GUARDS
// =============================================================================

/**
 * Check if production anchoring is enabled
 */
export async function isProdAnchoringEnabled(): Promise<boolean> {
  return getFlag('ENABLE_PROD_NETWORK_ANCHORING');
}

/**
 * Check if outbound webhooks are enabled
 */
export async function isOutboundWebhooksEnabled(): Promise<boolean> {
  return getFlag('ENABLE_OUTBOUND_WEBHOOKS');
}

/**
 * Check if new checkouts are enabled
 */
export async function isCheckoutsEnabled(): Promise<boolean> {
  return getFlag('ENABLE_NEW_CHECKOUTS');
}

/**
 * Check if reports are enabled
 */
export async function isReportsEnabled(): Promise<boolean> {
  return getFlag('ENABLE_REPORTS');
}

/**
 * Check if maintenance mode is active
 */
export async function isMaintenanceMode(): Promise<boolean> {
  return getFlag('MAINTENANCE_MODE');
}

/**
 * Check if batch anchoring is enabled (MVP-23)
 */
export async function isBatchAnchoringEnabled(): Promise<boolean> {
  return getFlag('ENABLE_BATCH_ANCHORING');
}

/**
 * Check if AI extraction is enabled (P8-S3)
 */
export async function isAIExtractionEnabled(): Promise<boolean> {
  return getFlag('ENABLE_AI_EXTRACTION');
}

/**
 * Check if semantic search is enabled (P8-S3)
 */
export async function isSemanticSearchEnabled(): Promise<boolean> {
  return getFlag('ENABLE_SEMANTIC_SEARCH');
}

/**
 * Check if AI fraud detection is enabled (P8-S3)
 */
export async function isAIFraudEnabled(): Promise<boolean> {
  return getFlag('ENABLE_AI_FRAUD');
}

// =============================================================================
// REALTIME FLAG HOT-RELOAD (DH-01)
// =============================================================================

import type { RealtimeChannel } from '@supabase/supabase-js';

let _flagChannel: RealtimeChannel | null = null;

/**
 * Subscribe to realtime flag changes so flag updates take effect without restart.
 * Calls the provided callback whenever a flag value changes.
 */
export function subscribeFlagChanges(
  onFlagChange: (flagId: FlagId, value: boolean) => void,
): void {
  // Clean up existing subscription
  unsubscribeFlagChanges();

  _flagChannel = supabase
    .channel('switchboard-flags-realtime')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'switchboard_flags' },
      (payload) => {
        const newRow = payload.new as { id?: string; value?: boolean } | undefined;
        if (!newRow?.id || typeof newRow.value !== 'boolean') return;
        // Only process known flags
        if (!(newRow.id in FLAGS)) return;
        // Invalidate cache on realtime update
        _flagCache.set(newRow.id, { value: newRow.value, expires: Date.now() + FLAG_CACHE_TTL_MS });
        onFlagChange(newRow.id as FlagId, newRow.value);
      },
    )
    .subscribe();
}

/**
 * Unsubscribe from realtime flag changes.
 */
export function unsubscribeFlagChanges(): void {
  if (_flagChannel) {
    supabase.removeChannel(_flagChannel);
    _flagChannel = null;
  }
}
