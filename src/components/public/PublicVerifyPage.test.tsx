/**
 * PublicVerifyPage Tests
 *
 * @see MVP-06
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PublicVerifyPage } from './PublicVerifyPage';

// Mock supabase
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'Not found' } }),
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          in: vi.fn(() => ({
            is: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue({ data: [], error: null }),
            })),
          })),
        })),
      })),
    })),
  },
}));

// Mock logVerificationEvent
vi.mock('@/lib/logVerificationEvent', () => ({
  logVerificationEvent: vi.fn(),
}));

describe('PublicVerifyPage', () => {
  it('renders verification form when no publicId', () => {
    const { getByText } = render(
      <MemoryRouter initialEntries={['/verify']}>
        <Routes>
          <Route path="/verify" element={<PublicVerifyPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(getByText('Credential Verification')).toBeInTheDocument();
    expect(getByText('Upload Document')).toBeInTheDocument();
    expect(getByText('Enter Fingerprint')).toBeInTheDocument();
  });

  it('renders verification result when publicId provided', () => {
    const { getByText } = render(
      <MemoryRouter initialEntries={['/verify/test-public-id']}>
        <Routes>
          <Route path="/verify/:publicId" element={<PublicVerifyPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(getByText('Verify a Credential')).toBeInTheDocument();
  });

  it('renders privacy info cards on form page', () => {
    const { getByText } = render(
      <MemoryRouter initialEntries={['/verify']}>
        <Routes>
          <Route path="/verify" element={<PublicVerifyPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(getByText('Secure')).toBeInTheDocument();
    expect(getByText('Private')).toBeInTheDocument();
    expect(getByText('Instant')).toBeInTheDocument();
  });

  it('renders sign in link', () => {
    const { getByText } = render(
      <MemoryRouter initialEntries={['/verify']}>
        <Routes>
          <Route path="/verify" element={<PublicVerifyPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(getByText('Sign in')).toBeInTheDocument();
  });
});
