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
  ENABLE_ISSUE_CREDENTIAL_SPLIT: false,
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
    const val = await fetchFlagFromRpc(flagId);
    // Clear error state on success (flag became available)
    _flagErrorLogged.delete(flagId);
    _flagCache.set(flagId, { value: val, expires: Date.now() + FLAG_CACHE_TTL_MS });
    return val;
  } catch {
    const defaultVal = FLAGS[flagId];
    // Log each flag error only once to avoid console spam when DB lacks the RPC
    if (!_flagErrorLogged.has(flagId)) {
      _flagErrorLogged.add(flagId);
      console.warn(`Switchboard: flag ${flagId} unavailable, using default (${defaultVal})`);
    }
    _flagCache.set(flagId, { value: defaultVal, expires: Date.now() + FLAG_CACHE_TTL_MS });
    return defaultVal;
  }
}

async function fetchFlagFromRpc(flagId: FlagId): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('get_flag', {
    p_flag_key: flagId,
  });
  if (error) throw error;
  return data as boolean;
}

/**
 * Get a flag value and reject on lookup failure. Use this only when a caller
 * has a product-specific fail-closed fallback; most flags should keep the
 * defaulting behavior in `getFlag`.
 */
export async function getFlagStrict(flagId: FlagId): Promise<boolean> {
  const val = await fetchFlagFromRpc(flagId);
  _flagErrorLogged.delete(flagId);
  _flagCache.set(flagId, { value: val, expires: Date.now() + FLAG_CACHE_TTL_MS });
  return val;
}

/**
 * Get all flags
 */
export async function getAllFlags(): Promise<Record<FlagId, boolean>> {
  // Schema: switchboard_flags(id uuid, flag_key text, enabled boolean, ...).
  // See SCRUM-1622 — pre-fix code asked for `id, value` which selected a
  // non-existent `value` column. The whole `/admin/controls` UI was reading
  // wrong-shaped rows and silently filling the default-flags map every time.
  // Generated `database.types.ts` already has the correct shape; the `as any`
  // cast on the query is what kept the bug invisible to tsc.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('switchboard_flags')
    .select('flag_key, enabled');

  if (error) {
    console.error('Failed to fetch flags:', error);
    return { ...FLAGS } as Record<FlagId, boolean>;
  }

  const flags: Record<FlagId, boolean> = { ...FLAGS };

  for (const row of (data || []) as Array<{ flag_key: string; enabled: boolean }>) {
    if (row.flag_key in flags) {
      flags[row.flag_key as FlagId] = row.enabled;
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

/**
 * SCRUM-1755 — split "Secure Document" (universal) and "Issue Credential"
 * (verified-org admins only) into distinct UI surfaces, removing the
 * conflation in DashboardPage / OrgProfilePage / copy.ts.
 */
export async function isIssueCredentialSplitEnabled(): Promise<boolean> {
  return getFlagStrict('ENABLE_ISSUE_CREDENTIAL_SPLIT');
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
        // Postgres CDC payload mirrors the actual row columns. Schema is
        // (id uuid, flag_key text, enabled boolean, ...). See SCRUM-1622 —
        // pre-fix code keyed cache + dispatched callback by `newRow.id`
        // (the UUID PK), but `getFlag(flagId)` keys its cache by flag_key.
        // The two halves of the cache never agreed; flag flips never
        // invalidated the cache that real callers were reading from.
        const newRow = payload.new as { flag_key?: string; enabled?: boolean } | undefined;
        if (!newRow?.flag_key || typeof newRow.enabled !== 'boolean') return;
        // Only process known flags
        if (!(newRow.flag_key in FLAGS)) return;
        // Invalidate cache on realtime update — key matches getFlag()'s key.
        _flagCache.set(newRow.flag_key, { value: newRow.enabled, expires: Date.now() + FLAG_CACHE_TTL_MS });
        onFlagChange(newRow.flag_key as FlagId, newRow.enabled);
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
