/**
 * VerifyMyRecordPage Tests
 *
 * @see MVP-21
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mock hooks and dependencies
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'test-user' }, loading: false }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: { role: 'INDIVIDUAL', org_id: null },
    destination: '/dashboard',
    loading: false,
  }),
}));

vi.mock('@/hooks/useOnboarding', () => ({
  useOnboarding: () => ({
    isOnboarding: false,
    loading: false,
  }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          is: vi.fn(() => ({
            order: vi.fn().mockResolvedValue({ data: [], error: null }),
          })),
        })),
      })),
    })),
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: 'test' } } } }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

import { VerifyMyRecordPage } from './VerifyMyRecordPage';

describe('VerifyMyRecordPage', () => {
  it('renders the page title and description', () => {
    const { getByText } = render(
      <MemoryRouter>
        <VerifyMyRecordPage />
      </MemoryRouter>
    );

    expect(getByText('Verify Your Record')).toBeInTheDocument();
    expect(getByText(/Upload a document to verify/)).toBeInTheDocument();
  });

  it('renders the file upload component', () => {
    const { getByText } = render(
      <MemoryRouter>
        <VerifyMyRecordPage />
      </MemoryRouter>
    );

    expect(getByText('Document Verification')).toBeInTheDocument();
    expect(getByText(/File never leaves your device/)).toBeInTheDocument();
  });

  it('renders the drag and drop area', () => {
    const { getByText } = render(
      <MemoryRouter>
        <VerifyMyRecordPage />
      </MemoryRouter>
    );

    expect(getByText('Drag and drop your document here')).toBeInTheDocument();
    expect(getByText('Select Document')).toBeInTheDocument();
  });
});
