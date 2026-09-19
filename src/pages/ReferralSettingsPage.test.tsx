/**
 * ReferralSettingsPage — SCRUM-5024.
 *
 * The page owns two decisions: which organization the panel reads
 * (`useActiveOrg`, not `profile.org_id`) and who may mint (ORG_ADMIN).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { mockUseAuth, mockUseProfile, mockUseActiveOrg, mockPanel } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseProfile: vi.fn(),
  mockUseActiveOrg: vi.fn(),
  mockPanel: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: mockUseAuth }));
vi.mock('@/hooks/useProfile', () => ({ useProfile: mockUseProfile }));
vi.mock('@/hooks/useActiveOrg', () => ({ useActiveOrg: mockUseActiveOrg }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/org/ReferralPanel', () => ({
  ReferralPanel: (props: { orgId: string | null; canManage: boolean }) => {
    mockPanel(props);
    return <div data-testid="referral-panel" />;
  },
}));

import { ReferralSettingsPage } from './ReferralSettingsPage';
import { REFERRAL_LABELS } from '@/lib/copy';

describe('ReferralSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: { id: 'u1' }, signOut: vi.fn() });
    mockUseProfile.mockReturnValue({ profile: { role: 'ORG_ADMIN' }, loading: false });
    mockUseActiveOrg.mockReturnValue({ orgId: 'org-active', loading: false });
  });

  it('passes the ACTIVE organization to the panel, not the profile primary org', () => {
    mockUseProfile.mockReturnValue({ profile: { role: 'ORG_ADMIN', org_id: 'org-primary' }, loading: false });
    render(<ReferralSettingsPage />);

    expect(mockPanel).toHaveBeenCalledWith({ orgId: 'org-active', canManage: true });
  });

  it('grants management to ORG_ADMIN only', () => {
    mockUseProfile.mockReturnValue({ profile: { role: 'ORG_MEMBER' }, loading: false });
    render(<ReferralSettingsPage />);

    expect(mockPanel).toHaveBeenCalledWith(expect.objectContaining({ canManage: false }));
  });

  it('waits for the org to resolve rather than flashing "no organization"', () => {
    mockUseActiveOrg.mockReturnValue({ orgId: null, loading: true });
    render(<ReferralSettingsPage />);

    expect(mockPanel).not.toHaveBeenCalled();
    expect(screen.queryByTestId('referral-panel')).toBeNull();
  });

  it('renders the page title and description', () => {
    render(<ReferralSettingsPage />);
    expect(screen.getByRole('heading', { name: REFERRAL_LABELS.PAGE_TITLE })).toBeInTheDocument();
    expect(screen.getByText(REFERRAL_LABELS.PAGE_DESCRIPTION)).toBeInTheDocument();
  });

  it('shows a distinct loading message beside the spinner while the org resolves, not a second page title', () => {
    mockUseActiveOrg.mockReturnValue({ orgId: null, loading: true });
    render(<ReferralSettingsPage />);

    // The H1 heading is still the page title; the spinner row next to it must
    // not repeat that same string as if it were a loading message.
    expect(screen.getByRole('heading', { name: REFERRAL_LABELS.PAGE_TITLE })).toBeInTheDocument();
    expect(screen.getByText(REFERRAL_LABELS.LOADING)).toBeInTheDocument();
    expect(screen.getAllByText(REFERRAL_LABELS.PAGE_TITLE)).toHaveLength(1);
  });
});
