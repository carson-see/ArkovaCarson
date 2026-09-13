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
 *   - a child organisation whose affiliation was REVOKED can request again.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { OrgProfilePage } from './OrgProfilePage';

const { mockOrganization, mockSubOrgCounts, mockSupabaseEq } = vi.hoisted(() => ({
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
    organizations: { data: { display_name: 'Global Holdings' }, error: null },
  };
  function chain(table: string) {
    const result = results[table] ?? { data: null, error: null };
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
      auth: { getSession: async () => ({ data: { session: null } }) },
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
vi.mock('@/components/org/ManageSubOrgs', () => ({
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
});
