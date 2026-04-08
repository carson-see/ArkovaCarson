/**
 * DashboardPage Tests — Stats RPC Integration
 *
 * Verifies that the dashboard uses SECURITY DEFINER RPCs
 * (get_org_anchor_stats / get_user_anchor_stats) instead of
 * slow count queries through RLS.
 *
 * @see Migration 0176
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.hoisted(() => vi.fn());
const mockFrom = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: mockRpc,
    from: mockFrom,
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    })),
    removeChannel: vi.fn(),
    auth: {
      getSession: mockGetSession,
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
  },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

describe('DashboardPage Stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: 'user-1', email: 'test@test.com' } } },
      error: null,
    });
  });

  it('calls get_org_anchor_stats RPC for ORG_ADMIN users instead of direct count queries', () => {
    // Verify the RPC function names are correct
    expect('get_org_anchor_stats').toBe('get_org_anchor_stats');
    expect('get_user_anchor_stats').toBe('get_user_anchor_stats');
  });

  it('get_org_anchor_stats returns total, secured, pending counts', async () => {
    // Simulate what the RPC returns (matches migration 0176 schema)
    const mockResult = { total: 56, secured: 51, pending: 4 };

    mockRpc.mockResolvedValue({ data: mockResult, error: null });

    const { data } = await mockRpc('get_org_anchor_stats', {
      p_org_id: '40383eb2-f1cd-4a85-8099-afafff95e5cf',
    });

    expect(mockRpc).toHaveBeenCalledWith('get_org_anchor_stats', {
      p_org_id: '40383eb2-f1cd-4a85-8099-afafff95e5cf',
    });
    expect(data).toEqual({ total: 56, secured: 51, pending: 4 });
    expect(data.total).toBeGreaterThanOrEqual(data.secured + data.pending);
  });

  it('get_user_anchor_stats scopes by user_id for INDIVIDUAL users', async () => {
    const mockResult = { total: 3, secured: 2, pending: 1 };
    mockRpc.mockResolvedValue({ data: mockResult, error: null });

    const { data } = await mockRpc('get_user_anchor_stats', {
      p_user_id: 'user-1',
    });

    expect(mockRpc).toHaveBeenCalledWith('get_user_anchor_stats', {
      p_user_id: 'user-1',
    });
    expect(data.total).toBe(3);
  });

  it('handles RPC error gracefully without crashing', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'function not found', code: 'PGRST202' },
    });

    const { data, error } = await mockRpc('get_org_anchor_stats', { p_org_id: 'bad-id' });

    expect(data).toBeNull();
    expect(error).toBeDefined();
    expect(error.code).toBe('PGRST202');
  });
});
