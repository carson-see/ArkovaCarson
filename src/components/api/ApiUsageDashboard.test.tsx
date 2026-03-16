/**
 * ApiUsageDashboard Component Tests (P4.5-TS-10)
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApiUsageDashboard } from './ApiUsageDashboard';
import type { ApiUsageData } from '@/hooks/useApiKeys';

const mockUsage: ApiUsageData = {
  used: 1500,
  limit: 10000,
  remaining: 8500,
  reset_date: '2026-04-01T00:00:00Z',
  month: '2026-03',
  keys: [
    { key_prefix: 'ak_live_abc1', name: 'Production', used: 1200 },
    { key_prefix: 'ak_live_def2', name: 'Staging', used: 300 },
  ],
};

describe('ApiUsageDashboard', () => {
  it('renders usage progress', () => {
    render(<ApiUsageDashboard usage={mockUsage} />);
    expect(screen.getByText(/1,500 \/ 10,000/)).toBeInTheDocument();
    expect(screen.getByText(/8,500 requests remaining/)).toBeInTheDocument();
  });

  it('renders per-key breakdown', () => {
    render(<ApiUsageDashboard usage={mockUsage} />);
    expect(screen.getByText('Usage by Key')).toBeInTheDocument();
    expect(screen.getByText('Production')).toBeInTheDocument();
    expect(screen.getByText('1,200')).toBeInTheDocument();
  });

  it('renders unlimited tier', () => {
    const unlimited: ApiUsageData = {
      ...mockUsage,
      limit: 'unlimited',
      remaining: 'unlimited',
    };
    render(<ApiUsageDashboard usage={unlimited} />);
    expect(screen.getAllByText('Unlimited').length).toBeGreaterThan(0);
  });

  it('renders loading state', () => {
    render(<ApiUsageDashboard usage={null} loading={true} />);
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeTruthy();
  });

  it('renders error state', () => {
    render(<ApiUsageDashboard usage={null} error="Failed to load" />);
    expect(screen.getByText('Failed to load')).toBeInTheDocument();
  });

  it('renders reset date', () => {
    render(<ApiUsageDashboard usage={mockUsage} />);
    // Date may render as March 31 or April 1 depending on timezone
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });
});
