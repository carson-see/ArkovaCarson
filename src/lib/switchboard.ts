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
} as const;

export type FlagId = keyof typeof FLAGS;

// =============================================================================
// FLAG CHECKING
// =============================================================================

/**
 * Get a flag value from the server
 */
export async function getFlag(flagId: FlagId): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.rpc as any)('get_flag', {
      p_flag_id: flagId,
    });

    if (error) {
      console.error(`Failed to fetch flag ${flagId}:`, error);
      return FLAGS[flagId]; // Return default on error
    }

    return data as boolean;
  } catch {
    return FLAGS[flagId]; // Return default on error
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
    // Create mutable copy
    return {
      ENABLE_PROD_NETWORK_ANCHORING: FLAGS.ENABLE_PROD_NETWORK_ANCHORING,
      ENABLE_OUTBOUND_WEBHOOKS: FLAGS.ENABLE_OUTBOUND_WEBHOOKS,
      ENABLE_NEW_CHECKOUTS: FLAGS.ENABLE_NEW_CHECKOUTS,
      ENABLE_REPORTS: FLAGS.ENABLE_REPORTS,
      MAINTENANCE_MODE: FLAGS.MAINTENANCE_MODE,
    };
  }

  // Create mutable result object
  const flags: Record<FlagId, boolean> = {
    ENABLE_PROD_NETWORK_ANCHORING: FLAGS.ENABLE_PROD_NETWORK_ANCHORING,
    ENABLE_OUTBOUND_WEBHOOKS: FLAGS.ENABLE_OUTBOUND_WEBHOOKS,
    ENABLE_NEW_CHECKOUTS: FLAGS.ENABLE_NEW_CHECKOUTS,
    ENABLE_REPORTS: FLAGS.ENABLE_REPORTS,
    MAINTENANCE_MODE: FLAGS.MAINTENANCE_MODE,
  };

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
