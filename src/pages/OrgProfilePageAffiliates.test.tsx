/**
 * OrgProfilePage — the Affiliates tab (founder feedback 2026-09-13).
 *
 * The sub-organisation panel used to live at the bottom of the Settings tab.
 * Measured from the shipped build (docs/uat/suborg-ux/discoverability-*.json),
 * its heading sat 2,396 px down at 1280 px and 2,996 px down at 375 px — three
 * and 3.7 viewport-heights of scrolling — behind fifteen unrelated settings
 * fields, the verification card and four connector cards, on a page whose tab
 * row said only Home / People / Settings. A parent admin with an affiliation
 * request waiting had nothing on any screen telling them so.
 *
 * These tests pin the navigation contract, not the panel's internals:
 *   - the tab exists and is reachable by name and by `?tab=affiliates`;
 *   - it carries the pending-request count so the queue is visible from the
 *     tab row itself;
 *   - the panel is no longer rendered inside Settings;
 *   - a child organisation whose affiliation was REVOKED can request again;
 *   - a PENDING child never sees the request-again control (no duplicate
 *     request while one is outstanding);
 *   - the `organizations` table only grants SELECT to members of that org
 *     (`organizations_select_member`, `supabase/migrations/00000000000000_baseline_at_main_HEAD.sql`),
 *     and a child's members are never added to the parent's `org_members` —
 *     only the reverse happens, when a parent creates a new affiliate
 *     (`buildAffiliateMembershipRows` in `services/worker/src/api/v1/orgSubOrgs.ts`).
 *     So `fetchParentOrgName`'s direct `.from('organizations')` read is RLS-blocked
 *     for the child side in the overwhelmingly common case, and PostgREST
 *     returns zero rows rather than an error. CTO review (2026-09-13): the
 *     "real name" tests above use a mock that always resolves — a fair test of
 *     the render logic given data, but it does not prove the data ever
 *     arrives. The RLS-blocked tests below cover what actually reaches most
 *     users: a graceful fallback to the generic label, never a crash or a
 *     leaked `undefined`. Making the real name reach the client for real
 *     needs a SECURITY DEFINER RPC narrower than `search_organizations_public`
 *     (e.g. child-scoped, returning only `display_name` for the caller's own
 *     `parent_org_id`) — a backend change, out of scope for this frontend-only
 *     PR.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { OrgProfilePage } from './OrgProfilePage';
import { SUB_ORG_LABELS } from '@/lib/copy';
import { toast } from 'sonner';

const { mockOrganization, mockSubOrgCounts, mockSupabaseEq, mockOrgNameQueryResult, mockSession } = vi.hoisted(() => ({
  // What `supabase.auth.getSession()` resolves to. `null` (signed-out shape) is
  // the default the navigation tests were written against; the cancel tests
  // below put a real token in so the cancel handler reaches its fetch.
  mockSession: { current: null as { access_token: string } | null },
  // Records every .eq(column, value) so the page's own queries can be asserted
  // to be scoped (arkova/no-unscoped-service-test).
  mockSupabaseEq: vi.fn(),
  mockOrganization: {
    current: {
      id: 'org-1',
      display_name: 'Northwind Group',
      domain: 'northwind.example',
      verification_status: 'VERIFIED',
      created_at: '2026-01-01T00:00:00Z',
      parent_org_id: null as string | null,
      parent_approval_status: null as string | null,
    } as Record<string, unknown>,
  },
  // What the mocked ManageSubOrgs reports up through `onCountsChange`.
  mockSubOrgCounts: { current: { pending: 2, approved: 1 } as { pending: number; approved: number } | null },
  // What `.from('organizations').select('display_name').eq('id', parentOrgId).single()`
  // resolves to. Defaults to a successful read; the RLS-blocked tests below
  // override it to what PostgREST actually returns when the row is denied by
  // RLS — no error, zero rows, `.single()` resolves `data: null`.
  mockOrgNameQueryResult: {
    current: { data: { display_name: 'Global Holdings' }, error: null } as {
      data: { display_name: string } | null;
      error: unknown;
    },
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'admin@northwind.example' }, loading: false, signOut: vi.fn() }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: { id: 'user-1', full_name: 'Dana Parent', role: 'ORG_ADMIN', org_id: 'org-1', is_platform_admin: false },
    loading: false,
  }),
}));

vi.mock('@/hooks/useOrganization', () => ({
  useOrganization: () => ({
    organization: mockOrganization.current,
    updating: false,
    updateOrganization: vi.fn(),
  }),
}));

vi.mock('@/hooks/useOrgMembers', () => ({
  useOrgMembers: () => ({ members: [], loading: false, refreshMembers: vi.fn() }),
}));
vi.mock('@/hooks/useOrgInvitations', () => ({
  useOrgInvitations: () => ({ invitations: [], loading: false, refreshInvitations: vi.fn() }),
}));
vi.mock('@/hooks/useAdminOrgMembers', () => ({
  useAdminOrgMembers: () => ({ members: [], loading: false, refreshMembers: vi.fn() }),
}));
vi.mock('@/hooks/useRevokeAnchor', () => ({ useRevokeAnchor: () => ({ revokeAnchor: vi.fn() }) }));
vi.mock('@/hooks/useInviteMember', () => ({
  useInviteMember: () => ({ inviteMember: vi.fn(), loading: false, error: null, clearError: vi.fn() }),
}));
vi.mock('@/hooks/useCanIssueCredential', () => ({
  useCanIssueCredential: () => ({ allowed: false, loading: false }),
}));
vi.mock('@/hooks/useIssueCredentialSplit', () => ({
  useIssueCredentialSplit: () => ({ enabled: false, loading: false }),
}));

vi.mock('@/lib/workerClient', () => ({
  WORKER_URL: 'http://localhost:8080',
  workerFetch: vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
}));

vi.mock('@/lib/supabase', () => {
  const results: Record<string, unknown> = {
    org_members: { data: { role: 'owner' }, error: null },
    anchors: { count: 0, error: null, data: null },
  };
  function chain(table: string) {
    // `organizations` is looked up dynamically (not from the static `results`
    // map above) so a test can swap in the RLS-blocked response without a
    // second vi.mock factory.
    const result = table === 'organizations' ? mockOrgNameQueryResult.current : (results[table] ?? { data: null, error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = {};
    for (const m of ['select', 'is', 'update', 'order', 'limit']) c[m] = () => c;
    c.eq = (...args: unknown[]) => {
      mockSupabaseEq(...args);
      return c;
    };
    c.single = () => Promise.resolve(result);
    c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return c;
  }
  return {
    supabase: {
      from: (table: string) => chain(table),
      auth: { getSession: async () => ({ data: { session: mockSession.current } }) },
      storage: {
        from: () => ({ upload: vi.fn(), getPublicUrl: () => ({ data: { publicUrl: '' } }) }),
      },
    },
  };
});

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/layout/ArkovaLogo', () => ({ ArkovaIcon: () => null }));
vi.mock('@/components/organization', () => ({
  OrgRegistryTable: () => null,
  MembersTable: () => null,
  PendingInvitationsList: () => null,
  IssueCredentialForm: () => null,
  RevokeDialog: () => null,
  AddExistingMemberModal: () => null,
  InviteMemberModal: () => null,
}));
vi.mock('@/components/anchor', () => ({ SecureDocumentDialog: () => null }));
vi.mock('@/components/org/OrgVerification', () => ({ OrgVerification: () => null }));

// Stand-in for the real panel: renders a marker and pushes the counts up the
// same way the real component does, so the tab badge can be asserted here
// without this file depending on the panel's fetch behaviour.
// Only the component is replaced. The module also exports the real
// `translateWorkerError`, which the page's cancel handler calls — a factory
// that omitted it would leave that import `undefined` and quietly turn every
// mapped worker code into the generic fallback, which is exactly the
// distinction these tests exist to pin.
vi.mock('@/components/org/ManageSubOrgs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/org/ManageSubOrgs')>()),
  ManageSubOrgs: ({
    onCountsChange,
  }: {
    onCountsChange?: (c: { pending: number; approved: number } | null) => void;
  }) => {
    onCountsChange?.(mockSubOrgCounts.current);
    return <div data-testid="manage-sub-orgs" />;
  },
}));

vi.mock('@/components/org/RequestAffiliationDialog', () => ({ RequestAffiliationDialog: () => null }));
vi.mock('@/components/shared/VerifiedBadge', () => ({
  OrgVerifiedBadge: () => null,
  AffiliatedBadge: () => null,
}));
vi.mock('@/components/integrations/DriveConnectorCard', () => ({ DriveConnectorCard: () => null }));
vi.mock('@/components/integrations/DocusignConnectorCard', () => ({ DocusignConnectorCard: () => null }));
vi.mock('@/components/integrations/MemberDocusignConnectorCard', () => ({
  MemberDocusignConnectorCard: () => null,
}));
vi.mock('@/components/integrations/AdobeSignConnectorCard', () => ({
  AdobeSignConnectorCard: () => null,
  adobeSignErrorCopy: () => null,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderPage(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/organizations/org-1${search}`]}>
      <Routes>
        <Route path="/organizations/:orgId" element={<OrgProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OrgProfilePage — Affiliates tab (founder feedback 2026-09-13)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrganization.current = {
      id: 'org-1',
      display_name: 'Northwind Group',
      domain: 'northwind.example',
      verification_status: 'VERIFIED',
      created_at: '2026-01-01T00:00:00Z',
      parent_org_id: null,
      parent_approval_status: null,
    };
    mockSubOrgCounts.current = { pending: 2, approved: 1 };
    mockOrgNameQueryResult.current = { data: { display_name: 'Global Holdings' }, error: null };
    mockSession.current = null;
  });

  it('offers Affiliates in the org tab row', async () => {
    renderPage();
    expect(await screen.findByRole('tab', { name: /Affiliates/ })).toBeInTheDocument();
    // The role lookup behind the tab is scoped to this user AND this org —
    // the tab is admin-only, so an unscoped read would widen who sees it.
    expect(mockSupabaseEq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(mockSupabaseEq).toHaveBeenCalledWith('org_id', 'org-1');
  });

  it('opens the panel from the tab in one click', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('tab', { name: /Affiliates/ }));

    expect(await screen.findByTestId('manage-sub-orgs')).toBeInTheDocument();
  });

  it('is deep-linkable with ?tab=affiliates', async () => {
    renderPage('?tab=affiliates');
    expect(await screen.findByTestId('manage-sub-orgs')).toBeInTheDocument();
  });

  it('shows the pending-request count on the tab itself', async () => {
    const user = userEvent.setup();
    renderPage('?tab=affiliates');

    const badge = await screen.findByLabelText('2 affiliation requests awaiting your approval');
    expect(badge).toHaveTextContent('2');
    // Still there after navigating away — the point is that it is visible
    // without opening the tab.
    await user.click(screen.getByRole('tab', { name: 'Home' }));
    expect(screen.getByLabelText('2 affiliation requests awaiting your approval')).toBeInTheDocument();
  });

  it('shows no count when there is nothing waiting', async () => {
    mockSubOrgCounts.current = { pending: 0, approved: 3 };
    renderPage('?tab=affiliates');

    await screen.findByTestId('manage-sub-orgs');
    expect(screen.queryByLabelText(/awaiting your approval/)).not.toBeInTheDocument();
  });

  it('shows no count when the panel could not load — never a reassuring zero', async () => {
    mockSubOrgCounts.current = null;
    renderPage('?tab=affiliates');

    await screen.findByTestId('manage-sub-orgs');
    expect(screen.queryByLabelText(/awaiting your approval/)).not.toBeInTheDocument();
  });

  it('no longer buries the panel in the Settings tab', async () => {
    const user = userEvent.setup();
    renderPage('?tab=settings');

    // Settings is the open tab…
    await screen.findByText('Organization Settings');
    // …and the panel is no longer anywhere inside it.
    expect(screen.queryByTestId('manage-sub-orgs')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Affiliates/ }));
    expect(await screen.findByTestId('manage-sub-orgs')).toBeInTheDocument();
  });

  it('lets a REVOKED child request affiliation again', async () => {
    mockOrganization.current = {
      ...mockOrganization.current,
      parent_org_id: 'org-parent',
      parent_approval_status: 'REVOKED',
    };
    renderPage('?tab=affiliates');

    expect(await screen.findByRole('button', { name: 'Request Affiliation Again' })).toBeInTheDocument();
  });

  it('names the parent organization for a REVOKED child instead of the word "parent organization"', async () => {
    mockOrganization.current = {
      ...mockOrganization.current,
      parent_org_id: 'org-parent',
      parent_approval_status: 'REVOKED',
    };
    renderPage('?tab=affiliates');

    expect(await screen.findByText('Global Holdings')).toBeInTheDocument();
    expect(screen.queryByText('parent organization')).not.toBeInTheDocument();
  });

  it('names the parent organization for a PENDING child too', async () => {
    mockOrganization.current = {
      ...mockOrganization.current,
      parent_org_id: 'org-parent',
      parent_approval_status: 'PENDING',
    };
    renderPage('?tab=affiliates');

    expect(await screen.findByText('Global Holdings')).toBeInTheDocument();
    expect(screen.queryByText('parent organization')).not.toBeInTheDocument();
  });

  // A PENDING child already has an outstanding request. The control that
  // re-opens RequestAffiliationDialog is gated on `!isChildOrg ||
  // parentApprovalStatus === 'REVOKED'` — PENDING satisfies neither, so it
  // must not render. A second concurrent request is not something the worker
  // needs to reject if the UI never offers it.
  it('does not let a PENDING child request affiliation again while one request is outstanding', async () => {
    mockOrganization.current = {
      ...mockOrganization.current,
      parent_org_id: 'org-parent',
      parent_approval_status: 'PENDING',
    };
    renderPage('?tab=affiliates');

    await screen.findByText('Global Holdings');
    expect(screen.queryByRole('button', { name: /Request Affiliation/ })).not.toBeInTheDocument();
    // The only affiliation-scoped control offered mid-request is Cancel.
    expect(screen.getByRole('button', { name: 'Cancel Request' })).toBeInTheDocument();
  });

  // `organizations_select_member` (baseline RLS) grants SELECT only to org
  // ids in `get_user_org_ids()` — the org_members rows for the CURRENT user.
  // A child's members are never added to the parent's org_members (only the
  // reverse, when a parent creates a new affiliate — see file header), so in
  // the common case this query is denied and PostgREST's `.single()` resolves
  // `data: null` with no thrown error, not a populated row. These two tests
  // use that real shape instead of the always-succeeds mock the tests above
  // use, and pin the fallback the page actually ships in that case.
  describe('when the parent-name read is RLS-blocked (the common real case)', () => {
    beforeEach(() => {
      mockOrgNameQueryResult.current = { data: null, error: null };
    });

    it('falls back to the generic label for a REVOKED child, not a blank or "undefined"', async () => {
      mockOrganization.current = {
        ...mockOrganization.current,
        parent_org_id: 'org-parent',
        parent_approval_status: 'REVOKED',
      };
      renderPage('?tab=affiliates');

      expect(await screen.findByText('parent organization')).toBeInTheDocument();
      expect(screen.queryByText('Global Holdings')).not.toBeInTheDocument();
      expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
    });

    it('falls back to the generic label for a PENDING child, not a blank or "undefined"', async () => {
      mockOrganization.current = {
        ...mockOrganization.current,
        parent_org_id: 'org-parent',
        parent_approval_status: 'PENDING',
      };
      renderPage('?tab=affiliates');

      expect(await screen.findByText('parent organization')).toBeInTheDocument();
      expect(screen.queryByText('Global Holdings')).not.toBeInTheDocument();
      expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
    });
  });
});

/**
 * Cancelling a pending affiliation request — pre-existing silent failure.
 *
 * The handler behind "Cancel Request" toasted only on `response.ok` and had an
 * empty `catch { // Handle silently }`. Every other outcome — a 500 from the
 * worker, a 403 for a non-admin, a 400 because the parent already approved the
 * request in another tab, a dropped connection — produced no toast, no console
 * output and no state change. The button looked inert and the request stayed
 * pending, which is the one thing a user cancelling cannot be allowed to
 * misread.
 *
 * The block was relocated from the Settings tab to the Affiliates tab by the
 * founder-feedback pass above; the silence predates it and is fixed here. The
 * shape is the same one the panel's own handlers use: `translateWorkerError`
 * for the body's `error`, the generic fallback for anything unrecognised or
 * for a throw, and nothing written to `console.log`.
 */
