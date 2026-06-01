/**
 * AddExistingMemberModal Tests
 *
 * Covers:
 *  - admin path (useAdminEndpoints): search + add route through workerFetch, not Supabase
 *  - standard path: membership guard queries `org_members` (NOT the non-existent
 *    `org_memberships`) and add goes through the add_org_member RPC
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockFrom = vi.hoisted(() => vi.fn());
const mockRpc = vi.hoisted(() => vi.fn());
const mockWorkerFetch = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
}));

vi.mock('@/lib/workerClient', () => ({
  workerFetch: mockWorkerFetch,
}));

import { AddExistingMemberModal } from './AddExistingMemberModal';

// Valid RFC-4122 v4 UUIDs (zod's .uuid() validates version + variant nibbles).
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    orgId: ORG_ID,
    onMemberAdded: vi.fn(),
    ...overrides,
  };
}

describe('AddExistingMemberModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('admin path (useAdminEndpoints)', () => {
    it('searches via the worker admin endpoint, not Supabase', async () => {
      mockWorkerFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user: { id: USER_ID, email: 'found@acme.com', full_name: 'Found User' } }),
      });

      render(<AddExistingMemberModal {...baseProps({ useAdminEndpoints: true })} />);

      fireEvent.change(screen.getByPlaceholderText('user@example.com'), {
        target: { value: 'found@acme.com' },
      });
      fireEvent.click(screen.getByRole('button', { name: /search/i }));

      await waitFor(() => {
        expect(mockWorkerFetch).toHaveBeenCalledWith(
          '/api/admin/users/search?email=found%40acme.com',
          { method: 'GET' },
        );
      });
      // Supabase must NOT be used on the admin search path.
      expect(mockFrom).not.toHaveBeenCalled();
      expect(await screen.findByText('Found User')).toBeInTheDocument();
    });

    it('adds via POST to the worker admin endpoint', async () => {
      // First call: search. Second call: add.
      mockWorkerFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ user: { id: USER_ID, email: 'found@acme.com', full_name: 'Found User' } }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });

      render(<AddExistingMemberModal {...baseProps({ useAdminEndpoints: true })} />);

      fireEvent.change(screen.getByPlaceholderText('user@example.com'), {
        target: { value: 'found@acme.com' },
      });
      fireEvent.click(screen.getByRole('button', { name: /search/i }));

      const addBtn = await screen.findByRole('button', { name: /add to organization/i });
      fireEvent.click(addBtn);

      await waitFor(() => {
        expect(mockWorkerFetch).toHaveBeenCalledWith(
          `/api/admin/organizations/${ORG_ID}/members`,
          expect.objectContaining({ method: 'POST' }),
        );
      });
      // RPC must NOT be used on the admin add path.
      expect(mockRpc).not.toHaveBeenCalled();
    });
  });

  describe('standard path (org member)', () => {
    it('checks membership against org_members (not org_memberships)', async () => {
      // profiles search → found; org_members guard → not a member
      const profilesQuery = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({
          data: [{ id: USER_ID, email: 'found@acme.com', full_name: 'Found User' }],
          error: null,
        }),
      };
      const orgMembersQuery = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      };

      const tablesQueried: string[] = [];
      mockFrom.mockImplementation((table: string) => {
        tablesQueried.push(table);
        if (table === 'profiles') return profilesQuery;
        if (table === 'org_members') return orgMembersQuery;
        throw new Error(`unexpected table ${table}`);
      });

      render(<AddExistingMemberModal {...baseProps()} />);

      fireEvent.change(screen.getByPlaceholderText('user@example.com'), {
        target: { value: 'found@acme.com' },
      });
      fireEvent.click(screen.getByRole('button', { name: /search/i }));

      expect(await screen.findByText('Found User')).toBeInTheDocument();
      // The membership guard must hit org_members, never org_memberships.
      expect(tablesQueried).toContain('org_members');
      expect(tablesQueried).not.toContain('org_memberships');
      // Standard path does not call the worker admin endpoints.
      expect(mockWorkerFetch).not.toHaveBeenCalled();
    });
  });
});
