/**
 * Platform Constants
 *
 * Shared constants for platform admin checks, treasury info,
 * and other cross-cutting concerns.
 */

/** Platform admin email whitelist — server-side enforcement in worker isPlatformAdmin() */
export const PLATFORM_ADMIN_EMAILS = ['carson@arkova.ai', 'sarah@arkova.ai'] as const;

/** Check if a user email is a platform admin */
export function isPlatformAdmin(email: string | null | undefined): boolean {
  return PLATFORM_ADMIN_EMAILS.includes(email as typeof PLATFORM_ADMIN_EMAILS[number]);
}

/** Mainnet treasury address for mempool explorer links */
export const TREASURY_ADDRESS = 'bc1qtm2kk33k6ht4agt48kh7rfkmmhfkapqn4zwerc';

/** Mempool explorer base URL for the current network */
export const MEMPOOL_BASE_URL = 'https://mempool.space';

/** Build a mempool transaction URL */
export function mempoolTxUrl(txId: string): string {
  return `${MEMPOOL_BASE_URL}/tx/${txId}`;
}

/** Build a mempool address URL */
export function mempoolAddressUrl(address: string = TREASURY_ADDRESS): string {
  return `${MEMPOOL_BASE_URL}/address/${address}`;
}
