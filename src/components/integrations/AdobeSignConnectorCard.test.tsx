/**
 * AdobeSignConnectorCard tests (SCRUM-1148 follow-up)
 *
 * Mirrors DocusignConnectorCard.test.tsx, plus the denial states that are
 * specific to this connector: an unconfigured deployment (the live production
 * state as of 2026-08-30) and a webhook registration Adobe refused because the
 * account plan does not grant webhook access.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { toast } from 'sonner';
import { AdobeSignConnectorCard, adobeSignErrorCopy } from './AdobeSignConnectorCard';
import { CONNECTIONS_LABELS } from '@/lib/copy';

const supabaseQuery = {
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  is: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn(),
};

vi.mock('@/lib/supabase', () => ({
  supabase: { from: vi.fn(() => supabaseQuery) },
}));

const workerFetch = vi.fn();
vi.mock('@/lib/workerClient', () => ({
  workerFetch: (...args: unknown[]) => workerFetch(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import type { IssueGate } from '@/hooks/useCanIssueCredential';
const issueGateMock = vi.fn<() => IssueGate>(() => ({ allowed: true, loading: false, reason: null }));
vi.mock('@/hooks/useCanIssueCredential', () => ({
  useCanIssueCredential: (...args: unknown[]) => issueGateMock(...(args as [])),
}));

const ORG_ID = '11111111-2222-3333-4444-555555555555';

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('AdobeSignConnectorCard', () => {
  let assignSpy: ReturnType<typeof vi.fn>;
  let replaceStateSpy: ReturnType<typeof vi.spyOn>;
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    supabaseQuery.select.mockReturnThis();
    supabaseQuery.eq.mockReturnThis();
    supabaseQuery.is.mockReturnThis();
    supabaseQuery.order.mockReturnThis();
    supabaseQuery.limit.mockReturnThis();
    supabaseQuery.maybeSingle.mockResolvedValue({ data: null, error: null });
    issueGateMock.mockReturnValue({ allowed: true, loading: false, reason: null });

    assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        assign: assignSpy,
        href: 'https://app.test/organizations/x?tab=settings',
        search: '',
        pathname: '/organizations/x',
      },
    });
    replaceStateSpy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    replaceStateSpy.mockRestore();
  });

  it('shows the checking badge and a disabled Connect button while loading', () => {
    supabaseQuery.maybeSingle.mockReturnValue(new Promise(() => {}));
    render(<AdobeSignConnectorCard orgId={ORG_ID} />);

    expect(screen.getByText(CONNECTIONS_LABELS.STATUS_CHECKING)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect/i })).toBeDisabled();
  });

  it('scopes the status query to this org and the adobe_sign provider', async () => {
    render(<AdobeSignConnectorCard orgId={ORG_ID} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /connect/i })).toBeInTheDocument();
    });

    expect(supabaseQuery.eq).toHaveBeenCalledWith('org_id', ORG_ID);
    expect(supabaseQuery.eq).toHaveBeenCalledWith('provider', 'adobe_sign');
    expect(supabaseQuery.is).toHaveBeenCalledWith('revoked_at', null);
  });

  it('never selects credential-bearing columns from the browser', async () => {
    // GH #1836 round 3: DriveConnectorCard selected a secret straight from the
    // browser client, bypassing the worker's own redaction. Pin the column list.
    render(<AdobeSignConnectorCard orgId={ORG_ID} />);
    await waitFor(() => expect(supabaseQuery.select).toHaveBeenCalled());

    const columns = String(supabaseQuery.select.mock.calls[0][0]);
    for (const forbidden of ['encrypted_tokens', 'token_kms_key_id', 'token_secret_name', 'webhook_id']) {
      expect(columns).not.toContain(forbidden);
    }
  });

  it('renders the Disconnect button and account label for an active row', async () => {
    supabaseQuery.maybeSingle.mockResolvedValue({
      data: {
        id: 'int-1',
        account_id: 'adobe-user-1',
        account_label: 'Example Co',
        connected_at: '2026-08-30T00:00:00Z',
        scope: 'webhook_write:account',
      },
      error: null,
    });

    render(<AdobeSignConnectorCard orgId={ORG_ID} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/Example Co/)).toBeInTheDocument();
  });

  it('redirects to the Adobe authorization URL on connect', async () => {
    workerFetch.mockResolvedValue(
      jsonResponse({ authorizationUrl: 'https://secure.na1.adobesign.com/public/oauth/v2?x=1' }),
    );

    render(<AdobeSignConnectorCard orgId={ORG_ID} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /connect/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));

    await waitFor(() => {
      expect(assignSpy).toHaveBeenCalledWith('https://secure.na1.adobesign.com/public/oauth/v2?x=1');
    });
    expect(workerFetch).toHaveBeenCalledWith(
      '/api/v1/integrations/adobe-sign/oauth/start',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows the not-available copy when the deployment has no Adobe application', async () => {
    // The LIVE production path as of 2026-08-30 — no registered Adobe app.
    workerFetch.mockResolvedValue(
      jsonResponse({ error: 'Adobe Sign is not configured on this deployment.', code: 'adobe_sign_unconfigured' }, 500),
    );

    render(<AdobeSignConnectorCard orgId={ORG_ID} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /connect/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));

    await waitFor(() => {
      expect(screen.getByText(CONNECTIONS_LABELS.ADOBE_SIGN_UNCONFIGURED)).toBeInTheDocument();
    });
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it('reads a 503 kill-switch response as not-available, not as a generic failure', async () => {
    workerFetch.mockResolvedValue(jsonResponse({ error: 'integration_disabled' }, 503));

    render(<AdobeSignConnectorCard orgId={ORG_ID} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /connect/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));

    await waitFor(() => {
      expect(screen.getByText(CONNECTIONS_LABELS.ADOBE_SIGN_UNCONFIGURED)).toBeInTheDocument();
    });
  });

  it('blocks connect and explains why for an unverified org', async () => {
    issueGateMock.mockReturnValue({ allowed: false, loading: false, reason: 'org_unverified' });

    render(<AdobeSignConnectorCard orgId={ORG_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId('adobe-sign-gate-denied')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /connect/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it('disconnects and reports a clean Adobe-side teardown', async () => {
    supabaseQuery.maybeSingle.mockResolvedValue({
      data: { id: 'int-1', account_id: 'a', account_label: 'Example Co', connected_at: null, scope: null },
      error: null,
    });
    workerFetch.mockResolvedValue(jsonResponse({ disconnected: true, adobe_webhook_removed: true }));

    render(<AdobeSignConnectorCard orgId={ORG_ID} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(CONNECTIONS_LABELS.ADOBE_SIGN_TOAST_DISCONNECTED);
    });
    expect(workerFetch).toHaveBeenCalledWith(
      '/api/v1/integrations/adobe-sign/disconnect',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('tells the admin to clean up manually when Adobe kept the registration', async () => {
    // A stranded Adobe-side webhook keeps delivering to us forever. Reporting
    // "Disconnected." alone would hide that.
    supabaseQuery.maybeSingle.mockResolvedValue({
      data: { id: 'int-1', account_id: 'a', account_label: 'Example Co', connected_at: null, scope: null },
      error: null,
    });
    workerFetch.mockResolvedValue(jsonResponse({ disconnected: true, adobe_webhook_removed: false }));

    render(<AdobeSignConnectorCard orgId={ORG_ID} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));

    await waitFor(() => {
      expect(screen.getByText(CONNECTIONS_LABELS.ADOBE_SIGN_WEBHOOK_STRANDED)).toBeInTheDocument();
    });
  });

  it('does NOT read the OAuth return-trip query string itself', async () => {
    // Regression guard. An earlier draft read `?adobe_sign_error=` in a
    // card-local effect and set component state; that loses the message under
    // React StrictMode's double mount (first mount strips the params, its
    // state is discarded, second mount sees an empty query string). The result
    // is handled by OrgProfilePage's `useSearchParams` effect instead — the
    // same place Drive and DocuSign handle theirs. If this test starts failing
    // because the card renders the copy, the StrictMode bug is back.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        assign: assignSpy,
        href: 'https://app.test/organizations/x?tab=settings&adobe_sign_error=webhook_registration_failed',
        search: '?tab=settings&adobe_sign_error=webhook_registration_failed',
        pathname: '/organizations/x',
      },
    });

    render(<AdobeSignConnectorCard orgId={ORG_ID} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /connect/i })).toBeInTheDocument());

    expect(screen.queryByText(CONNECTIONS_LABELS.ADOBE_SIGN_WEBHOOK_FAILED)).not.toBeInTheDocument();
    // ...and it must not rewrite history behind the page's back either.
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });
});

describe('adobeSignErrorCopy', () => {
  it('maps every worker denial code to specific copy, not the generic failure', () => {
    const specific = [
      'org_unverified',
      'org_suspended',
      'adobe_sign_unconfigured',
      'webhook_registration_failed',
      'webhook_already_claimed',
    ];
    for (const code of specific) {
      expect(adobeSignErrorCopy(code)).not.toBe(CONNECTIONS_LABELS.CONNECT_FAILED);
    }
  });

  it('does not tell the admin to retry a plan-level webhook refusal', () => {
    // Retrying cannot add webhook_write to an Adobe account plan.
    const copy = adobeSignErrorCopy('webhook_registration_failed');
    expect(copy).not.toMatch(/try again/i);
    expect(copy).toMatch(/contact support/i);
  });

  it('falls back to the generic connect failure for an unknown code', () => {
    expect(adobeSignErrorCopy('something_new')).toBe(CONNECTIONS_LABELS.CONNECT_FAILED);
    expect(adobeSignErrorCopy(undefined)).toBe(CONNECTIONS_LABELS.CONNECT_FAILED);
  });
});
