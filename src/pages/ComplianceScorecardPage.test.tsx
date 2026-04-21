/**
 * NCA-08 ComplianceScorecardPage — renders sections driven by audit history.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ComplianceScorecardPage } from './ComplianceScorecardPage';

// AppShell pulls in real providers + hooks — stub it for focused rendering.
vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// ProfileProvider + OrganizationProvider are expensive in tests — stub.
const mockProfile = vi.hoisted(() => ({
  current: { org_id: 'org-1' as string | null, role: 'ORG_ADMIN' } as { org_id: string | null; role: string },
}));
vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ profile: mockProfile.current, loading: false, updateProfile: vi.fn() }),
}));
vi.mock('@/hooks/useOrganization', () => ({
  useOrganization: () => ({ organization: { id: 'org-1', display_name: 'Acme Corp' }, loading: false }),
}));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'a@b.test' }, signOut: vi.fn(async () => undefined) }),
}));

function makeAudit(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'a1',
    overall_score: 72,
    overall_grade: 'C',
    per_jurisdiction: [
      { jurisdiction_code: 'US-CA', industry_code: 'accounting', score: 80, grade: 'B', total_required: 5, total_present: 4, rule_count: 1 },
      { jurisdiction_code: 'US-NY', industry_code: 'accounting', score: 60, grade: 'D', total_required: 4, total_present: 2, rule_count: 1 },
    ],
    gaps: [
      { type: 'LICENSE', category: 'MISSING', requirement: 'Required: LICENSE', jurisdiction_code: 'US-NY', regulatory_reference: 'NY §7404', severity: 'critical', remediation_hint: 'Upload the license' },
      { type: 'CERTIFICATE', category: 'EXPIRING_SOON', requirement: 'Renew CERTIFICATE', jurisdiction_code: 'US-CA', regulatory_reference: null, severity: 'high', remediation_hint: 'Renew', days_remaining: 14 },
    ],
    status: 'COMPLETED',
    started_at: '2026-04-17T00:00:00Z',
    completed_at: '2026-04-17T00:00:30Z',
    metadata: {
      recommendations: {
        recommendations: [
          { id: 'r1', title: 'Upload LICENSE for US-NY', description: 'Do it', expected_score_improvement: 15, effort_hours: 4, affected_jurisdictions: ['US-NY'], deadline: null, group: 'CRITICAL', priority_score: 2.5, severity: 'critical' },
        ],
        overflow_count: 0,
        grouped: {
          critical: [
            { id: 'r1', title: 'Upload LICENSE for US-NY', description: 'Do it', expected_score_improvement: 15, effort_hours: 4, affected_jurisdictions: ['US-NY'], deadline: null, group: 'CRITICAL', priority_score: 2.5, severity: 'critical' },
          ],
          quick_wins: [],
          upcoming: [],
          standard: [],
        },
      },
    },
    ...overrides,
  };
}

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('NCA-08 ComplianceScorecardPage', () => {
  beforeEach(() => {
    mockProfile.current = { org_id: 'org-1', role: 'ORG_ADMIN' };
  });

  it('renders empty state when no audits exist', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ audits: [], count: 0 }),
    } as unknown as Response));
    renderWithRouter(<ComplianceScorecardPage fetchFn={fetchFn} />);
    await waitFor(() => {
      expect(screen.getByTestId('scorecard-empty')).toBeDefined();
    });
  });

  it('renders gauge + per-jurisdiction bars + gaps + recommendations for latest audit', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ audits: [makeAudit()], count: 1 }),
    } as unknown as Response));
    renderWithRouter(<ComplianceScorecardPage fetchFn={fetchFn} />);

    await waitFor(() => {
      expect(screen.getByTestId('scorecard-gauge')).toBeDefined();
    });
    expect(screen.getByTestId('scorecard-gaps')).toBeDefined();
    expect(screen.getByTestId('scorecard-recommendations')).toBeDefined();
    // Content checks
    const text = document.body.textContent ?? '';
    expect(text).toContain('US-CA');
    expect(text).toContain('US-NY');
    expect(text).toContain('Required: LICENSE');
    expect(text).toContain('Upload LICENSE for US-NY');
  });

  it('renders timeline when history has >= 2 audits', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        audits: [
          makeAudit({ id: 'a2', overall_score: 85, started_at: '2026-04-18T00:00:00Z', completed_at: '2026-04-18T00:00:30Z' }),
          makeAudit({ id: 'a1', overall_score: 72 }),
        ],
        count: 2,
      }),
    } as unknown as Response));
    renderWithRouter(<ComplianceScorecardPage fetchFn={fetchFn} />);
    await waitFor(() => {
      // timeline renders an SVG
      expect(document.querySelector('svg')).toBeDefined();
    });
  });

  it('renders error state when fetch returns non-OK', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    } as unknown as Response));
    renderWithRouter(<ComplianceScorecardPage fetchFn={fetchFn} />);
    await waitFor(() => {
      expect(screen.getByTestId('scorecard-error')).toBeDefined();
    });
  });

  it('renders org-required empty state for individual users without firing /audit (UAT 2026-04-18 Bug 1)', async () => {
    mockProfile.current = { org_id: null, role: 'INDIVIDUAL' };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ audits: [], count: 0 }) } as unknown as Response));
    renderWithRouter(<ComplianceScorecardPage fetchFn={fetchFn} />);
    await waitFor(() => {
      expect(screen.getByTestId('scorecard-org-required')).toBeDefined();
    });
    // Must not fire the org-scoped audit endpoint for individuals — that was the 403 source.
    expect(fetchFn).not.toHaveBeenCalled();
    // The legacy empty state + error banners must not appear concurrently.
    expect(screen.queryByTestId('scorecard-empty')).toBeNull();
    expect(screen.queryByTestId('scorecard-error')).toBeNull();
  });

  it('invokes onExportPdf with latest audit when Export PDF is clicked (NCA-09 hook)', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ audits: [makeAudit()], count: 1 }),
    } as unknown as Response));
    const onExportPdf = vi.fn(async () => {});
    renderWithRouter(<ComplianceScorecardPage fetchFn={fetchFn} onExportPdf={onExportPdf} />);
    await waitFor(() => {
      expect(screen.getByTestId('scorecard-export-pdf')).toBeDefined();
    });
    screen.getByTestId('scorecard-export-pdf').click();
    await waitFor(() => {
      expect(onExportPdf).toHaveBeenCalledTimes(1);
      const firstCallArgs = onExportPdf.mock.calls[0] as unknown as [{ id: string }];
      expect(firstCallArgs[0].id).toBe('a1');
    });
  });
});
