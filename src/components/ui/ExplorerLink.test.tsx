/**
 * ExplorerLink Tests
 *
 * @see MVP-16
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { ExplorerLink, truncateReceiptId, getExplorerBaseUrl } from './ExplorerLink';

describe('ExplorerLink', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_BITCOIN_NETWORK', 'testnet4');
  });

  it('renders a link to mempool.space with receipt ID', () => {
    const txId = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const { getByRole } = render(<ExplorerLink receiptId={txId} />);
    const link = getByRole('link');

    expect(link).toHaveAttribute('href', `https://mempool.space/testnet4/tx/${txId}`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('truncates long receipt IDs by default', () => {
    const txId = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const { getByRole } = render(<ExplorerLink receiptId={txId} />);
    const link = getByRole('link');

    expect(link.textContent).toContain('a1b2c3d4');
    expect(link.textContent).toContain('e5f6a1b2');
    expect(link.textContent).not.toBe(txId);
  });

  it('shows full ID when showFull is true', () => {
    const txId = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const { getByRole } = render(<ExplorerLink receiptId={txId} showFull />);
    const link = getByRole('link');

    expect(link.textContent).toContain(txId);
  });

  it('uses custom label when provided', () => {
    const { getByRole } = render(
      <ExplorerLink receiptId="abc123" label="View receipt" />
    );
    const link = getByRole('link');

    expect(link.textContent).toContain('View receipt');
  });

  it('opens in new tab', () => {
    const { getByRole } = render(<ExplorerLink receiptId="abc123" />);
    expect(getByRole('link')).toHaveAttribute('target', '_blank');
  });
});

describe('truncateReceiptId', () => {
  it('returns short IDs unchanged', () => {
    expect(truncateReceiptId('abc123')).toBe('abc123');
  });

  it('truncates long IDs to first 8 + last 8', () => {
    const long = 'a'.repeat(64);
    const result = truncateReceiptId(long);
    expect(result).toBe('aaaaaaaa…aaaaaaaa');
    expect(result.length).toBe(17); // 8 + 1 (…) + 8
  });
});

describe('getExplorerBaseUrl', () => {
  it('defaults to signet', () => {
    vi.stubEnv('VITE_BITCOIN_NETWORK', '');
    expect(getExplorerBaseUrl()).toBe('https://mempool.space/signet');
  });

  it('returns mainnet URL for mainnet', () => {
    vi.stubEnv('VITE_BITCOIN_NETWORK', 'mainnet');
    expect(getExplorerBaseUrl()).toBe('https://mempool.space');
  });
});
