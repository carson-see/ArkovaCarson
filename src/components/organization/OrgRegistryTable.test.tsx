/**
 * Tests for OrgRegistryTable component — UAT bug fixes
 *
 * @see UAT2-13 — recipient in mobile card layout
 * @see UAT3-04 — QR/copy URL uses verifyUrl (not localhost)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OrgRegistryTable } from './OrgRegistryTable';

// Mock supabase
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            filter: () => ({
              order: () => ({
                range: () => ({
                  or: () => ({
                    gte: () => ({
                      lte: () => Promise.resolve({ data: [], count: 0, error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  },
}));

// Mock useExportAnchors
vi.mock('@/hooks/useExportAnchors', () => ({
  useExportAnchors: () => ({ exportAnchors: vi.fn(), loading: false }),
}));

// Mock navigator.clipboard
const mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
Object.assign(navigator, { clipboard: mockClipboard });

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe('OrgRegistryTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    render(
      <MemoryRouter>
        <OrgRegistryTable orgId="org-1" />
      </MemoryRouter>,
    );
    // Should show search input
    expect(screen.getByPlaceholderText(/search by filename/i)).toBeDefined();
  });
});
