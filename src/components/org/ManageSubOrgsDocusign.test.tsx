/**
 * SCRUM-3867 — the DocuSign inheritance toggle in ManageSubOrgs.
 *
 * The control lives on the PARENT's panel, not the sub-org's connector card,
 * because the parent is the party lending its connection. A sub-org that cannot
 * hold its own DocuSign account (no Organization on an Enhanced plan) gets
 * connector-sourced documents only through this.
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

function subOrg(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'child-approved',
    display_name: 'Nairobi Firm A',
    domain: 'firm-a.example',
    verification_status: 'UNVERIFIED',
    parent_approval_status: 'APPROVED',
    created_at: '2026-08-01T10:00:00Z',
    logo_url: null,
    docusignInherited: false,
    ...over,
  };
}

function setupFetch(opts: { subOrgs?: unknown[]; inheritStatus?: number; inheritBody?: unknown } = {}) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });

    if (url.includes('/docusign/inherit')) {
      return jsonResponse(opts.inheritBody ?? { inherited: true }, opts.inheritStatus ?? 201);
    }
    if (url.includes('/sub-orgs/credits')) {
      return jsonResponse({ parentBalance: 100, children: [] });
    }
    if (url.includes('/sub-orgs')) {
      return jsonResponse({ subOrgs: opts.subOrgs ?? [subOrg()] });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

async function row() {
  const name = await screen.findByText('Nairobi Firm A');
  return name.closest('[data-testid="sub-org-row"]') as HTMLElement;
}

describe('ManageSubOrgs DocuSign inheritance toggle (SCRUM-3867)', () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offers to share the connection when the sub-org is not inheriting', async () => {
    setupFetch();
    render(<ManageSubOrgs orgId="org-parent" />);
    expect(within(await row()).getByRole('button', { name: /share our docusign/i }))
      .toBeInTheDocument();
  });

  it('establishes inheritance and names the sub-org to the worker', async () => {
    const { calls } = setupFetch();
    const user = userEvent.setup();
    render(<ManageSubOrgs orgId="org-parent" />);

    await user.click(within(await row()).getByRole('button', { name: /share our docusign/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes('/docusign/inherit'));
      expect(post?.url).not.toContain('/stop');
      expect(post?.body).toEqual({ org_id: 'child-approved' });
    });
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it('offers to stop when the sub-org is already inheriting', async () => {
    const { calls } = setupFetch({ subOrgs: [subOrg({ docusignInherited: true })] });
    const user = userEvent.setup();
    render(<ManageSubOrgs orgId="org-parent" />);

    await user.click(within(await row()).getByRole('button', { name: /stop sharing/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.includes('/docusign/inherit/stop'));
      expect(post?.body).toEqual({ org_id: 'child-approved' });
    });
  });

  it('surfaces a refusal rather than silently doing nothing', async () => {
    // parent_not_connected is the common real case: you cannot lend a
    // connection you do not have.
    setupFetch({ inheritStatus: 409, inheritBody: { error: 'parent_not_connected' } });
    const user = userEvent.setup();
    render(<ManageSubOrgs orgId="org-parent" />);

    await user.click(within(await row()).getByRole('button', { name: /share our docusign/i }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
  });

  it('offers no connection control for a sub-org that is not approved', async () => {
    setupFetch({
      subOrgs: [subOrg({ parent_approval_status: 'PENDING' })],
    });
    render(<ManageSubOrgs orgId="org-parent" />);
    expect(within(await row()).queryByRole('button', { name: /share our docusign/i }))
      .not.toBeInTheDocument();
  });
});
