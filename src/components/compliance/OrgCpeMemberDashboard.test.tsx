/**
 * CPE-02 (SCRUM-2380) — org CPE dashboard MVP component.
 *
 * Pins:
 *  - tiles: members-with-records, secured total, pending total.
 *  - per-member table: name/identifier, secured vs pending counts, last activity.
 *  - live-hook driven (no useState/mock data for table rows).
 *  - member scope note when the caller is a plain member.
 *  - loading / error / empty states.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OrgCpeMemberDashboard } from './OrgCpeMemberDashboard';
import type { UseOrgCpeMemberSummaryReturn } from '@/hooks/useOrgCpeMemberSummary';

const useOrgCpeMemberSummaryMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useOrgCpeMemberSummary', () => ({
  useOrgCpeMemberSummary: (...args: unknown[]) => useOrgCpeMemberSummaryMock(...args),
}));

const ORG_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER_ID = '44444444-0000-4000-8000-000000000001';

function hookReturn(overrides: Partial<UseOrgCpeMemberSummaryReturn>): UseOrgCpeMemberSummaryReturn {
  return {
    summary: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  useOrgCpeMemberSummaryMock.mockReset();
});

describe('OrgCpeMemberDashboard', () => {
  it('renders per-member rows with secured/pending counts and last activity', () => {
    useOrgCpeMemberSummaryMock.mockReturnValue(
      hookReturn({
        summary: {
          rows: [
            {
              userId: USER_ID,
              displayName: 'Carson Seeger',
              identifier: 'carson@arkova.ai',
              securedCount: 2,
              pendingCount: 1,
              terminalCount: 0,
              lastActivity: '2026-06-10T00:00:00.000Z',
            },
            {
              userId: 'member-2',
              displayName: 'sarah@arkova.ai',
              identifier: 'sarah@arkova.ai',
              securedCount: 1,
              pendingCount: 0,
              terminalCount: 0,
              lastActivity: null,
            },
          ],
          totals: { members: 2, secured: 3, pending: 1, terminal: 0 },
          scopedToSelf: false,
        },
      }),
    );

    render(<OrgCpeMemberDashboard orgId={ORG_ID} userId={USER_ID} isOrgAdmin />);

    // Tiles
    expect(screen.getByText('Members with records')).toBeInTheDocument();
    expect(screen.getByText('Secured records')).toBeInTheDocument();
    expect(screen.getByText('Pending records')).toBeInTheDocument();
    expect(screen.getByTestId('org-cpe-tile-members')).toHaveTextContent('2');
    expect(screen.getByTestId('org-cpe-tile-secured')).toHaveTextContent('3');
    expect(screen.getByTestId('org-cpe-tile-pending')).toHaveTextContent('1');

    // Member table
    expect(screen.getByText('Carson Seeger')).toBeInTheDocument();
    expect(screen.getByText('carson@arkova.ai')).toBeInTheDocument();
    const carsonRow = screen.getByText('Carson Seeger').closest('tr');
    expect(carsonRow).toHaveTextContent('2');
    expect(carsonRow).toHaveTextContent('1');

    // No member-scope note for an org admin.
    expect(screen.queryByText('Showing your records only.')).not.toBeInTheDocument();
  });

  it('shows the own-rows scope note for a plain member', () => {
    useOrgCpeMemberSummaryMock.mockReturnValue(
      hookReturn({
        summary: {
          rows: [
            {
              userId: USER_ID,
              displayName: 'Just Me',
              identifier: 'me@example.com',
              securedCount: 1,
              pendingCount: 0,
              terminalCount: 0,
              lastActivity: '2026-06-01T00:00:00.000Z',
            },
          ],
          totals: { members: 1, secured: 1, pending: 0, terminal: 0 },
          scopedToSelf: true,
        },
      }),
    );

    render(<OrgCpeMemberDashboard orgId={ORG_ID} userId={USER_ID} isOrgAdmin={false} />);

    expect(screen.getByText('Showing your records only.')).toBeInTheDocument();
    // The hook was invoked with isOrgAdmin=false (query-layer own-rows scope).
    expect(useOrgCpeMemberSummaryMock).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      false,
      expect.anything(),
    );
  });

  it('surfaces terminal (revoked/expired/superseded) records via the explicit footnote — never silently omitted', () => {
    useOrgCpeMemberSummaryMock.mockReturnValue(
      hookReturn({
        summary: {
          rows: [
            {
              userId: USER_ID,
              displayName: 'Carson Seeger',
              identifier: 'carson@arkova.ai',
              securedCount: 1,
              pendingCount: 0,
              terminalCount: 2,
              lastActivity: '2026-06-10T00:00:00.000Z',
            },
          ],
          totals: { members: 1, secured: 1, pending: 0, terminal: 2 },
          scopedToSelf: false,
        },
      }),
    );

    render(<OrgCpeMemberDashboard orgId={ORG_ID} userId={USER_ID} isOrgAdmin />);

    expect(screen.getByTestId('org-cpe-terminal-footnote')).toHaveTextContent(
      '2 records in this period are revoked, expired, or superseded and are not counted in the totals above.',
    );
  });

  it('renders NO terminal footnote when there are no terminal records', () => {
    useOrgCpeMemberSummaryMock.mockReturnValue(
      hookReturn({
        summary: {
          rows: [
            {
              userId: USER_ID,
              displayName: 'Carson Seeger',
              identifier: 'carson@arkova.ai',
              securedCount: 1,
              pendingCount: 0,
              terminalCount: 0,
              lastActivity: '2026-06-10T00:00:00.000Z',
            },
          ],
          totals: { members: 1, secured: 1, pending: 0, terminal: 0 },
          scopedToSelf: false,
        },
      }),
    );

    render(<OrgCpeMemberDashboard orgId={ORG_ID} userId={USER_ID} isOrgAdmin />);
    expect(screen.queryByTestId('org-cpe-terminal-footnote')).not.toBeInTheDocument();
  });

  it('renders the UNKNOWN_MEMBER copy (never an id fragment) when a member has no readable name', () => {
    useOrgCpeMemberSummaryMock.mockReturnValue(
      hookReturn({
        summary: {
          rows: [
            {
              userId: '9f8e7d6c-0000-0000-0000-000000000009',
              displayName: '',
              identifier: null,
              securedCount: 1,
              pendingCount: 0,
              terminalCount: 0,
              lastActivity: null,
            },
          ],
          totals: { members: 1, secured: 1, pending: 0, terminal: 0 },
          scopedToSelf: false,
        },
      }),
    );

    render(<OrgCpeMemberDashboard orgId={ORG_ID} userId={USER_ID} isOrgAdmin />);
    expect(screen.getByText('Unknown member')).toBeInTheDocument();
    // No internal-id fragment leaks into the table.
    expect(screen.queryByText(/9f8e7d6c/)).not.toBeInTheDocument();
  });

  it('renders the empty state when there are no records in the period', () => {
    useOrgCpeMemberSummaryMock.mockReturnValue(
      hookReturn({
        summary: { rows: [], totals: { members: 0, secured: 0, pending: 0, terminal: 0 }, scopedToSelf: false },
      }),
    );

    render(<OrgCpeMemberDashboard orgId={ORG_ID} userId={USER_ID} isOrgAdmin />);
    expect(screen.getByText('No CPE records in this period')).toBeInTheDocument();
  });

  it('renders an error state when the hook reports a failure', () => {
    useOrgCpeMemberSummaryMock.mockReturnValue(hookReturn({ error: 'failed to load CPE records: boom' }));

    render(<OrgCpeMemberDashboard orgId={ORG_ID} userId={USER_ID} isOrgAdmin />);
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to load team CPE records.');
  });

  it('renders a loading skeleton while fetching', () => {
    useOrgCpeMemberSummaryMock.mockReturnValue(hookReturn({ loading: true }));

    render(<OrgCpeMemberDashboard orgId={ORG_ID} userId={USER_ID} isOrgAdmin />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
