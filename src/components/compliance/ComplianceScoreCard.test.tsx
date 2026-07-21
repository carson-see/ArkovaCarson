/**
 * SCRUM-948 (BUG-2026-04-21-001) — Dashboard Compliance Score widget must
 * reflect the most recent `compliance_audits` row, not the legacy NCE
 * `compliance_scores` table.
 *
 * Pre-fix: card called `useComplianceScore` → `/api/v1/compliance/score`
 * which reads from `compliance_scores`. After NCA-03 (migration 0217)
 * audits write to `compliance_audits`, leaving `compliance_scores` empty
 * and the widget stuck on the empty state even after a Grade A audit.
 *
 * Post-fix: card calls `useLatestComplianceAudit` → `/api/v1/compliance/audit?limit=1`
 * and renders overall_score / overall_grade / completed_at.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ComplianceScoreCard } from './ComplianceScoreCard';

vi.mock('@/lib/workerClient', () => ({
  workerFetch: vi.fn(),
  WORKER_URL: 'http://localhost:3001',
}));

import { workerFetch } from '@/lib/workerClient';
const mockedWorkerFetch = workerFetch as unknown as ReturnType<typeof vi.fn>;

function renderInRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

// Flake root cause: the card renders `Last audited {formatRelative(completed_at)}`
// where `formatRelative` reads live `Date.now()` → "Nd ago", N = whole days since
// the fixed mock `completed_at` (2026-04-25). That output is wall-clock dependent,
// so the test's meaning changes every calendar day. On any day where N contains
// the substring "87" (e.g. exactly 87 days later = 2026-07-21), the loose
// `findByText(/87/)` score assertion ALSO matches the "87d ago" node and
// `findByText` throws on multiple matches. Fix: freeze the clock (Date only —
// leave real timers so Testing Library's async polling still works) to a fixed
// instant just after `completed_at`, and assert the score exactly. Now
// deterministic regardless of the day CI runs.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-04-25T10:05:00Z'));
  mockedWorkerFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ComplianceScoreCard (SCRUM-948)', () => {
  it('renders grade and score from the most recent compliance_audits row', async () => {
    mockedWorkerFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        audits: [
          {
            id: 'audit-1',
            overall_score: 87,
            overall_grade: 'B',
            status: 'COMPLETED',
            started_at: '2026-04-25T10:00:00Z',
            completed_at: '2026-04-25T10:00:30Z',
            per_jurisdiction: [],
            gaps: [],
            metadata: {},
          },
        ],
      }),
    } as Response);

    renderInRouter(<ComplianceScoreCard />);

    // Exact match targets the gauge's score span (`{score}` → "87"), never the
    // "Last audited …" relative-time node — so this cannot collide with a
    // date-derived "87" even if the clock freeze is ever removed.
    expect(await screen.findByText('87')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
    // The relative-time render is now deterministic ("4m ago"), proving the
    // clock is frozen and the score assertion is unambiguous.
    expect(screen.getByText(/Last audited 4m ago/)).toBeInTheDocument();
  });

  it('hits /api/v1/compliance/audit?limit=1 (not /compliance/score)', async () => {
    mockedWorkerFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ audits: [] }),
    } as Response);

    renderInRouter(<ComplianceScoreCard />);

    await waitFor(() => expect(mockedWorkerFetch).toHaveBeenCalled());
    const calledUrl = mockedWorkerFetch.mock.calls[0][0];
    expect(calledUrl).toContain('/api/v1/compliance/audit');
    expect(calledUrl).toContain('limit=1');
    expect(calledUrl).not.toContain('/compliance/score');
  });

  it('shows the run-an-audit empty state when no audit exists yet', async () => {
    mockedWorkerFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ audits: [] }),
    } as Response);

    renderInRouter(<ComplianceScoreCard />);

    expect(await screen.findByText(/no compliance audit yet/i)).toBeInTheDocument();
  });

  it('shows the empty state on 404 from the worker', async () => {
    mockedWorkerFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'not found' }),
    } as Response);

    renderInRouter(<ComplianceScoreCard />);

    expect(await screen.findByText(/no compliance audit yet/i)).toBeInTheDocument();
  });
});
