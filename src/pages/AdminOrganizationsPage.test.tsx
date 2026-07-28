/**
 * Tests for AdminOrganizationsPage — L2-A5 credit adjust UI
 *
 * Founder rule A2 ("everything with a UI component needs one"): this covers
 * the platform-admin credit add/remove control — balance display, the
 * amount/reason inputs, the confirmation step, and the API call shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AdminOrganizationsPage } from './AdminOrganizationsPage';
import { workerFetch } from '@/lib/workerClient';
import { toast } from 'sonner';

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

const ORG = {
  id: 'org-1',
  legal_name: null,
  display_name: 'Acme Credentials',
  domain: 'acme.example',
  org_prefix: 'ACME',
  verification_status: 'VERIFIED',
  member_count: 3,
  anchor_count: 12,
  is_test: false,
  anchor_quota: null,
  credit_balance: 100,
  created_at: '2026-01-01T00:00:00Z',
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

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockWorkerFetch = vi.mocked(workerFetch);

vi.mock('@/lib/workerClient', () => ({
  workerFetch: vi.fn(),
}));

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/organizations']}>
      <AdminOrganizationsPage />
    </MemoryRouter>,
  );
}

describe('AdminOrganizationsPage — credit adjust (L2-A5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProfile.is_platform_admin = true;
    // GET /api/admin/organizations — list fetch on mount.
    mockWorkerFetch.mockResolvedValue(
      jsonResponse({ organizations: [ORG], total: 1, page: 1, limit: 25 }),
    );
  });

  it('shows the org credit balance from the list response', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText('100').length).toBeGreaterThan(0));
  });

  it('opens the adjust dialog, reviews, and confirms a GRANT with the exact API payload', async () => {
    const user = userEvent.setup();
    // Second call = the credits/adjust POST.
    mockWorkerFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/credits/adjust')) {
        return jsonResponse({ success: true, balance: 150, adjusted: 50, entry_type: 'GRANT', idempotent: false });
      }
      return jsonResponse({ organizations: [ORG], total: 1, page: 1, limit: 25 });
    });

    renderPage();
    await waitFor(() => expect(screen.getAllByText('100').length).toBeGreaterThan(0));

    const adjustButtons = await screen.findAllByRole('button', { name: /Adjust credits/i });
    await user.click(adjustButtons[0]);

    expect(await screen.findByRole('heading', { name: 'Adjust credits' })).toBeInTheDocument();

    const amountInput = screen.getByLabelText('Amount');
    await user.clear(amountInput);
    await user.type(amountInput, '50');

    const reasonInput = screen.getByLabelText('Reason');
    await user.type(reasonInput, 'Promo credit for launch partner');

    await user.click(screen.getByRole('button', { name: 'Review' }));

    // Confirmation step shows the summary before any API call happens.
    expect(await screen.findByText(/Add 50 credits to Acme Credentials/)).toBeInTheDocument();
    expect(mockWorkerFetch).toHaveBeenCalledTimes(1); // only the initial list GET so far

    await user.click(screen.getByRole('button', { name: 'Confirm adjustment' }));

    await waitFor(() => {
      const adjustCall = mockWorkerFetch.mock.calls.find(([endpoint]) => (endpoint as string).includes('/credits/adjust'));
      expect(adjustCall).toBeDefined();
    });

    const [endpoint, options] = mockWorkerFetch.mock.calls.find(([e]) => (e as string).includes('/credits/adjust'))!;
    expect(endpoint).toBe('/api/admin/organizations/org-1/credits/adjust');
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.amount).toBe(50);
    expect(body.reason).toBe('Promo credit for launch partner');
    expect(typeof body.idempotency_key).toBe('string');
    expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/i);

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('sends a negative signed amount when Remove credits is selected', async () => {
    const user = userEvent.setup();
    mockWorkerFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/credits/adjust')) {
        return jsonResponse({ success: true, balance: 70, adjusted: -30, entry_type: 'REVOKE', idempotent: false });
      }
      return jsonResponse({ organizations: [ORG], total: 1, page: 1, limit: 25 });
    });

    renderPage();
    await waitFor(() => expect(screen.getAllByText('100').length).toBeGreaterThan(0));

    const adjustButtons = await screen.findAllByRole('button', { name: /Adjust credits/i });
    await user.click(adjustButtons[0]);

    await user.click(screen.getByRole('button', { name: 'Remove credits' }));
    await user.type(screen.getByLabelText('Amount'), '30');
    await user.type(screen.getByLabelText('Reason'), 'Clawback: mistaken grant');
    await user.click(screen.getByRole('button', { name: 'Review' }));

    expect(await screen.findByText(/Remove 30 credits from Acme Credentials/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm adjustment' }));

    await waitFor(() => {
      const adjustCall = mockWorkerFetch.mock.calls.find(([endpoint]) => (endpoint as string).includes('/credits/adjust'));
      expect(adjustCall).toBeDefined();
    });
    const [, options] = mockWorkerFetch.mock.calls.find(([e]) => (e as string).includes('/credits/adjust'))!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.amount).toBe(-30);
  });

  it('blocks Review until amount and reason are both filled', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByText('100').length).toBeGreaterThan(0));

    const adjustButtons = await screen.findAllByRole('button', { name: /Adjust credits/i });
    await user.click(adjustButtons[0]);

    await user.click(screen.getByRole('button', { name: 'Review' }));

    // Still on the input step — no confirmation summary, no extra API call.
    expect(screen.queryByText(/Add .* credits to/)).not.toBeInTheDocument();
    expect(mockWorkerFetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces a friendly error and does not close the dialog on insufficient_balance', async () => {
    const user = userEvent.setup();
    mockWorkerFetch.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/credits/adjust')) {
        return jsonResponse({ error: 'insufficient_balance', balance: 20, requested: -500 }, false, 409);
      }
      return jsonResponse({ organizations: [ORG], total: 1, page: 1, limit: 25 });
    });

    renderPage();
    await waitFor(() => expect(screen.getAllByText('100').length).toBeGreaterThan(0));

    const adjustButtons = await screen.findAllByRole('button', { name: /Adjust credits/i });
    await user.click(adjustButtons[0]);
    await user.click(screen.getByRole('button', { name: 'Remove credits' }));
    await user.type(screen.getByLabelText('Amount'), '500');
    await user.type(screen.getByLabelText('Reason'), 'oops');
    await user.click(screen.getByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Confirm adjustment' }));

    await waitFor(() => {
      const adjustCallIndex = mockWorkerFetch.mock.calls.findIndex(([endpoint]) => (endpoint as string).includes('/credits/adjust'));
      expect(adjustCallIndex).toBeGreaterThanOrEqual(0);
    });
    const adjustCallIndex = mockWorkerFetch.mock.calls.findIndex(([endpoint]) => (endpoint as string).includes('/credits/adjust'));
    const adjustResponse = await mockWorkerFetch.mock.results[adjustCallIndex].value;
    expect(adjustResponse.status).toBe(409);
    const adjustBody = await adjustResponse.json();
    expect(adjustBody.error).toBe('insufficient_balance');
    expect(toast.error).toHaveBeenCalledWith('Cannot remove more credits than the organization has.');
    // Dialog stays open on failure so the admin can correct the amount.
    expect(screen.getByRole('heading', { name: 'Adjust credits' })).toBeInTheDocument();
  });
});
