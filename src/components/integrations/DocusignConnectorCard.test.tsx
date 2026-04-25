/**
 * DocusignConnectorCard tests (SCRUM-1101)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { DocusignConnectorCard } from './DocusignConnectorCard';

const supabaseQuery = {
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  is: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn(),
};

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => supabaseQuery),
  },
}));

const workerFetch = vi.fn();
vi.mock('@/lib/workerClient', () => ({
  workerFetch: (...args: unknown[]) => workerFetch(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const ORG_ID = '11111111-2222-3333-4444-555555555555';

describe('DocusignConnectorCard', () => {
  let assignSpy: ReturnType<typeof vi.fn>;
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    supabaseQuery.select.mockReturnThis();
    supabaseQuery.eq.mockReturnThis();
    supabaseQuery.is.mockReturnThis();
    supabaseQuery.order.mockReturnThis();
    supabaseQuery.limit.mockReturnThis();
    supabaseQuery.maybeSingle.mockResolvedValue({ data: null, error: null });

    assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign: assignSpy, href: 'https://app.test/organizations/x?tab=settings' },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('renders the Connect button when no active integration row exists', async () => {
    render(<DocusignConnectorCard orgId={ORG_ID} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /connect/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/not connected/i)).toBeInTheDocument();

    // RLS scope assertion: query must filter by this org_id + provider so the
    // component cannot accidentally surface a sibling org's connection.
    expect(supabaseQuery.eq).toHaveBeenCalledWith('org_id', ORG_ID);
    expect(supabaseQuery.eq).toHaveBeenCalledWith('provider', 'docusign');
  });

  it('renders the Disconnect button + account label when an active row exists', async () => {
    supabaseQuery.maybeSingle.mockResolvedValue({
      data: {
        id: 'int-1',
        account_id: 'acct-47470255',
        account_label: 'Arkova',
        connected_at: '2026-04-25T00:00:00Z',
        scope: 'signature extended openid email',
      },
      error: null,
    });

    render(<DocusignConnectorCard orgId={ORG_ID} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/account: arkova/i)).toBeInTheDocument();
  });

  it('redirects to the DocuSign authorization URL on Connect click', async () => {
    workerFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ authorizationUrl: 'https://account-d.docusign.com/oauth/auth?x=1', url: 'https://account-d.docusign.com/oauth/auth?x=1' }),
    });

    render(<DocusignConnectorCard orgId={ORG_ID} />);

    const connectButton = await screen.findByRole('button', { name: /connect/i });
    fireEvent.click(connectButton);

    await waitFor(() => {
      expect(workerFetch).toHaveBeenCalledWith(
        '/api/v1/integrations/docusign/oauth/start',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    await waitFor(() => {
      expect(assignSpy).toHaveBeenCalledWith('https://account-d.docusign.com/oauth/auth?x=1');
    });
  });

  it('surfaces a worker error message instead of redirecting on failure', async () => {
    workerFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Must be org admin to connect DocuSign' }),
    });

    render(<DocusignConnectorCard orgId={ORG_ID} />);

    const connectButton = await screen.findByRole('button', { name: /connect/i });
    fireEvent.click(connectButton);

    await waitFor(() => {
      expect(screen.getByText(/must be org admin to connect docusign/i)).toBeInTheDocument();
    });
    expect(assignSpy).not.toHaveBeenCalled();
  });
});
