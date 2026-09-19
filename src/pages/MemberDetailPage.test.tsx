import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { MemberDetailPage } from './MemberDetailPage';

const workerFetch = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
const eq = vi.hoisted(() => vi.fn());
vi.mock('@/lib/workerClient', () => ({ workerFetch }));
vi.mock('@/lib/supabase', () => ({ supabase: { from } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'actor' }, signOut: vi.fn() }) }));
vi.mock('@/hooks/useProfile', () => ({ useProfile: () => ({ profile: {}, loading: false }) }));
vi.mock('@/hooks/useActiveOrg', () => ({ useActiveOrg: () => ({ orgId: '11111111-1111-4111-8111-111111111111', loading: false }) }));
vi.mock('@/hooks/useOrganization', () => ({ useOrganization: (id: string) => ({ organization: { id, name: 'Child Org' } }) }));
vi.mock('@/components/layout', () => ({ AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>, ArkovaIcon: () => null }));

function anchorQuery() {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'is', 'order']) chain[method] = vi.fn(() => chain);
  chain.eq = eq.mockImplementation(() => chain);
  chain.limit = vi.fn(async () => ({ data: [], error: null }));
  return chain;
}

describe('MemberDetailPage selected membership context', () => {
  beforeEach(() => { vi.clearAllMocks(); from.mockReturnValue(anchorQuery()); });

  it('uses the explicit descendant context and accepts a secondary membership', async () => {
    workerFetch.mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes('member-context') ? { member: {
      id: '22222222-2222-4222-8222-222222222222', email: 'member@example.com', full_name: 'Secondary Member',
      avatar_url: null, role: 'INDIVIDUAL', created_at: '2026-01-01T00:00:00Z',
      org_id: '33333333-3333-4333-8333-333333333333', membership_role: 'member',
    } } : { folders: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    render(<MemoryRouter initialEntries={['/organization/member/22222222-2222-4222-8222-222222222222?org_id=33333333-3333-4333-8333-333333333333']}>
      <Routes><Route path="/organization/member/:memberId" element={<MemberDetailPage/>}/></Routes>
    </MemoryRouter>);
    expect(await screen.findByText('Secondary Member')).toBeVisible();
    expect(workerFetch).toHaveBeenCalledWith(expect.stringContaining('context_org_id=33333333-3333-4333-8333-333333333333'));
    expect(eq).toHaveBeenCalledWith('user_id', '22222222-2222-4222-8222-222222222222');
    expect(eq).toHaveBeenCalledWith('org_id', '33333333-3333-4333-8333-333333333333');
  });

  it('fails closed and clears the old member when the response context is malformed', async () => {
    workerFetch.mockResolvedValue(new Response(JSON.stringify({ member: { id: 'wrong' } }), { status: 200 }));
    render(<MemoryRouter initialEntries={['/organization/member/22222222-2222-4222-8222-222222222222?org_id=33333333-3333-4333-8333-333333333333']}>
      <Routes><Route path="/organization/member/:memberId" element={<MemberDetailPage/>}/></Routes>
    </MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/not found/i)).toBeVisible());
    expect(screen.queryByText('Secondary Member')).not.toBeInTheDocument();
  });
});
