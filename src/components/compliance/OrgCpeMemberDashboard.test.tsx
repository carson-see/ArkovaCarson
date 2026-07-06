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

const ORG_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_ID = '44444444-0000-0000-0000-000000000001';

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
              lastActivity: '2026-06-10T00:00:00.000Z',
            },
            {
              userId: 'member-2',
              displayName: 'sarah@arkova.ai',
              identifier: 'sarah@arkova.ai',
              securedCount: 1,
              pendingCount: 0,
              lastActivity: null,
            },
          ],
          totals: { members: 2, secured: 3, pending: 1 },
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
              lastActivity: '2026-06-01T00:00:00.000Z',
            },
          ],
          totals: { members: 1, secured: 1, pending: 0 },
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

  it('renders the empty state when there are no records in the period', () => {
    useOrgCpeMemberSummaryMock.mockReturnValue(
      hookReturn({
        summary: { rows: [], totals: { members: 0, secured: 0, pending: 0 }, scopedToSelf: false },
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
