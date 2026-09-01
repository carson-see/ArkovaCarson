/**
 * SCRUM-3865 — the sub-org credit control in ManageSubOrgs.
 *
 * Pre-mortem F3: the panel could list children and toggle approval but could
 * not move a single credit, so the parent admin had no way to fund a client
 * org. These tests pin the control that closes that.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ManageSubOrgs } from './ManageSubOrgs';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/workerClient', () => ({ WORKER_URL: 'https://worker.test' }));
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: mocks.getSession } },
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

const subOrgs = [
  {
    id: 'child-approved',
    display_name: 'Nairobi Firm A',
    domain: 'firm-a.example',
    verification_status: 'UNVERIFIED',
    parent_approval_status: 'APPROVED',
    created_at: '2026-05-05T13:01:00.000Z',
    logo_url: null,
  },
  {
    id: 'child-pending',
    display_name: 'Pending Clinic',
    domain: 'pending.example',
    verification_status: 'UNVERIFIED',
    parent_approval_status: 'PENDING',
    created_at: '2026-05-05T13:00:00.000Z',
    logo_url: null,
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

interface FetchOptions {
  rollup?: unknown;
  rollupStatus?: number;
  allocate?: unknown;
  allocateStatus?: number;
}

function setupFetch(opts: FetchOptions = {}) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });

    if (url.startsWith('https://worker.test/api/v1/org/sub-orgs/credits') && method === 'GET') {
      return jsonResponse(
        opts.rollup ?? {
          parentBalance: 100,
          children: [{ childOrgId: 'child-approved', balance: 25, monthlyAllocation: 0 }],
        },
        opts.rollupStatus ?? 200,
      );
    }
    if (url.startsWith('https://worker.test/api/v1/org/sub-orgs/credits') && method === 'POST') {
      return jsonResponse(
        opts.allocate ?? { parentBalance: 90, childBalance: 35, amount: 10 },
        opts.allocateStatus ?? 200,
      );
    }
    if (url.startsWith('https://worker.test/api/v1/org/sub-orgs?') && method === 'GET') {
      return jsonResponse({ subOrgs });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

/** The row for an approved sub-org, which is where the credit control lives. */
async function approvedRow() {
  const name = await screen.findByText('Nairobi Firm A');
  return name.closest('[data-testid="sub-org-row"]') as HTMLElement;
}

describe('ManageSubOrgs credit control (SCRUM-3865)', () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: 'token-abc' } },
    });
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the parent balance and each sub-org balance', async () => {
    setupFetch();
    render(<ManageSubOrgs orgId="org-parent" />);

    // The count follows the panel's existing `<strong>{n}</strong> label`
    // idiom, so the string is split across elements — match on textContent.
    // Nested spans both satisfy the predicate; one match is enough.
    const balanceEls = await screen.findAllByText((_content, el) =>
      el?.tagName === 'SPAN' && /100\s+credits available/i.test(el.textContent ?? ''));
    expect(balanceEls.length).toBeGreaterThan(0);

    const row = await approvedRow();
    expect(within(row).getByText(/25 credits/i)).toBeInTheDocument();
  });

  it('allocates credits and sends the amount to the worker', async () => {
    const { calls } = setupFetch();
    const user = userEvent.setup();
    render(<ManageSubOrgs orgId="org-parent" />);

    const row = await approvedRow();
    await user.type(within(row).getByLabelText(/credits to move/i), '10');
    await user.click(within(row).getByRole('button', { name: /^add credits$/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes('/sub-orgs/credits'));
      expect(post?.body).toEqual({ childOrgId: 'child-approved', amount: 10 });
    });
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it('reclaims by sending a negative amount', async () => {
    const { calls } = setupFetch({ allocate: { parentBalance: 110, childBalance: 15, amount: -10 } });
    const user = userEvent.setup();
    render(<ManageSubOrgs orgId="org-parent" />);

    const row = await approvedRow();
    await user.type(within(row).getByLabelText(/credits to move/i), '10');
    await user.click(within(row).getByRole('button', { name: /reclaim/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes('/sub-orgs/credits'));
      expect(post?.body).toEqual({ childOrgId: 'child-approved', amount: -10 });
    });
  });

  it('surfaces an insufficient-balance rejection instead of failing silently', async () => {
    setupFetch({ allocate: { error: 'insufficient_parent_balance' }, allocateStatus: 409 });
    const user = userEvent.setup();
    render(<ManageSubOrgs orgId="org-parent" />);

    const row = await approvedRow();
    await user.type(within(row).getByLabelText(/credits to move/i), '9999');
    await user.click(within(row).getByRole('button', { name: /^add credits$/i }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
  });

  it('does not offer a credit control for a sub-org that is not approved', async () => {
    setupFetch();
    render(<ManageSubOrgs orgId="org-parent" />);

    const pending = await screen.findByText('Pending Clinic');
    const row = pending.closest('[data-testid="sub-org-row"]') as HTMLElement;
    expect(within(row).queryByLabelText(/credits to move/i)).not.toBeInTheDocument();
  });

  it('renders the list even when the rollup call fails', async () => {
    setupFetch({ rollup: { error: 'boom' }, rollupStatus: 500 });
    render(<ManageSubOrgs orgId="org-parent" />);

    // Credit provisioning is additive: a rollup outage must not take out the
    // approve/revoke panel that already worked.
    expect(await screen.findByText('Nairobi Firm A')).toBeInTheDocument();
  });
});
