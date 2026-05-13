import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnchorStats } from './AnchorStats';

describe('AnchorStats', () => {
  it('renders worker-reported statuses outside the configured lifecycle list', () => {
    render(
      <AnchorStats
        loading={false}
        stats={{
          byStatus: {
            SECURED: 3,
            QUARANTINED: 2,
          },
          totalAnchors: 5,
          distinctTxIds: 2,
          avgAnchorsPerTx: 2.5,
          lastAnchorTime: null,
          lastTxTime: null,
        }}
      />,
    );

    expect(screen.getByText('Anchored')).toBeInTheDocument();
    const quarantinedRow = screen.getByText('QUARANTINED').closest('div');
    expect(quarantinedRow).toHaveTextContent('2');
  });

  it('renders unavailable totals as an em dash', () => {
    render(
      <AnchorStats
        loading={false}
        stats={{
          byStatus: {
            SECURED: 3,
            PENDING: null,
          },
          totalAnchors: null,
          distinctTxIds: null,
          avgAnchorsPerTx: null,
          lastAnchorTime: null,
          lastTxTime: null,
        }}
      />,
    );

    const totalRow = screen.getByText('Total Records').closest('div');
    expect(totalRow).toHaveTextContent('—');
  });
});
