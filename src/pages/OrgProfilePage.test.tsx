/**
 * Tests for OrgProfilePage — SCRUM-3524 invite result handling
 *
 * `handleInvite` must propagate useInviteMember's boolean result to
 * InviteMemberModal (which keeps itself open and shows its inline Alert on
 * failure) and must only refresh the pending-invitations list on success.
 * useInviteMember never rethrows (SCRUM-1979 toast-safety), so the returned
 * boolean is the ONLY failure signal the modal can act on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { OrgProfilePage } from './OrgProfilePage';

const { mockInviteMember, mockRefreshInvitations, mockSupabaseEq } = vi.hoisted(() => ({
  mockInviteMember: vi.fn(),
  mockRefreshInvitations: vi.fn(),
  // Records every .eq(column, value) on the supabase mock chain so scoping
  // of the page's queries can be asserted (arkova/no-unscoped-service-test).
  mockSupabaseEq: vi.fn(),
}));

// Captured from the mocked InviteMemberModal below — this is exactly the
// `handleInvite` callback the page wires into the modal's `onInvite` prop.
let capturedOnInvite:
  | ((email: string, role: 'INDIVIDUAL' | 'ORG_ADMIN') => Promise<boolean>)
  | null = null;

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'admin@acme.example' },
    loading: false,
    signOut: vi.fn(),
  }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: {
      id: 'user-1',
      full_name: 'Org Admin',
      role: 'ORG_ADMIN',
      org_id: 'org-1',
      is_platform_admin: false,
    },
    loading: false,
  }),
}));

vi.mock('@/hooks/useOrganization', () => ({
  useOrganization: () => ({
    organization: {
      id: 'org-1',
      display_name: 'Acme Credentials',
      domain: 'acme.example',
      verification_status: 'UNVERIFIED',
      created_at: '2026-01-01T00:00:00Z',
    },
    updating: false,
    updateOrganization: vi.fn(),
  }),
}));

vi.mock('@/hooks/useOrgMembers', () => ({
  useOrgMembers: () => ({ members: [], loading: false, refreshMembers: vi.fn() }),
}));

vi.mock('@/hooks/useOrgInvitations', () => ({
  useOrgInvitations: () => ({
    invitations: [],
    loading: false,
    refreshInvitations: mockRefreshInvitations,
  }),
}));

vi.mock('@/hooks/useAdminOrgMembers', () => ({
  useAdminOrgMembers: () => ({ members: [], loading: false, refreshMembers: vi.fn() }),
}));

vi.mock('@/hooks/useRevokeAnchor', () => ({
  useRevokeAnchor: () => ({ revokeAnchor: vi.fn() }),
}));

vi.mock('@/hooks/useInviteMember', () => ({
  useInviteMember: () => ({
    inviteMember: mockInviteMember,
    loading: false,
    error: null,
    clearError: vi.fn(),
  }),
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
    org_members: { data: { role: 'admin' }, error: null },
    anchors: { count: 0, error: null, data: null },
    organizations: { data: { display_name: 'Parent Org' }, error: null },
  };
  function chain(table: string) {
    const result = results[table] ?? { data: null, error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = {};
    for (const m of ['select', 'is', 'update', 'order', 'limit']) {
      c[m] = () => c;
    }
    c.eq = (...args: unknown[]) => {
      mockSupabaseEq(...args);
      return c;
    };
    c.single = () => Promise.resolve(result);
    // The anchors count query awaits the builder itself (thenable).
    c.then = (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject);
    return c;
  }
  return {
    supabase: {
      from: (table: string) => chain(table),
      auth: { getSession: async () => ({ data: { session: null } }) },
      storage: {
        from: () => ({
          upload: vi.fn(),
          getPublicUrl: () => ({ data: { publicUrl: '' } }),
        }),
      },
    },
  };
});

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/layout/ArkovaLogo', () => ({
  ArkovaIcon: () => null,
}));

vi.mock('@/components/organization', () => ({
  OrgRegistryTable: () => null,
  MembersTable: () => null,
  PendingInvitationsList: () => null,
  IssueCredentialForm: () => null,
  RevokeDialog: () => null,
  AddExistingMemberModal: () => null,
  InviteMemberModal: (props: {
    onInvite: (email: string, role: 'INDIVIDUAL' | 'ORG_ADMIN') => Promise<boolean>;
  }) => {
    capturedOnInvite = props.onInvite;
    return null;
  },
}));

vi.mock('@/components/anchor', () => ({
  SecureDocumentDialog: () => null,
}));

vi.mock('@/components/org/OrgVerification', () => ({ OrgVerification: () => null }));
vi.mock('@/components/org/ManageSubOrgs', () => ({ ManageSubOrgs: () => null }));
vi.mock('@/components/org/RequestAffiliationDialog', () => ({
  RequestAffiliationDialog: () => null,
}));
vi.mock('@/components/shared/VerifiedBadge', () => ({
  OrgVerifiedBadge: () => null,
  AffiliatedBadge: () => null,
}));
vi.mock('@/components/integrations/DriveConnectorCard', () => ({
  DriveConnectorCard: () => null,
}));
vi.mock('@/components/integrations/DocusignConnectorCard', () => ({
  DocusignConnectorCard: () => null,
}));
vi.mock('@/components/integrations/MemberDocusignConnectorCard', () => ({
  MemberDocusignConnectorCard: () => null,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/organizations/org-1']}>
      <Routes>
        <Route path="/organizations/:orgId" element={<OrgProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OrgProfilePage — handleInvite result handling (SCRUM-3524)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnInvite = null;
  });

  it('returns true and refreshes invitations when inviteMember succeeds', async () => {
    mockInviteMember.mockResolvedValue(true);
    renderPage();
    await waitFor(() => expect(capturedOnInvite).not.toBeNull());

    let result: boolean | undefined;
    await act(async () => {
      result = await capturedOnInvite!('new@example.com', 'INDIVIDUAL');
    });

    expect(mockInviteMember).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'new@example.com',
        role: 'INDIVIDUAL',
        orgId: 'org-1',
      }),
    );
    expect(result).toBe(true);
    expect(mockRefreshInvitations).toHaveBeenCalledTimes(1);

    // The admin-gating role lookup must stay scoped to this viewer and org —
    // the client-side mirror of the org_members RLS policy.
    expect(mockSupabaseEq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(mockSupabaseEq).toHaveBeenCalledWith('org_id', 'org-1');
  });

  it('returns false and does not refresh invitations when inviteMember fails', async () => {
    mockInviteMember.mockResolvedValue(false);
    renderPage();
    await waitFor(() => expect(capturedOnInvite).not.toBeNull());

    let result: boolean | undefined;
    await act(async () => {
      result = await capturedOnInvite!('new@example.com', 'INDIVIDUAL');
    });

    expect(result).toBe(false);
    expect(mockRefreshInvitations).not.toHaveBeenCalled();
  });
});
