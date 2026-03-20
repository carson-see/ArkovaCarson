/**
 * Explorer Link Component
 *
 * Renders a deep link to a network explorer for viewing anchor receipts.
 * Supports testnet4, signet, testnet, and mainnet via environment variable.
 *
 * @see MVP-16
 */

import { ExternalLink } from 'lucide-react';

const EXPLORER_URLS: Record<string, string> = {
  testnet4: 'https://mempool.space/testnet4',
  signet: 'https://mempool.space/signet',
  testnet: 'https://mempool.space/testnet',
  mainnet: 'https://mempool.space',
};

function getExplorerBaseUrl(): string {
  const network = import.meta.env.VITE_BITCOIN_NETWORK ?? 'signet';
  return EXPLORER_URLS[network] ?? EXPLORER_URLS.signet;
}

/** Truncate a receipt ID for display: first 8 + last 8 chars */
function truncateReceiptId(id: string): string {
  if (id.length <= 20) return id;
  return `${id.slice(0, 8)}…${id.slice(-8)}`;
}

interface ExplorerLinkProps {
  /** The network receipt ID (chain TX ID) */
  receiptId: string;
  /** Optional: show full ID instead of truncated */
  showFull?: boolean;
  /** Optional: custom label text */
  label?: string;
  /** Optional: additional CSS classes */
  className?: string;
}

/** Validate that a receipt ID looks like a hex transaction hash */
function isValidHexId(id: string): boolean {
  return /^[a-fA-F0-9]+$/.test(id);
}

export function ExplorerLink({
  receiptId,
  showFull = false,
  label,
  className = '',
}: Readonly<ExplorerLinkProps>) {
  const baseUrl = getExplorerBaseUrl();
  const safeId = isValidHexId(receiptId) ? receiptId : encodeURIComponent(receiptId);
  const href = `${baseUrl}/tx/${safeId}`;
  const displayText = label ?? (showFull ? receiptId : truncateReceiptId(receiptId));

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 text-primary hover:underline font-mono text-xs ${className}`}
      title="View on network explorer"
    >
      {displayText}
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  );
}

export { truncateReceiptId, getExplorerBaseUrl };
