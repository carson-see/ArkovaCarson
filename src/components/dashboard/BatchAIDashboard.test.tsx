/**
 * BatchAIDashboard Component Tests (P8-S14)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

let mockResolvedData: { data: Array<Record<string, unknown>> | null; error: unknown } = {
  data: [],
  error: null,
};

// Mock supabase with a chain that reads mockResolvedData at call time
vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        order: () => ({
          limit: () => Promise.resolve(mockResolvedData),
        }),
      }),
    }),
  },
}));

import { BatchAIDashboard } from './BatchAIDashboard';

describe('BatchAIDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvedData = { data: [], error: null };
  });

  it('shows loading shimmer initially', () => {
    const { container } = render(<BatchAIDashboard />);
    expect(container.querySelectorAll('.shimmer').length).toBeGreaterThan(0);
  });

  it('shows empty state when no jobs', async () => {
    render(<BatchAIDashboard />);
    expect(await screen.findByText(/no batch ai jobs/i)).toBeInTheDocument();
  });

  it('renders job cards with status badges', async () => {
    mockResolvedData = {
      data: [
        {
          id: '00000000-0000-0000-0000-000000000001',
          status: 'complete',
          total_items: 10,
          processed_items: 10,
          failed_items: 0,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:01:00Z',
        },
        {
          id: '00000000-0000-0000-0000-000000000002',
          status: 'processing',
          total_items: 5,
          processed_items: 3,
          failed_items: 1,
          created_at: '2025-01-02T00:00:00Z',
          updated_at: '2025-01-02T00:01:00Z',
        },
      ],
      error: null,
    };

    render(<BatchAIDashboard />);
    expect(await screen.findByText('complete')).toBeInTheDocument();
    expect(screen.getByText('processing')).toBeInTheDocument();
    expect(screen.getByText('10 credentials')).toBeInTheDocument();
    expect(screen.getByText('5 credentials')).toBeInTheDocument();
  });

  it('displays progress bar with failure count', async () => {
    mockResolvedData = {
      data: [
        {
          id: '00000000-0000-0000-0000-000000000001',
          status: 'partial_failure',
          total_items: 10,
          processed_items: 10,
          failed_items: 3,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:01:00Z',
        },
      ],
      error: null,
    };

    render(<BatchAIDashboard />);
    expect(await screen.findByText('3 failed')).toBeInTheDocument();
    expect(screen.getByText('10/10 processed')).toBeInTheDocument();
  });

  it('shows summary stats', async () => {
    mockResolvedData = {
      data: [
        {
          id: '00000000-0000-0000-0000-000000000001',
          status: 'complete',
          total_items: 10,
          processed_items: 10,
          failed_items: 0,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:01:00Z',
        },
      ],
      error: null,
    };

    render(<BatchAIDashboard />);
    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Processing')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });
});
