import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ManageSubOrgs } from './ManageSubOrgs';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/workerClient', () => ({
  WORKER_URL: 'https://worker.test',
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
    },
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

const subOrgs = [
  {
    id: 'child-pending',
    display_name: 'Pending Clinic',
    domain: 'pending.example',
    verification_status: 'UNVERIFIED',
    parent_approval_status: 'PENDING',
    created_at: '2026-05-05T13:00:00.000Z',
    logo_url: null,
  },
  {
    id: 'child-approved',
    display_name: 'Approved Clinic',
    domain: 'approved.example',
    verification_status: 'UNVERIFIED',
    parent_approval_status: 'APPROVED',
    created_at: '2026-05-05T13:01:00.000Z',
    logo_url: null,
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setupFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const method = init?.method ?? 'GET';

    if (url === 'https://worker.test/api/v1/org/sub-orgs?orgId=org-parent' && method === 'GET') {
      return jsonResponse({ subOrgs });
    }

    if (url === 'https://worker.test/api/v1/org/sub-orgs/create' && method === 'POST') {
      return jsonResponse({ affiliateOrg: { ...subOrgs[1], id: 'child-created' } }, 201);
    }

    if (url === 'https://worker.test/api/v1/org/sub-orgs/approve' && method === 'POST') {
      return jsonResponse({ status: 'APPROVED', childOrgId: 'child-pending' });
    }

    if (url === 'https://worker.test/api/v1/org/sub-orgs/revoke' && method === 'POST') {
      return jsonResponse({ status: 'REVOKED', childOrgId: 'child-approved' });
    }

    return jsonResponse({ error: `unexpected ${method} ${url}` }, 500);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderLoaded() {
  render(<ManageSubOrgs orgId="org-parent" />);
  await screen.findByText('Pending Clinic');
}

describe('ManageSubOrgs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: 'token-123' } },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads affiliates using explicit parent org context', async () => {
    const fetchMock = setupFetch();

    await renderLoaded();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://worker.test/api/v1/org/sub-orgs?orgId=org-parent',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-123',
        }),
      }),
    );
    expect(screen.getByText('Approved Clinic')).toBeInTheDocument();
  });

  it('creates an affiliate with parent org context and assigned admin email', async () => {
    const fetchMock = setupFetch();
    const user = userEvent.setup();

    await renderLoaded();

    await user.type(screen.getByLabelText('Affiliate name'), 'New Clinic');
    await user.type(screen.getByLabelText('Affiliate admin email'), 'Admin@New.Example');
    await user.type(screen.getByLabelText('Legal name'), 'New Clinic Legal');
    await user.type(screen.getByLabelText('Domain'), 'New.Example');
    await user.click(screen.getByRole('button', { name: /Create Affiliate/i }));

    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith('Affiliate organization created.');
    });

    const createCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url) === 'https://worker.test/api/v1/org/sub-orgs/create' &&
      init?.method === 'POST',
    );
    expect(createCall).toBeDefined();
    expect(createCall?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer token-123',
    });
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      parentOrgId: 'org-parent',
      displayName: 'New Clinic',
      legalName: 'New Clinic Legal',
      domain: 'new.example',
      adminEmail: 'admin@new.example',
    });
    expect(fetchMock.mock.calls.filter(([url]) =>
      String(url) === 'https://worker.test/api/v1/org/sub-orgs?orgId=org-parent',
    )).toHaveLength(2);
  });

  it('does not post create when required fields are missing', async () => {
    const fetchMock = setupFetch();
    const user = userEvent.setup();

    await renderLoaded();
    await user.click(screen.getByRole('button', { name: /Create Affiliate/i }));

    expect(mocks.toastError).toHaveBeenCalledWith('Affiliate name and admin email are required.');
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url) === 'https://worker.test/api/v1/org/sub-orgs/create' &&
      init?.method === 'POST',
    )).toBe(false);
  });

  it('approves and revokes affiliates using explicit parent org context', async () => {
    const fetchMock = setupFetch();
    const user = userEvent.setup();

    await renderLoaded();

    await user.click(screen.getByRole('button', { name: /Approve/i }));
    await waitFor(() => {
      const approveCall = fetchMock.mock.calls.find(([url, init]) =>
        String(url) === 'https://worker.test/api/v1/org/sub-orgs/approve' &&
        init?.method === 'POST',
      );
      expect(JSON.parse(String(approveCall?.[1]?.body))).toEqual({
        childOrgId: 'child-pending',
        parentOrgId: 'org-parent',
      });
    });

    const revokeButtons = screen.getAllByRole('button', { name: /Revoke/i });
    await user.click(revokeButtons[revokeButtons.length - 1]);

    await waitFor(() => {
      const revokeCall = fetchMock.mock.calls.find(([url, init]) =>
        String(url) === 'https://worker.test/api/v1/org/sub-orgs/revoke' &&
        init?.method === 'POST',
      );
      expect(JSON.parse(String(revokeCall?.[1]?.body))).toEqual({
        childOrgId: 'child-approved',
        parentOrgId: 'org-parent',
      });
    });
  });
});
