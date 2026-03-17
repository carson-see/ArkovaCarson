/**
 * Explorer Link Helpers (BETA-01 / BETA-11)
 *
 * Generates mempool.space explorer URLs for Bitcoin transactions.
 * Uses Constitution 1.3 terminology — "Network Receipt" not "Transaction".
 *
 * @see BETA-01 — Mempool Live Transaction Tracking
 * @see BETA-11 — Public Verification Page (explorer links)
 */

type BitcoinNetwork = 'testnet4' | 'testnet' | 'signet' | 'mainnet';

const MEMPOOL_BASE: Record<BitcoinNetwork, string> = {
  testnet4: 'https://mempool.space/testnet4',
  testnet: 'https://mempool.space/testnet',
  signet: 'https://mempool.space/signet',
  mainnet: 'https://mempool.space',
};

/**
 * Get the current Bitcoin network from environment.
 * Falls back to testnet4 for development.
 */
function getNetwork(): BitcoinNetwork {
  const net = import.meta.env.VITE_BITCOIN_NETWORK;
  if (net && net in MEMPOOL_BASE) return net as BitcoinNetwork;
  return 'testnet4';
}

/**
 * Build a mempool.space transaction URL.
 *
 * @param txid - The chain_tx_id from the anchor row
 * @param network - Override network (defaults to env)
 * @returns Full mempool.space URL or null if no txid
 */
export function getExplorerTxUrl(
  txid: string | null | undefined,
  network?: BitcoinNetwork,
): string | null {
  if (!txid) return null;
  const base = MEMPOOL_BASE[network ?? getNetwork()];
  return `${base}/tx/${txid}`;
}

/**
 * Build a mempool.space block URL.
 *
 * @param blockHeight - Block height number
 * @param network - Override network (defaults to env)
 * @returns Full mempool.space block URL or null if no height
 */
export function getExplorerBlockUrl(
  blockHeight: number | null | undefined,
  network?: BitcoinNetwork,
): string | null {
  if (blockHeight == null || blockHeight <= 0) return null;
  const base = MEMPOOL_BASE[network ?? getNetwork()];
  return `${base}/block/${blockHeight}`;
}
