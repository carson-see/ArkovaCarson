/**
 * DriveConnectorCard tests (SCRUM-1168; SCRUM-2903 GD-PROD last-synced +
 * documents-secured-via-Drive additions).
 *
 * Unit tests covering all states: loading, disconnected, connected, error,
 * connect action, disconnect action, plus the SCRUM-2903 addition — a
 * "Last synced" line sourced from org_integrations.last_token_advanced_at.
 *
 * A "N documents secured via Drive" counter was also proposed and CUT; see the
 * removal-pinning test below and the NOTE in DriveConnectorCard.tsx.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { toast } from 'sonner';
import { DriveConnectorCard } from './DriveConnectorCard';

// The component queries two different tables (org_integrations, anchors) via
// supabase.from(table) — route each to its own chainable query double so
// tests can independently control the connection row vs the anchors count.
const orgIntegrationsQuery = {
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  is: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn(),
};

const anchorsCountQuery = {
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  is: vi.fn(),
};

const fromMock = vi.fn((table: string) => (table === 'anchors' ? anchorsCountQuery : orgIntegrationsQuery));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => fromMock(table),
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

const CONNECTED_ROW = {
  id: 'int-1',
  account_label: 'ops@arkova.io',
  connected_at: '2026-04-25T00:00:00Z',
  subscription_expires_at: '2026-08-01T00:00:00Z',
  scope: 'https://www.googleapis.com/auth/drive.readonly',
  last_token_advanced_at: '2026-07-28T09:30:00Z',
};

describe('DriveConnectorCard', () => {
  let assignSpy: ReturnType<typeof vi.fn>;
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    orgIntegrationsQuery.select.mockReturnThis();
    orgIntegrationsQuery.eq.mockReturnThis();
    orgIntegrationsQuery.is.mockReturnThis();
    orgIntegrationsQuery.order.mockReturnThis();
    orgIntegrationsQuery.limit.mockReturnThis();
    orgIntegrationsQuery.maybeSingle.mockResolvedValue({ data: null, error: null });

    anchorsCountQuery.select.mockReturnThis();
    anchorsCountQuery.eq.mockReturnThis();
    // Terminal call in the anchors count chain — resolves { count, error }.
    anchorsCountQuery.is.mockResolvedValue({ count: 0, error: null });

    assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign: assignSpy, href: 'https://app.test/organizations/x?tab=settings' },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('renders loading state while fetching connection status', () => {
    orgIntegrationsQuery.maybeSingle.mockReturnValue(new Promise(() => {}));

    render(<DriveConnectorCard orgId={ORG_ID} />);

    expect(screen.getByText('Checking')).toBeInTheDocument();
    const connectButton = screen.getByRole('button', { name: /connect drive/i });
    expect(connectButton).toBeDisabled();
  });

  it('renders the Connect button and does not query anchors when no active integration row exists', async () => {
    render(<DriveConnectorCard orgId={ORG_ID} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /connect drive/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/not connected/i)).toBeInTheDocument();

    expect(orgIntegrationsQuery.eq).toHaveBeenCalledWith('org_id', ORG_ID);
    expect(orgIntegrationsQuery.eq).toHaveBeenCalledWith('provider', 'google_drive');

    // No connection -> no point paying for a Drive-sourced-anchor count query.
    expect(fromMock).not.toHaveBeenCalledWith('anchors');
    expect(screen.queryByText(/last synced/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/secured via drive/i)).not.toBeInTheDocument();
  });

  it('renders Disconnect + account label + last-synced when connected', async () => {
    orgIntegrationsQuery.maybeSingle.mockResolvedValue({ data: CONNECTED_ROW, error: null });

    render(<DriveConnectorCard orgId={ORG_ID} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/connected as ops@arkova\.io/i)).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();

    // SCRUM-2903: last-synced line renders a formatted timestamp.
    await waitFor(() => {
      expect(screen.getByText(/last synced/i)).toBeInTheDocument();
    });
  });

  // The documents-secured counter was cut from this card (see the NOTE in
  // DriveConnectorCard.tsx): it used an exact PostgREST row count over the
  // ~2.97M-row anchors table with no supporting index, which both raises the
  // R0-8 exact-count baseline and sequential-scans on every Settings render.
  // This pins the removal so it is not silently reintroduced without the index
  // migration + `count-exact-allowed` label.
  it('does not query anchors at all — no unindexed count on a 2.97M-row table', async () => {
    orgIntegrationsQuery.maybeSingle.mockResolvedValue({ data: CONNECTED_ROW, error: null });

    render(<DriveConnectorCard orgId={ORG_ID} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
    });
    expect(fromMock).not.toHaveBeenCalledWith('anchors');
    expect(screen.queryByText(/secured via drive/i)).not.toBeInTheDocument();
  });

  it('shows "Not yet synced" when the connection has no last_token_advanced_at (never run a changes pass)', async () => {
    orgIntegrationsQuery.maybeSingle.mockResolvedValue({
      data: { ...CONNECTED_ROW, last_token_advanced_at: null },
      error: null,
    });

    render(<DriveConnectorCard orgId={ORG_ID} />);

    await waitFor(() => {
      expect(screen.getByText(/not yet synced/i)).toBeInTheDocument();
    });
  });

  it('omits the documents-secured segment (without crashing) when the anchors count query errors', async () => {
    orgIntegrationsQuery.maybeSingle.mockResolvedValue({ data: CONNECTED_ROW, error: null });
    anchorsCountQuery.is.mockResolvedValue({ count: null, error: { message: 'permission denied' } });

    render(<DriveConnectorCard orgId={ORG_ID} />);

    await waitFor(() => {
      expect(screen.getByText(/last synced/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/secured via drive/i)).not.toBeInTheDocument();
  });

  it('falls back to unlabeled "Connected." when account_label is null', async () => {
    orgIntegrationsQuery.maybeSingle.mockResolvedValue({
      data: { ...CONNECTED_ROW, account_label: null },
      error: null,
    });

    render(<DriveConnectorCard orgId={ORG_ID} />);

    await waitFor(() => {
      expect(screen.getByText('Connected.')).toBeInTheDocument();
    });
  });

  it('redirects to the Google authorization URL on Connect click', async () => {
    workerFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?x=1' }),
    });

    render(<DriveConnectorCard orgId={ORG_ID} />);

    const connectButton = await screen.findByRole('button', { name: /connect drive/i });
    await waitFor(() => expect(connectButton).toBeEnabled());
    fireEvent.click(connectButton);

    await waitFor(() => {
      expect(workerFetch).toHaveBeenCalledWith(
        '/api/v1/integrations/google_drive/oauth/start',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    await waitFor(() => {
      expect(assignSpy).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/auth?x=1');
    });
  });

  it('disconnect calls the worker endpoint and clears the connection', async () => {
    orgIntegrationsQuery.maybeSingle.mockResolvedValue({ data: CONNECTED_ROW, error: null });
    workerFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    render(<DriveConnectorCard orgId={ORG_ID} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
    });

    const disconnectButton = screen.getByRole('button', { name: /disconnect/i });
    fireEvent.click(disconnectButton);

    await waitFor(() => {
      expect(workerFetch).toHaveBeenCalledWith(
        '/api/v1/integrations/google_drive/disconnect',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Google Drive disconnected.');
    });
    await waitFor(() => {
      expect(screen.getByText(/not connected/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/secured via drive/i)).not.toBeInTheDocument();
  });

  it('disconnect failure surfaces the worker error message', async () => {
    orgIntegrationsQuery.maybeSingle.mockResolvedValue({ data: CONNECTED_ROW, error: null });
    workerFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Token revocation failed' }),
    });

    render(<DriveConnectorCard orgId={ORG_ID} />);

    const disconnectButton = await screen.findByRole('button', { name: /disconnect/i });
    fireEvent.click(disconnectButton);

    await waitFor(() => {
      expect(screen.getByText('Token revocation failed')).toBeInTheDocument();
    });
  });

  it('renders error message when the org_integrations query fails on initial load', async () => {
    orgIntegrationsQuery.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'relation "org_integrations" does not exist', code: '42P01' },
    });

    render(<DriveConnectorCard orgId={ORG_ID} />);

    await waitFor(() => {
      expect(screen.getByText('Unable to load Drive connection status.')).toBeInTheDocument();
    });
  });

  it('renders error message when the org_integrations query throws', async () => {
    orgIntegrationsQuery.maybeSingle.mockRejectedValue(new Error('Network timeout'));

    render(<DriveConnectorCard orgId={ORG_ID} />);

    await waitFor(() => {
      expect(screen.getByText('Unable to load Drive connection status.')).toBeInTheDocument();
    });
  });
});
