/**
 * Sub-organisation panel findability + clarity (founder feedback 2026-09-13:
 * "when I try and use sub orgs it's clunky and confusing").
 *
 * The UAT walk in `docs/uat/suborg-ux/FINDINGS.md` found no missing capability
 * — every parent-side action already existed — so nothing here tests a new
 * endpoint. What it pins is the set of things that made the existing actions
 * hard to use safely:
 *
 *   - the job an admin arrives to do (approve a waiting request) was below a
 *     four-field create form they did not come to fill in;
 *   - Revoke fired immediately while the gentler Offboard beside it confirmed;
 *   - neither destructive confirmation named the organization, and at 375 px
 *     the row name truncates to ~8 characters;
 *   - worker replies were echoed verbatim, so an operator could be shown
 *     `sub_org_limit_reached`;
 *   - the count read "1 affiliated organizations" and omitted the pending ones
 *     entirely, which is the number the admin is actually looking for.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ManageSubOrgs, type SubOrgCounts } from './ManageSubOrgs';
import { jsonResponse, requestUrl } from './__testHelpers';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/workerClient', () => ({ WORKER_URL: 'https://worker.test' }));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: mocks.getSession } } }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

const PENDING = {
  id: 'child-pending',
  display_name: 'Contoso Legal',
  domain: 'contoso-legal.example',
  verification_status: 'VERIFIED',
  parent_approval_status: 'PENDING',
  created_at: '2026-09-01T00:00:00.000Z',
  logo_url: null,
};

const APPROVED = {
  id: 'child-approved',
  display_name: 'Fabrikam Compliance',
  domain: 'fabrikam.example',
  verification_status: 'VERIFIED',
  parent_approval_status: 'APPROVED',
  created_at: '2026-08-01T00:00:00.000Z',
  logo_url: null,
  docusignInherited: false,
};

interface FetchOpts {
  subOrgs?: unknown[];
  /** Status + body the /create call answers with. */
  createStatus?: number;
  createBody?: unknown;
  /** Status + body the /revoke call answers with. */
  revokeStatus?: number;
  revokeBody?: unknown;
}

function setupFetch(opts: FetchOpts = {}) {
  const subOrgs = opts.subOrgs ?? [PENDING, APPROVED];
  const calls: { url: string; method: string; body?: unknown }[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });

    if (url.startsWith('https://worker.test/api/v1/org/sub-orgs?') && method === 'GET') {
      return jsonResponse({ subOrgs });
    }
    if (url.startsWith('https://worker.test/api/v1/org/sub-orgs/credits?') && method === 'GET') {
      return jsonResponse({
        parentBalance: 4200,
        children: [{ childOrgId: APPROVED.id, balance: 150 }],
      });
    }
    if (url.includes('/sub-orgs/create')) {
      return jsonResponse(opts.createBody ?? { affiliateOrg: {} }, opts.createStatus ?? 201);
    }
    if (url.includes('/sub-orgs/revoke')) {
      return jsonResponse(opts.revokeBody ?? { status: 'REVOKED' }, opts.revokeStatus ?? 200);
    }
    if (url.includes('/sub-orgs/approve')) return jsonResponse({ status: 'APPROVED' });
    if (url.includes('/sub-orgs/offboard')) {
      return jsonResponse({ reclaimed: 150, suspended: true });
    }
    return jsonResponse({ error: `unexpected ${method} ${url}` }, 500);
  });

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

async function renderLoaded(
  props: { onCountsChange?: (c: SubOrgCounts | null) => void } = {},
) {
  render(<ManageSubOrgs orgId="org-parent" {...props} />);
  await screen.findByText('Fabrikam Compliance');
}

/** The row for one affiliate, addressed by its visible name. */
function rowFor(name: string): HTMLElement {
  const rows = screen.getAllByTestId('sub-org-row');
  const match = rows.find((r) => within(r).queryByText(name));
  if (!match) throw new Error(`no sub-org row for ${name}`);
  return match;
}

