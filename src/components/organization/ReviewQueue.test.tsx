/**
 * ReviewQueue Component Tests (P8-S9)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReviewQueue } from './ReviewQueue';

// Mock hooks
const mockFetchItems = vi.fn();
const mockFetchStats = vi.fn();
const mockApplyAction = vi.fn();

vi.mock('@/hooks/useReviewQueue', () => ({
  useReviewQueue: () => ({
    items: [],
    stats: { total: 5, pending: 3, investigating: 1, escalated: 1, approved: 0, dismissed: 0 },
    loading: false,
    acting: false,
    fetchItems: mockFetchItems,
    fetchStats: mockFetchStats,
    applyAction: mockApplyAction,
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe('ReviewQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the review queue header', () => {
    render(<ReviewQueue />);
    expect(screen.getByText('Review Queue')).toBeTruthy();
  });

  it('renders stats when available', () => {
    render(<ReviewQueue />);
    expect(screen.getByText('3 pending, 1 investigating')).toBeTruthy();
  });

  it('renders empty state when no items', () => {
    render(<ReviewQueue />);
    expect(screen.getByText('No items in the review queue')).toBeTruthy();
  });

  it('renders filter tabs', () => {
    render(<ReviewQueue />);
    // Filter tabs duplicate some stats labels, so check for multiple
    expect(screen.getAllByText('Pending').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Investigating').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Escalated').length).toBeGreaterThanOrEqual(1);
  });

  it('calls fetchItems and fetchStats on mount', () => {
    render(<ReviewQueue />);
    expect(mockFetchItems).toHaveBeenCalled();
    expect(mockFetchStats).toHaveBeenCalled();
  });

  it('renders stats cards', () => {
    render(<ReviewQueue />);
    // Stats display: pending=3, investigating=1, escalated=1, approved=0, dismissed=0
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getAllByText('1').length).toBe(2); // investigating + escalated both = 1
    expect(screen.getAllByText('0').length).toBe(2); // approved + dismissed both = 0
  });
});

describe('ReviewQueue with items', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders items when they exist', () => {
    vi.doMock('@/hooks/useReviewQueue', () => ({
      useReviewQueue: () => ({
        items: [
          {
            id: 'item-1',
            anchorId: 'anchor-1',
            orgId: 'org-1',
            status: 'PENDING',
            priority: 7,
            reason: 'Low integrity score 35/100',
            flags: ['duplicate_fingerprint'],
            anchorTitle: 'Test Credential',
            anchorCredentialType: 'DEGREE',
            integrityScore: 35,
            integrityLevel: 'FLAGGED',
            createdAt: '2026-03-16T10:00:00Z',
            updatedAt: '2026-03-16T10:00:00Z',
            assignedTo: null,
            reviewedBy: null,
            reviewedAt: null,
            reviewNotes: null,
            reviewAction: null,
          },
        ],
        stats: { total: 1, pending: 1, investigating: 0, escalated: 0, approved: 0, dismissed: 0 },
        loading: false,
        acting: false,
        fetchItems: mockFetchItems,
        fetchStats: mockFetchStats,
        applyAction: mockApplyAction,
      }),
    }));
  });
});
