/**
 * Tests — NCA-07 AuditMyOrganizationButton.
 * Covers idle / progress / complete / error state transitions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuditMyOrganizationButton } from './AuditMyOrganizationButton';
import { ROUTES } from '@/lib/routes';
import { AUDIT_MY_ORG_LABELS } from '@/lib/copy';

function renderWithRouter(ui: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route path="/dashboard" element={ui} />
        <Route path={ROUTES.COMPLIANCE_SCORECARD} element={<div data-testid="scorecard">scorecard</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NCA-07 AuditMyOrganizationButton', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders an idle trigger button by default', () => {
    renderWithRouter(<AuditMyOrganizationButton fetchFn={vi.fn()} />);
    expect(screen.getByTestId('audit-trigger')).toBeDefined();
    expect(screen.queryByTestId('audit-progress')).toBeNull();
  });

  it('transitions to progress on click, then to complete on 201', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ id: 'audit-123', status: 'COMPLETED' }),
    } as unknown as Response));

    const onCompleted = vi.fn();
    renderWithRouter(
      <AuditMyOrganizationButton
        fetchFn={fetchFn}
        onAuditCompleted={onCompleted}
        disablePhaseAnimation
      />,
    );
    fireEvent.click(screen.getByTestId('audit-trigger'));

    await waitFor(() => {
      expect(screen.getByTestId('audit-view-results')).toBeDefined();
    });
    expect(onCompleted).toHaveBeenCalledWith('audit-123');
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/compliance/audit',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows an error with retry when the API returns a non-OK response', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Audit computation failed' }),
    } as unknown as Response));

    renderWithRouter(<AuditMyOrganizationButton fetchFn={fetchFn} disablePhaseAnimation />);
    fireEvent.click(screen.getByTestId('audit-trigger'));

    await waitFor(() => {
      expect(screen.getByTestId('audit-error')).toBeDefined();
    });
    expect(screen.getByTestId('audit-error').textContent).toContain('Audit computation failed');

    // Retry returns to idle
    fireEvent.click(screen.getByTestId('audit-retry'));
    expect(screen.getByTestId('audit-trigger')).toBeDefined();
    expect(screen.queryByTestId('audit-error')).toBeNull();
  });

  it('shows an error on network failure', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('Network down'); });
    renderWithRouter(<AuditMyOrganizationButton fetchFn={fetchFn} disablePhaseAnimation />);
    fireEvent.click(screen.getByTestId('audit-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('audit-error').textContent).toContain('Network down');
    });
  });

  it('shows a specific error when the audit body reports FAILED', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ id: 'a1', status: 'FAILED', error_message: 'Computation timed out' }),
    } as unknown as Response));
    renderWithRouter(<AuditMyOrganizationButton fetchFn={fetchFn} disablePhaseAnimation />);
    fireEvent.click(screen.getByTestId('audit-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('audit-error').textContent).toContain('Computation timed out');
    });
  });

  it('keyboard-navigable — button is focusable with aria-label + role=status progress', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ id: 'a1', status: 'COMPLETED' }),
    } as unknown as Response));
    renderWithRouter(<AuditMyOrganizationButton fetchFn={fetchFn} disablePhaseAnimation />);

    const trigger = screen.getByTestId('audit-trigger');
    expect(trigger.getAttribute('aria-label')).toContain('Audit My Organization');
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
  });

  it('SCRUM-950 — trigger stays mounted in aria-busy + disabled + "Running compliance audit…" state during audit', async () => {
    let resolveFetch!: (r: Response) => void;
    const fetchFn = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    renderWithRouter(<AuditMyOrganizationButton fetchFn={fetchFn} disablePhaseAnimation />);

    const trigger = screen.getByTestId('audit-trigger');
    expect(trigger.getAttribute('aria-busy')).not.toBe('true');
    fireEvent.click(trigger);

    await waitFor(() => {
      const live = screen.getByTestId('audit-trigger');
      expect(live.getAttribute('aria-busy')).toBe('true');
      expect(live).toBeDisabled();
      // Source from the copy constant so a label edit does not silently
      // unpin the assertion.
      expect(live.textContent).toContain(AUDIT_MY_ORG_LABELS.RUNNING.replace('…', ''));
    });

    const progress = screen.getByTestId('audit-progress');
    expect(progress.getAttribute('role')).toBe('status');
    expect(progress.getAttribute('aria-live')).toBe('polite');

    resolveFetch({
      ok: true,
      status: 201,
      json: async () => ({ id: 'a1', status: 'COMPLETED' }),
    } as unknown as Response);
    await waitFor(() => expect(screen.getByTestId('audit-view-results')).toBeDefined());
  });
});