describe('ManageSubOrgs — findability and clarity (founder feedback 2026-09-13)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'token-123' } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── The list comes first ───────────────────────────────────────────────────

  it('renders the affiliate list ABOVE the create form', async () => {
    setupFetch();
    await renderLoaded();

    const firstRow = screen.getAllByTestId('sub-org-row')[0];
    const addControl = screen.getByRole('button', { name: 'Add an organization' });

    // Node.compareDocumentPosition: 4 = addControl FOLLOWS firstRow.
    expect(firstRow.compareDocumentPosition(addControl) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it('keeps the four create fields behind a disclosure until asked for', async () => {
    setupFetch();
    const user = userEvent.setup();
    await renderLoaded();

    expect(screen.queryByLabelText('Affiliate name')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add an organization' }));

    expect(screen.getByLabelText('Affiliate name')).toBeInTheDocument();
    expect(screen.getByLabelText('Affiliate admin email')).toBeInTheDocument();
    expect(screen.getByLabelText('Legal name')).toBeInTheDocument();
    expect(screen.getByLabelText('Domain')).toBeInTheDocument();
    // Says what naming an admin actually causes to happen.
    expect(
      screen.getByText(
        'The admin you name here is emailed an invitation to activate the new organization.',
      ),
    ).toBeInTheDocument();
  });

  // ── Counts ────────────────────────────────────────────────────────────────

  it('counts one affiliate in the singular and states the pending count separately', async () => {
    setupFetch();
    await renderLoaded();

    expect(screen.getByText('affiliated organization')).toBeInTheDocument();
    expect(screen.queryByText('affiliated organizations')).not.toBeInTheDocument();
    expect(screen.getByText('request awaiting your approval')).toBeInTheDocument();
  });

  it('pluralises the pending count', async () => {
    setupFetch({ subOrgs: [PENDING, { ...PENDING, id: 'p2', display_name: 'Tailspin Ltd' }, APPROVED] });
    await renderLoaded();

    expect(screen.getByText('requests awaiting your approval')).toBeInTheDocument();
  });

  it('reports the counts to the parent page so a tab can badge them', async () => {
    const onCountsChange = vi.fn();
    setupFetch();
    await renderLoaded({ onCountsChange });

    await waitFor(() => {
      expect(onCountsChange).toHaveBeenCalledWith({ pending: 1, approved: 1 });
    });
  });

  it('reports null counts — never zero — when the list could not be loaded', async () => {
    const onCountsChange = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'nope' }, 500)));
    render(<ManageSubOrgs orgId="org-parent" onCountsChange={onCountsChange} />);

    await screen.findByText("Couldn't load affiliated organizations");
    expect(onCountsChange).toHaveBeenCalledWith(null);
    expect(onCountsChange).not.toHaveBeenCalledWith({ pending: 0, approved: 0 });
  });

  // ── Destructive actions ───────────────────────────────────────────────────

  it('asks before revoking, and names the organization in the question', async () => {
    const { calls } = setupFetch();
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(within(rowFor('Fabrikam Compliance')).getByRole('button', { name: /Revoke/ }));

    expect(screen.getByText('End the affiliation with Fabrikam Compliance?')).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/sub-orgs/revoke'))).toBe(false);
  });

  it('says what revoking does, and does not claim it stops them securing documents', async () => {
    setupFetch();
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(within(rowFor('Fabrikam Compliance')).getByRole('button', { name: /Revoke/ }));

    const body = screen.getByText(/They stop being an affiliated organization of yours/);
    expect(body).toHaveTextContent('their secured documents stay verifiable');
    // Suspension is what Offboard does. Revoke must not imply it.
    expect(body.textContent).not.toMatch(/suspend(ed)?\b(?!.*use Offboard)/);
  });

  it('revokes only after the confirmation is accepted', async () => {
    const { calls } = setupFetch();
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(within(rowFor('Fabrikam Compliance')).getByRole('button', { name: /Revoke/ }));
    await user.click(screen.getByRole('button', { name: 'End Affiliation' }));

    await waitFor(() => {
      const revoke = calls.find((c) => c.url.includes('/sub-orgs/revoke'));
      expect(revoke?.body).toEqual({ childOrgId: 'child-approved', parentOrgId: 'org-parent' });
    });
  });

  it('does nothing when the revoke confirmation is declined', async () => {
    const { calls } = setupFetch();
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(within(rowFor('Fabrikam Compliance')).getByRole('button', { name: /Revoke/ }));
    await user.click(screen.getByRole('button', { name: 'Keep Affiliation' }));

    expect(calls.some((c) => c.url.includes('/sub-orgs/revoke'))).toBe(false);
  });

  it('names the organization in the offboard confirmation', async () => {
    setupFetch();
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(within(rowFor('Fabrikam Compliance')).getByRole('button', { name: 'Offboard' }));

    expect(screen.getByText('Offboard Fabrikam Compliance?')).toBeInTheDocument();
  });

  // ── Error copy ────────────────────────────────────────────────────────────

  it('translates a known worker reply instead of showing its code', async () => {
    setupFetch({ createStatus: 409, createBody: { error: 'sub_org_limit_reached', limit: 5, current: 5 } });
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: 'Add an organization' }));
    await user.type(screen.getByLabelText('Affiliate name'), 'Adventure Works');
    await user.type(screen.getByLabelText('Affiliate admin email'), 'admin@adventure.example');
    await user.click(screen.getByRole('button', { name: /Create Affiliate/ }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Your organization has reached its limit on affiliated organizations. Contact support to raise it.',
      );
    });
    expect(mocks.toastError).not.toHaveBeenCalledWith(expect.stringContaining('sub_org_limit_reached'));
  });

  it('never shows an unrecognised worker reply verbatim, and logs it instead', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    setupFetch({ createStatus: 500, createBody: { error: 'membership_lookup_unavailable' } });
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: 'Add an organization' }));
    await user.type(screen.getByLabelText('Affiliate name'), 'Adventure Works');
    await user.type(screen.getByLabelText('Affiliate admin email'), 'admin@adventure.example');
    await user.click(screen.getByRole('button', { name: /Create Affiliate/ }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('Failed to create affiliate organization.');
    });
    expect(mocks.toastError).not.toHaveBeenCalledWith(
      expect.stringContaining('membership_lookup_unavailable'),
    );
    // Not swallowed: the unmapped code is still reported somewhere.
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('sub-orgs'),
      'membership_lookup_unavailable',
    );
    consoleError.mockRestore();
  });

  // ── Empty state ───────────────────────────────────────────────────────────

  it('explains what an affiliated organization is when there are none', async () => {
    setupFetch({ subOrgs: [] });
    render(<ManageSubOrgs orgId="org-parent" />);

    await screen.findByText('No affiliated organizations yet');
    expect(
      screen.getByText(/An affiliated organization is a separate organization you manage/),
    ).toBeInTheDocument();
    expect(screen.getByText(/it asks to affiliate with you and you approve the request/))
      .toBeInTheDocument();
    // …and offers the way in from the empty state itself.
    expect(screen.getByRole('button', { name: 'Add an organization' })).toBeInTheDocument();
  });

  // ── Balance labelling ─────────────────────────────────────────────────────

  it('labels the affiliate balance instead of floating a bare number', async () => {
    setupFetch();
    await renderLoaded();

    const row = rowFor('Fabrikam Compliance');
    expect(within(row).getByText('Their balance')).toBeInTheDocument();
    expect(within(row).getByText('150 credits')).toBeInTheDocument();
  });
});
