/**
 * SCRUM-3868 — the offboarding control in ManageSubOrgs.
 *
 * Offboarding moves money and suspends an organization, so it confirms first.
 * The two behaviours worth pinning are that it cannot fire without that
 * confirmation, and that a PARTIAL result (credits returned, suspend failed) is
 * reported as such — an operator who thinks nothing happened will retry blind.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ManageSubOrgs } from './ManageSubOrgs';
import { jsonResponse, requestUrl } from './__testHelpers';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/workerClient', () => ({ WORKER_URL: 'https://worker.test' }));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: mocks.getSession } } }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

const APPROVED = {
  id: 'child-approved',
  display_name: 'Nairobi Firm A',
  domain: 'firm-a.example',
  verification_status: 'UNVERIFIED',
  parent_approval_status: 'APPROVED',
  created_at: '2026-08-01T10:00:00Z',
  logo_url: null,
  docusignInherited: false,
};

function setupFetch(opts: { offboardStatus?: number; offboardBody?: unknown } = {}) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });

    if (url.includes('/sub-orgs/offboard')) {
      return jsonResponse(
        opts.offboardBody ?? { reclaimed: 40, suspended: true },
        opts.offboardStatus ?? 200,
      );
    }
    if (url.includes('/sub-orgs/credits')) return jsonResponse({ parentBalance: 100, children: [] });
    if (url.includes('/sub-orgs')) return jsonResponse({ subOrgs: [APPROVED] });
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

async function offboardButton() {
  const name = await screen.findByText('Nairobi Firm A');
  const row = name.closest('[data-testid="sub-org-row"]') as HTMLElement;
  return within(row).getByRole('button', { name: /^offboard$/i });
}

describe('ManageSubOrgs offboarding (SCRUM-3868)', () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: 't' } } });
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks before doing anything', async () => {
    const { calls } = setupFetch();
    const user = userEvent.setup();
    render(<ManageSubOrgs orgId="org-parent" />);

    await user.click(await offboardButton());

    expect(await screen.findByText(/offboard this organization\?/i)).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/offboard'))).toBe(false);
  });

  it('says plainly that secured documents are not removed', async () => {
    // The thing an operator most needs to be sure of before clicking.
    setupFetch();
    const user = userEvent.setup();
    render(<ManageSubOrgs orgId="org-parent" />);
    await user.click(await offboardButton());
    expect(await screen.findByText(/stay verifiable and are not removed/i)).toBeInTheDocument();
  });

  it('offboards on confirmation', async () => {
    const { calls } = setupFetch();
    const user = userEvent.setup();
    render(<ManageSubOrgs orgId="org-parent" />);

    await user.click(await offboardButton());
    await user.click(await screen.findByRole('button', { name: /offboard organization/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/offboard') && c.method === 'POST');
      expect(post?.body).toEqual({ childOrgId: 'child-approved' });
    });
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it('does nothing when the operator backs out', async () => {
    const { calls } = setupFetch();
    const user = userEvent.setup();
    render(<ManageSubOrgs orgId="org-parent" />);

    await user.click(await offboardButton());
    await user.click(await screen.findByRole('button', { name: /keep active/i }));

    await waitFor(() =>
      expect(screen.queryByText(/offboard this organization\?/i)).not.toBeInTheDocument());
    expect(calls.some((c) => c.url.includes('/offboard'))).toBe(false);
  });

  it('distinguishes a PARTIAL offboard from an outright failure', async () => {
    // Credits moved, suspend did not. Telling the operator "it failed" would
    // invite a blind retry on a half-done state.
    setupFetch({ offboardStatus: 403, offboardBody: { error: 'x', reclaimed: 40, suspended: false } });
    const user = userEvent.setup();
    render(<ManageSubOrgs orgId="org-parent" />);

    await user.click(await offboardButton());
    await user.click(await screen.findByRole('button', { name: /offboard organization/i }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringMatching(/credits were returned/i),
    ));
  });
});
