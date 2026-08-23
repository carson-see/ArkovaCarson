/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT; the mocked attestations read is an incidental page dependency, not the behavior under test */
/**
 * DocumentsPage — one records surface (founder-reported duplication)
 *
 * /documents rendered a "My Records" TAB (a folder-less copy of the records
 * list) while the real records+folders surface is ROUTES.RECORDS
 * (MyRecordsPage, SCRUM-2940). Users landing on /documents concluded folders
 * don't exist. The tab now links through to ROUTES.RECORDS, and legacy
 * `?tab=records` deep links redirect there with their remaining query params
 * (action/credential_type/jurisdiction) preserved — MyRecordsPage consumes
 * the same `?action=upload` deep-link contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ROUTES } from '@/lib/routes';

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetSearchParams = vi.hoisted(() => vi.fn());
const mockSearchParams = vi.hoisted(() => ({ current: new URLSearchParams() }));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'test@test.dev' }, signOut: vi.fn() }),
}));
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ profile: { role: 'INDIVIDUAL', org_id: null }, loading: false }),
}));
vi.mock('@/hooks/useAnchors', () => ({
  useAnchors: () => ({
    records: [
      {
        id: 'anchor-1',
        filename: 'invoice.pdf',
        fingerprint: 'a'.repeat(64),
        status: 'SECURED',
        createdAt: '2026-03-01T00:00:00Z',
        fileSize: 100,
        folderId: null,
      },
    ],
    loading: false,
    refreshAnchors: vi.fn(),
  }),
}));
vi.mock('@/hooks/useMyCredentials', () => ({
  useMyCredentials: () => ({ credentials: [], loading: false }),
}));
vi.mock('@/hooks/useRevokeAnchor', () => ({
  useRevokeAnchor: () => ({ revokeAnchor: vi.fn(), error: null, clearError: vi.fn() }),
}));
vi.mock('@/components/layout', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AppShell: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@/components/anchor', () => ({
  SecureDocumentDialog: () => null,
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams.current, mockSetSearchParams],
}));
// Attestations inline fetch: resolve empty. Read-only list scoped by RLS
// (attester_user_id / attester_org_id eq filters are part of the chain).
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }),
  },
}));

async function renderPage() {
  const { DocumentsPage } = await import('./DocumentsPage');
  return render(<DocumentsPage />);
}

describe('DocumentsPage — one records surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.current = new URLSearchParams();
  });

  it('clicking the My Records tab navigates to the records surface instead of switching tabs', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole('tab', { name: /My Records/ }));

    expect(mockNavigate).toHaveBeenCalledWith(ROUTES.RECORDS);
    // The old behavior wrote ?tab=records into /documents' own URL.
    expect(mockSetSearchParams).not.toHaveBeenCalledWith({ tab: 'records' }, { replace: true });
  });

  it('redirects a legacy ?tab=records deep link to the records surface (replace)', async () => {
    mockSearchParams.current = new URLSearchParams('tab=records');
    await renderPage();

    expect(mockNavigate).toHaveBeenCalledWith(ROUTES.RECORDS, { replace: true });
  });

  it('preserves remaining query params when redirecting a ?tab=records deep link', async () => {
    mockSearchParams.current = new URLSearchParams(
      'tab=records&action=upload&credential_type=DEGREE',
    );
    await renderPage();

    expect(mockNavigate).toHaveBeenCalledWith(
      `${ROUTES.RECORDS}?action=upload&credential_type=DEGREE`,
      { replace: true },
    );
  });

  it('still shows the My Records tab (with count) as the entry point to the records surface', async () => {
    await renderPage();

    const tab = screen.getByRole('tab', { name: /My Records/ });
    expect(tab).toBeInTheDocument();
    // Count badge renders once the async attestations fetch settles.
    await waitFor(() => expect(tab.textContent).toContain('1'));
  });

  it('keeps records visible in the All tab', async () => {
    await renderPage();

    expect(await screen.findByText('invoice.pdf')).toBeInTheDocument();
  });
});
