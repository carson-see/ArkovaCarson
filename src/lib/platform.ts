/**
 * Platform Constants
 *
 * Shared constants for platform admin checks, treasury info,
 * and other cross-cutting concerns.
 */

/**
 * Minimal shape needed to resolve platform-admin status: the
 * `profiles.is_platform_admin` DB flag. Accepts the full profile Row or any
 * object carrying the flag, so callers can pass `useProfile().profile` directly.
 */
type PlatformAdminProfile = { is_platform_admin?: boolean | null } | null | undefined;

/**
 * Check whether a profile is a platform admin.
 *
 * SECURITY (SCRUM-2939): the ONLY authority is the `profiles.is_platform_admin`
 * DB flag — the same source the worker (`services/worker/src/utils/platformAdmin.ts`)
 * and every RLS policy enforce. The legacy client-side email whitelist was
 * removed because a browser-only list that can diverge from the DB flag is a
 * role-model split, not a real access-control boundary. This client check is
 * defence-in-depth / UX gating only; the server RE-VERIFIES the flag on every
 * privileged endpoint and RPC. Fails secure: any non-`true` value → false.
 */
export function isPlatformAdmin(profile: PlatformAdminProfile): boolean {
  return profile?.is_platform_admin === true;
}

/** Mainnet treasury address for mempool explorer links */
export const TREASURY_ADDRESS = 'bc1qtm2kk33k6ht4agt48kh7rfkmmhfkapqn4zwerc';

/** Mempool explorer base URL for the current network */
export const MEMPOOL_BASE_URL = 'https://mempool.space';

/** Build a mempool transaction URL */
export function mempoolTxUrl(txId: string): string {
  return `${MEMPOOL_BASE_URL}/tx/${txId}`;
}

/** Map raw network name to Constitution 1.3 compliant display name */
export function getNetworkDisplayName(network: string): string {
  if (network === 'mainnet') return 'Production Network';
  if (network === 'signet' || network === 'testnet' || network === 'testnet4') return 'Test Environment';
  return network;
}

/** Build a mempool address URL */
export function mempoolAddressUrl(address: string = TREASURY_ADDRESS): string {
  return `${MEMPOOL_BASE_URL}/address/${address}`;
}