describe('OrgProfilePage — cancelling a pending affiliation request', () => {
  let reloadSpy: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  function jsonResponse(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockOrganization.current = {
      id: 'org-1',
      display_name: 'Northwind Group',
      domain: 'northwind.example',
      verification_status: 'VERIFIED',
      created_at: '2026-01-01T00:00:00Z',
      parent_org_id: 'org-parent',
      parent_approval_status: 'PENDING',
    };
    mockSubOrgCounts.current = { pending: 0, approved: 0 };
    mockOrgNameQueryResult.current = { data: { display_name: 'Global Holdings' }, error: null };
    // A signed-in admin: without a token the handler returns before its fetch.
    mockSession.current = { access_token: 'token-abc' };

    reloadSpy = vi.fn();
    // jsdom's location.reload is not implemented; replace it with a spy
    // (same approach as src/lib/lazyWithRetry.test.ts).
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { ...globalThis.location, reload: reloadSpy },
    });

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function clickCancel() {
    const user = userEvent.setup();
    renderPage('?tab=affiliates');
    await user.click(await screen.findByRole('button', { name: 'Cancel Request' }));
  }

  it('tells the user when the worker refuses the cancellation', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'Failed to cancel request' }));

    await clickCancel();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/api/v1/org/sub-orgs/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(toast.error).toHaveBeenCalledWith(SUB_ORG_LABELS.CANCEL_FAILED);
    expect(toast.success).not.toHaveBeenCalled();
    // The request is still pending, so the page must not be reloaded into a
    // view that implies otherwise.
    expect(reloadSpy).not.toHaveBeenCalled();
    // No debug channel stands in for user-facing feedback.
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('translates a recognised worker code instead of echoing it', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: 'Admin permissions required' }));

    await clickCancel();

    expect(toast.error).toHaveBeenCalledWith(SUB_ORG_LABELS.ERROR_NOT_ADMIN);
    // A mapped code is known copy, not an anomaly worth logging.
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('falls back to the generic copy for an unmapped worker reply, and logs the raw value', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: 'No pending affiliation request to cancel' }),
    );

    await clickCancel();

    expect(toast.error).toHaveBeenCalledWith(SUB_ORG_LABELS.CANCEL_FAILED);
    // translateWorkerError surfaces the unrecognised reply to the console so a
    // new worker code is visible to engineers without reaching the user.
    expect(consoleErrorSpy).toHaveBeenCalledWith('[sub-orgs] unmapped worker error', 'No pending affiliation request to cancel');
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('tells the user when the request never reaches the worker', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await clickCancel();

    expect(toast.error).toHaveBeenCalledWith(SUB_ORG_LABELS.CANCEL_FAILED);
    expect(toast.success).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('tells the user when an error reply carries no JSON body', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });

    await clickCancel();

    expect(toast.error).toHaveBeenCalledWith(SUB_ORG_LABELS.CANCEL_FAILED);
    // What the user reads names the action that failed — an unparseable body
    // must not degrade into a blank or a bare "Error".
    expect(String(vi.mocked(toast.error).mock.calls[0]?.[0])).toContain('cancel');
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('still confirms and reloads on success', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: 'cancelled' }));

    await clickCancel();

    expect(toast.success).toHaveBeenCalledWith(SUB_ORG_LABELS.CANCEL_SUCCESS);
    expect(toast.error).not.toHaveBeenCalled();
    expect(reloadSpy).toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});
