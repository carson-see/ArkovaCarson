/**
 * DocusignConnectorCard tests (SCRUM-1101, SCRUM-1718)
 *
 * Unit tests covering all states: loading, disconnected, connected, error,
 * connect action, disconnect action.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { toast } from 'sonner';
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

  it('renders loading state with "Checking" badge while fetching connection status', () => {
    // Never resolve the Supabase query so component stays in loading state
    supabaseQuery.maybeSingle.mockReturnValue(new Promise(() => {}));

    render(<DocusignConnectorCard orgId={ORG_ID} />);

    expect(screen.getByText('Checking')).toBeInTheDocument();
    // Connect button should be disabled during loading
    const connectButton = screen.getByRole('button', { name: /connect/i });
    expect(connectButton).toBeDisabled();
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
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('falls back to account_id when account_label is null', async () => {
    supabaseQuery.maybeSingle.mockResolvedValue({
      data: {
        id: 'int-2',
        account_id: 'acct-99887766',
        account_label: null,
        connected_at: '2026-05-01T00:00:00Z',
        scope: 'signature openid',
      },
      error: null,
    });

    render(<DocusignConnectorCard orgId={ORG_ID} />);

    await waitFor(() => {
      expect(screen.getByText(/account: acct-99887766/i)).toBeInTheDocument();
    });
  });

  it('redirects to the DocuSign authorization URL on Connect click', async () => {
    workerFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ authorizationUrl: 'https://account-d.docusign.com/oauth/auth?x=1', url: 'https://account-d.docusign.com/oauth/auth?x=1' }),
    });

    render(<DocusignConnectorCard orgId={ORG_ID} />);

    const connectButton = await screen.findByRole('button', { name: /connect/i });
    await waitFor(() => {
      expect(connectButton).toBeEnabled();
    });
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

  it('sends org_id and return_to in the connect request body', async () => {
    workerFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ authorizationUrl: 'https://account-d.docusign.com/oauth/auth' }),
    });

    render(<DocusignConnectorCard orgId={ORG_ID} />);

    const connectButton = await screen.findByRole('button', { name: /connect/i });
    await waitFor(() => {
      expect(connectButton).toBeEnabled();
    });
    fireEvent.click(connectButton);

    await waitFor(() => {
      expect(workerFetch).toHaveBeenCalledWith(
        '/api/v1/integrations/docusign/oauth/start',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining(ORG_ID),
        }),
      );
    });

    // Verify the body is valid JSON with the expected fields
    const callArgs = workerFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.org_id).toBe(ORG_ID);
    expect(body.return_to).toBeDefined();
  });

  it('disconnect button calls the worker disconnect endpoint and clears connection', async () => {
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

    workerFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    render(<DocusignConnectorCard orgId={ORG_ID} />);

    const disconnectButton = await screen.findByRole('button', { name: /disconnect/i });
    fireEvent.click(disconnectButton);

    await waitFor(() => {
      expect(workerFetch).toHaveBeenCalledWith(
        '/api/v1/integrations/docusign/disconnect',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    // After disconnect, should show success toast and revert to disconnected state
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('DocuSign disconnected.');
    });
    await waitFor(() => {
      expect(screen.getByText(/not connected/i)).toBeInTheDocument();
    });
  });

  it('disconnect failure surfaces error message', async () => {
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

    workerFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Token revocation failed' }),
    });

    render(<DocusignConnectorCard orgId={ORG_ID} />);

    const disconnectButton = await screen.findByRole('button', { name: /disconnect/i });
    fireEvent.click(disconnectButton);

    await waitFor(() => {
      expect(screen.getByText('Token revocation failed')).toBeInTheDocument();
    });
  });

  it('surfaces a worker error message instead of redirecting on failure', async () => {
    workerFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Must be org admin to connect DocuSign' }),
    });

    render(<DocusignConnectorCard orgId={ORG_ID} />);

    const connectButton = await screen.findByRole('button', { name: /connect/i });
    await waitFor(() => {
      expect(connectButton).toBeEnabled();
    });
    fireEvent.click(connectButton);

    await waitFor(() => {
      expect(screen.getByText(/must be org admin to connect docusign/i)).toBeInTheDocument();
    });
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it('renders error message when Supabase query fails on initial load', async () => {
    supabaseQuery.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'relation "org_integrations" does not exist', code: '42P01' },
    });

    render(<DocusignConnectorCard orgId={ORG_ID} />);

    await waitFor(() => {
      expect(screen.getByText('Unable to load DocuSign connection status.')).toBeInTheDocument();
    });
  });

  it('renders error message when Supabase query throws an exception', async () => {
    supabaseQuery.maybeSingle.mockRejectedValue(new Error('Network timeout'));

    render(<DocusignConnectorCard orgId={ORG_ID} />);

    await waitFor(() => {
      expect(screen.getByText('Unable to load DocuSign connection status.')).toBeInTheDocument();
    });
  });

  it('shows generic error when worker returns ok:false with no error field', async () => {
    workerFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({}),
    });

    render(<DocusignConnectorCard orgId={ORG_ID} />);

    const connectButton = await screen.findByRole('button', { name: /connect/i });
    await waitFor(() => {
      expect(connectButton).toBeEnabled();
    });
    fireEvent.click(connectButton);

    await waitFor(() => {
      // Should show the generic CONNECT_FAILED message from copy.ts
      expect(screen.getByText('Could not start the connection. Please try again.')).toBeInTheDocument();
    });
  });

  it('shows generic error when worker returns ok:true but no URL in response', async () => {
    workerFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ someOtherField: 'value' }),
    });

    render(<DocusignConnectorCard orgId={ORG_ID} />);

    const connectButton = await screen.findByRole('button', { name: /connect/i });
    await waitFor(() => {
      expect(connectButton).toBeEnabled();
    });
    fireEvent.click(connectButton);

    await waitFor(() => {
      expect(screen.getByText('Could not start the connection. Please try again.')).toBeInTheDocument();
    });
    expect(assignSpy).not.toHaveBeenCalled();
  });
});
