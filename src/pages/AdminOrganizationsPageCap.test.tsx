/**
 * SCRUM-4474 — the document cap is independent of the billing flag.
 *
 * Before this, `org_credits.is_test` meant two unrelated things at once:
 * "never bill this org through Stripe" (meteredBilling.ts) and "enforce this
 * org's anchor_quota" (anchorQuotaGate.ts). The admin UI welded them together —
 * turning the cap on wrote is_test = true — so a billable customer with a
 * contractual cap could not be expressed at all. HakiChain, invoiced and capped
 * at 2,000 documents, had to be flagged a TEST org to get its cap enforced,
 * which silently removed it from metered billing.
 *
 * These pin the three things that were wrong: the badge keyed on the wrong
 * flag, it called every cap "free", and saving clobbered the billing flag.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AdminOrganizationsPage } from './AdminOrganizationsPage';
import { workerFetch } from '@/lib/workerClient';

const mockUser = { email: 'carson@arkova.ai' };
const mockProfile = {
  full_name: 'Admin',
  role: 'ORG_ADMIN',
  org_id: null,
  public_id: 'admin-1',
  is_public_profile: false,
  avatar_url: null,
  is_platform_admin: true,
};

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: mockUser, loading: false, signOut: vi.fn() }),
}));
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ profile: mockProfile, loading: false, destination: '/dashboard' as const, updateProfile: vi.fn() }),
  ProfileProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/workerClient', () => ({ workerFetch: vi.fn() }));

const mockWorkerFetch = vi.mocked(workerFetch);

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

function org(over: Record<string, unknown> = {}) {
  return {
    id: 'org-1',
    legal_name: null,
    display_name: 'HakiChain',
    domain: 'hakichain.com',
    org_prefix: 'HAK',
    verification_status: 'VERIFIED',
    member_count: 1,
    anchor_count: 4,
    is_test: false,
    anchor_quota: null,
    cap_enforced: false,
    credit_balance: 5,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function renderWith(o: Record<string, unknown>) {
  mockWorkerFetch.mockResolvedValue(jsonResponse({ organizations: [o], total: 1, page: 1, limit: 25 }));
  return render(
    <MemoryRouter initialEntries={['/admin/organizations']}>
      <AdminOrganizationsPage />
    </MemoryRouter>,
  );
}

describe('AdminOrganizationsPage — document cap vs billing flag (SCRUM-4474)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProfile.is_platform_admin = true;
  });

  // The page renders a desktop table AND a mobile card list, so every cell
  // appears twice. Assert on the set, not on a single node.
  it('shows the cap for a BILLABLE capped org — the state that was unrepresentable', async () => {
    renderWith(org({ anchor_quota: 2000, cap_enforced: true, is_test: false, anchor_count: 4 }));
    expect((await screen.findAllByText('4/2000')).length).toBeGreaterThan(0);
  });

  it('does NOT call a billable org\'s cap "free"', async () => {
    renderWith(org({ anchor_quota: 2000, cap_enforced: true, is_test: false }));
    await screen.findAllByText('4/2000');
    expect(screen.queryAllByText(/\d+\/\d+\s+free/i)).toHaveLength(0);
  });

  it('still says "free" for a genuine test org', async () => {
    renderWith(org({ anchor_quota: 10, cap_enforced: true, is_test: true, anchor_count: 3 }));
    expect((await screen.findAllByText('3/10 free')).length).toBeGreaterThan(0);
  });

  it('reads Uncapped when a quota is recorded but NOT enforced', async () => {
    // The Login Defense shape: anchor_quota = 15 on record, inert. Showing a
    // cap here would imply an enforcement that does not happen.
    renderWith(org({ display_name: 'Login Defense', anchor_quota: 15, cap_enforced: false, is_test: false }));
    expect((await screen.findAllByText('Uncapped')).length).toBeGreaterThan(0);
  });

  it('sends cap and billing as INDEPENDENT fields, leaving is_test alone', async () => {
    const user = userEvent.setup();
    renderWith(org({ anchor_quota: 2000, cap_enforced: true, is_test: false }));
    await screen.findAllByText('4/2000');

    mockWorkerFetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    await user.click(screen.getAllByRole('button', { name: /cap/i })[0]);

    const save = await screen.findByRole('button', { name: /^save$/i });
    await user.click(save);

    await waitFor(() => {
      const call = mockWorkerFetch.mock.calls.find((c) => String(c[0]).includes('/quota'));
      expect(call).toBeDefined();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      // The bug: this used to send is_test: true purely because a cap was set.
      expect(body).toEqual({ anchor_quota: 2000, cap_enforced: true, is_test: false });
    });
  });
});
