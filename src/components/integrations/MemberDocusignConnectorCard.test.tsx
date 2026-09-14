/**
 * MemberDocusignConnectorCard tests (SCRUM-2044)
 *
 * This card shipped without unit coverage; the only checks on it were the
 * `member-docusign-card` testid in the OrgProfilePage suites (which mock the
 * whole component away) and an E2E spec. These tests pin the behaviour that
 * matters before the card adopts the shared status row / connection hook:
 * the member-scoped table and provider filter, the credential-free column
 * projection, the OAuth redirect contract and the disconnect side effects.
 *
 * Mirrors AdobeSignConnectorCard.test.tsx's harness. The member card has no
 * entitlement gate — per-member DocuSign is not gated on org KYB — so there is
 * no `useCanIssueCredential` mock here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { toast } from 'sonner';
import { MemberDocusignConnectorCard } from './MemberDocusignConnectorCard';
import { CONNECTIONS_LABELS } from '@/lib/copy';

const supabaseQuery = {
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  is: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn(),
};
const supabaseFrom = vi.fn(() => supabaseQuery);

vi.mock('@/lib/supabase', () => ({
  supabase: { from: (...args: unknown[]) => supabaseFrom(...(args as [])) },
}));

const workerFetch = vi.fn();
vi.mock('@/lib/workerClient', () => ({
  workerFetch: (...args: unknown[]) => workerFetch(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const ORG_ID = '11111111-2222-3333-4444-555555555555';
const LOAD_FAILURE = 'Unable to load personal DocuSign connection status.';

const CONNECTED_ROW = {
  id: 'mi-1',
  account_label: 'signer@example.test',
  account_id: 'acct-9',
  connected_at: '2026-09-01T00:00:00.000Z',
  scope: 'signature',
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('MemberDocusignConnectorCard', () => {
  let assignSpy: ReturnType<typeof vi.fn>;
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    supabaseFrom.mockReturnValue(supabaseQuery);
    supabaseQuery.select.mockReturnThis();
    supabaseQuery.eq.mockReturnThis();
    supabaseQuery.is.mockReturnThis();
    supabaseQuery.order.mockReturnThis();
    supabaseQuery.limit.mockReturnThis();
    supabaseQuery.maybeSingle.mockResolvedValue({ data: null, error: null });

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
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('reads the member-scoped table for this org and provider only', async () => {
    render(<MemberDocusignConnectorCard orgId={ORG_ID} />);

    await waitFor(() => expect(supabaseQuery.maybeSingle).toHaveBeenCalled());
    expect(supabaseFrom).toHaveBeenCalledWith('member_integrations');
    expect(supabaseQuery.eq).toHaveBeenCalledWith('org_id', ORG_ID);
    expect(supabaseQuery.eq).toHaveBeenCalledWith('provider', 'docusign');
    expect(supabaseQuery.is).toHaveBeenCalledWith('revoked_at', null);
  });

  it('never selects credential-bearing columns', async () => {
    render(<MemberDocusignConnectorCard orgId={ORG_ID} />);

    await waitFor(() => expect(supabaseQuery.select).toHaveBeenCalled());
    const projection = supabaseQuery.select.mock.calls[0][0] as string;
    for (const column of ['encrypted_tokens', 'token_kms_key_id', 'token_secret_name', 'webhook_id']) {
      expect(projection).not.toContain(column);
    }
  });

  it('renders the disconnected state with a Connect button', async () => {
    render(<MemberDocusignConnectorCard orgId={ORG_ID} />);

    await waitFor(() =>
      expect(screen.getByText(CONNECTIONS_LABELS.STATUS_NOT_CONNECTED)).toBeInTheDocument(),
    );
    expect(screen.getByText(CONNECTIONS_LABELS.MEMBER_DOCUSIGN_NAME)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: CONNECTIONS_LABELS.CONNECT_BUTTON })).toBeEnabled();
  });

  it('renders the account label when connected', async () => {
    supabaseQuery.maybeSingle.mockResolvedValue({ data: CONNECTED_ROW, error: null });
    render(<MemberDocusignConnectorCard orgId={ORG_ID} />);

    await waitFor(() =>
      expect(screen.getByText(CONNECTIONS_LABELS.STATUS_CONNECTED)).toBeInTheDocument(),
    );
    expect(
      screen.getByText(`${CONNECTIONS_LABELS.ACCOUNT_LABEL_PREFIX}${CONNECTED_ROW.account_label}`),
    ).toBeInTheDocument();
  });

  it('falls back to the account id when no label is stored', async () => {
    supabaseQuery.maybeSingle.mockResolvedValue({
      data: { ...CONNECTED_ROW, account_label: null },
      error: null,
    });
    render(<MemberDocusignConnectorCard orgId={ORG_ID} />);

    await waitFor(() =>
      expect(
        screen.getByText(`${CONNECTIONS_LABELS.ACCOUNT_LABEL_PREFIX}${CONNECTED_ROW.account_id}`),
      ).toBeInTheDocument(),
    );
  });

  it('surfaces a status query failure', async () => {
    supabaseQuery.maybeSingle.mockResolvedValue({ data: null, error: { message: 'nope' } });
    render(<MemberDocusignConnectorCard orgId={ORG_ID} />);

    await waitFor(() => expect(screen.getByText(LOAD_FAILURE)).toBeInTheDocument());
  });

  it('redirects to the member OAuth start URL on connect', async () => {
    workerFetch.mockResolvedValue(
      jsonResponse({ authorizationUrl: 'https://account.docusign.com/oauth/auth?x=1' }),
    );
    render(<MemberDocusignConnectorCard orgId={ORG_ID} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: CONNECTIONS_LABELS.CONNECT_BUTTON })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: CONNECTIONS_LABELS.CONNECT_BUTTON }));

    await waitFor(() =>
      expect(assignSpy).toHaveBeenCalledWith('https://account.docusign.com/oauth/auth?x=1'),
    );
    expect(workerFetch).toHaveBeenCalledWith(
      '/api/v1/integrations/docusign/member/oauth/start',
      expect.objectContaining({ method: 'POST' }),
    );
    const sent = JSON.parse(workerFetch.mock.calls[0][1].body as string);
    expect(sent).toEqual({ org_id: ORG_ID, return_to: window.location.href });
  });

  it('shows the worker error when connect is refused', async () => {
    workerFetch.mockResolvedValue(jsonResponse({ error: 'Member seat required' }, 403));
    render(<MemberDocusignConnectorCard orgId={ORG_ID} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: CONNECTIONS_LABELS.CONNECT_BUTTON })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: CONNECTIONS_LABELS.CONNECT_BUTTON }));

    await waitFor(() => expect(screen.getByText('Member seat required')).toBeInTheDocument());
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it('falls back to generic connect copy when the response carries no URL', async () => {
    workerFetch.mockResolvedValue(jsonResponse({}));
    render(<MemberDocusignConnectorCard orgId={ORG_ID} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: CONNECTIONS_LABELS.CONNECT_BUTTON })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: CONNECTIONS_LABELS.CONNECT_BUTTON }));

    await waitFor(() =>
      expect(screen.getByText(CONNECTIONS_LABELS.CONNECT_FAILED)).toBeInTheDocument(),
    );
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it('clears the connection and toasts on disconnect', async () => {
    supabaseQuery.maybeSingle.mockResolvedValue({ data: CONNECTED_ROW, error: null });
    workerFetch.mockResolvedValue(jsonResponse({ ok: true }));
    render(<MemberDocusignConnectorCard orgId={ORG_ID} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: CONNECTIONS_LABELS.DISCONNECT_BUTTON })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: CONNECTIONS_LABELS.DISCONNECT_BUTTON }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(CONNECTIONS_LABELS.MEMBER_TOAST_DISCONNECTED),
    );
    expect(workerFetch).toHaveBeenCalledWith(
      '/api/v1/integrations/docusign/member/disconnect',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.getByText(CONNECTIONS_LABELS.STATUS_NOT_CONNECTED)).toBeInTheDocument();
  });

  it('keeps the connection and shows the error when disconnect fails', async () => {
    supabaseQuery.maybeSingle.mockResolvedValue({ data: CONNECTED_ROW, error: null });
    workerFetch.mockResolvedValue(jsonResponse({ error: 'DocuSign refused' }, 502));
    render(<MemberDocusignConnectorCard orgId={ORG_ID} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: CONNECTIONS_LABELS.DISCONNECT_BUTTON })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: CONNECTIONS_LABELS.DISCONNECT_BUTTON }));

    await waitFor(() => expect(screen.getByText('DocuSign refused')).toBeInTheDocument());
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByText(CONNECTIONS_LABELS.STATUS_CONNECTED)).toBeInTheDocument();
  });

  it('falls back to generic disconnect copy when the worker sends no error', async () => {
    supabaseQuery.maybeSingle.mockResolvedValue({ data: CONNECTED_ROW, error: null });
    workerFetch.mockResolvedValue(jsonResponse({}, 500));
    render(<MemberDocusignConnectorCard orgId={ORG_ID} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: CONNECTIONS_LABELS.DISCONNECT_BUTTON })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: CONNECTIONS_LABELS.DISCONNECT_BUTTON }));

    await waitFor(() =>
      expect(screen.getByText(CONNECTIONS_LABELS.DISCONNECT_FAILED)).toBeInTheDocument(),
    );
  });
});
