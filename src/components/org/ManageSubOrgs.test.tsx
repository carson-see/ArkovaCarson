/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT (organizations_update_admin + protect_org_tenancy_fields trigger, migration 0429), not manual org_id/user_id query scoping. The row is targeted by primary key (`.eq('id', childOrgId)`, asserted below); Postgres RLS decides who may touch it. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ManageSubOrgs } from './ManageSubOrgs';
import { jsonResponse, requestUrl } from './__testHelpers';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  // SCRUM-3864 — `useAffiliateListingConsent` drives the parent-side listing
  // toggle through `supabase.from('organizations').update().eq().select()`.
  from: vi.fn(),
}));

vi.mock('@/lib/workerClient', () => ({
  WORKER_URL: 'https://worker.test',
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
    },
    from: mocks.from,
  },
}));

vi.mock('@/lib/auditLog', () => ({
  logAuditEvent: vi.fn(),
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
    // SCRUM-3864 — we have opted in, the child has not yet.
    sub_org_listing_parent_optin: true,
    sub_org_listing_child_optin: false,
  },
];


function setupFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
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

  // ---------------------------------------------------------------------------
  // Initial-load error state (sibling of SCRUM-1999, which fixed the same
  // silent-empty anti-pattern in OrgRegistryTable + ReportsList).
  //
  // Previously `fetchSubOrgs` handled a load failure with `if (!response.ok)
  // return;` + an empty `catch`, leaving an empty list with no signal — the
  // outage/denial masqueraded as "No affiliated organizations yet." These tests
  // assert an explicit `role="alert"` banner + Retry is shown instead, and that
  // the misleading empty state is NOT. Action errors keep using toast (covered
  // by the create/approve/revoke tests above) and are intentionally untouched.
  // ---------------------------------------------------------------------------

  it('surfaces an explicit error state (not the empty list) when the initial load returns !ok', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = init?.method ?? 'GET';
      if (url === 'https://worker.test/api/v1/org/sub-orgs?orgId=org-parent' && method === 'GET') {
        return jsonResponse({ error: 'boom' }, 500);
      }
      return jsonResponse({ error: `unexpected ${method} ${url}` }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ManageSubOrgs orgId="org-parent" />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toMatch(/couldn.?t load|unable to load|something went wrong/i);
    // The misleading empty state must NOT be shown.
    expect(screen.queryByText(/no affiliated organizations yet/i)).toBeNull();
    // A retry affordance is offered.
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeTruthy();
  });

  it('surfaces the error state when the initial load throws (network/parse failure)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ManageSubOrgs orgId="org-parent" />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toMatch(/couldn.?t load|unable to load|something went wrong/i);
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeTruthy();
    expect(screen.queryByText(/no affiliated organizations yet/i)).toBeNull();
  });

  it('clears the error and renders the list when Retry succeeds after a transient failure', async () => {
    let getCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = init?.method ?? 'GET';
      if (url === 'https://worker.test/api/v1/org/sub-orgs?orgId=org-parent' && method === 'GET') {
        getCalls += 1;
        return getCalls === 1 ? jsonResponse({ error: 'boom' }, 500) : jsonResponse({ subOrgs });
      }
      return jsonResponse({ error: `unexpected ${method} ${url}` }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<ManageSubOrgs orgId="org-parent" />);

    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: /try again|retry/i }));

    // The list now renders and the error banner is gone.
    expect(await screen.findByText('Pending Clinic')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(getCalls).toBe(2);
  });

  it('shows the empty state (no alert) when the initial load succeeds with no affiliates', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = init?.method ?? 'GET';
      if (url === 'https://worker.test/api/v1/org/sub-orgs?orgId=org-parent' && method === 'GET') {
        return jsonResponse({ subOrgs: [] });
      }
      return jsonResponse({ error: `unexpected ${method} ${url}` }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ManageSubOrgs orgId="org-parent" />);

    expect(await screen.findByText(/no affiliated organizations yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not raise the load-error banner when a post-action refetch fails (action errors stay on toast)', async () => {
    let getCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = init?.method ?? 'GET';
      if (url === 'https://worker.test/api/v1/org/sub-orgs?orgId=org-parent' && method === 'GET') {
        getCount += 1;
        // Initial load succeeds; the post-approve refetch fails transiently.
        return getCount === 1 ? jsonResponse({ subOrgs }) : jsonResponse({ error: 'boom' }, 500);
      }
      if (url === 'https://worker.test/api/v1/org/sub-orgs/approve' && method === 'POST') {
        return jsonResponse({ status: 'APPROVED', childOrgId: 'child-pending' });
      }
      return jsonResponse({ error: `unexpected ${method} ${url}` }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<ManageSubOrgs orgId="org-parent" />);
    await screen.findByText('Pending Clinic');

    await user.click(screen.getByRole('button', { name: /Approve/i }));

    // The action succeeded (toast); the failed refetch must NOT wipe the list or
    // raise the full-panel error banner — that path is initial-load/Retry only.
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith('Organization approved as affiliate.');
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Approved Clinic')).toBeInTheDocument();
    expect(getCount).toBe(2);
  });

  // SCRUM-3864 — parent's half of the two-party public-listing consent.
  describe('public listing consent', () => {
    it('shows the waiting-on-child status when we have opted in but the child has not', async () => {
      const fetchMock = setupFetch();
      await renderLoaded();
      void fetchMock;

      expect(screen.getByTestId('listing-consent-child-approved-status'))
        .toHaveTextContent('Waiting on the affiliated organization to also allow this.');
    });

    it('does not render the listing toggle for a PENDING affiliation', async () => {
      const fetchMock = setupFetch();
      await renderLoaded();
      void fetchMock;

      expect(screen.queryByTestId('listing-consent-child-pending-status')).toBeNull();
    });

    it('toggling off calls supabase.from("organizations").update on the CHILD org id and updates the row optimistically on success', async () => {
      const fetchMock = setupFetch();
      const eqMock = vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({
          data: [{ id: 'child-approved', sub_org_listing_parent_optin: false }],
          error: null,
        }),
      });
      const updateMock = vi.fn().mockReturnValue({ eq: eqMock });
      mocks.from.mockReturnValue({ update: updateMock });

      const user = userEvent.setup();
      await renderLoaded();
      void fetchMock;

      await user.click(screen.getByRole('switch'));

      await waitFor(() => {
        expect(mocks.from).toHaveBeenCalledWith('organizations');
      });
      expect(updateMock).toHaveBeenCalledWith({ sub_org_listing_parent_optin: false });
      expect(eqMock).toHaveBeenCalledWith('id', 'child-approved');

      await waitFor(() => {
        expect(screen.getByTestId('listing-consent-child-approved-status'))
          .toHaveTextContent('Not shown on public pages');
      });
    });

    it('a zero-row response (RLS/trigger rejection) leaves the switch unchanged and surfaces a toast', async () => {
      const fetchMock = setupFetch();
      mocks.from.mockReturnValue({
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            select: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      });

      const user = userEvent.setup();
      await renderLoaded();
      void fetchMock;

      await user.click(screen.getByRole('switch'));

      await waitFor(() => {
        expect(mocks.toastError).toHaveBeenCalled();
      });
      // Status text is unchanged — the optimistic write never landed.
      expect(screen.getByTestId('listing-consent-child-approved-status'))
        .toHaveTextContent('Waiting on the affiliated organization to also allow this.');
    });
  });
});
