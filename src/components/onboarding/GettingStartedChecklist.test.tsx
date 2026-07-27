/**
 * GettingStartedChecklist Component Tests
 *
 * Tests role-specific onboarding guidance and dismissal.
 *
 * @see UF-10
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GettingStartedChecklist } from './GettingStartedChecklist';

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

const store: Record<string, string> = {};

// Provide a working localStorage mock
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
  get length() { return Object.keys(store).length; },
  key: (i: number) => Object.keys(store)[i] ?? null,
};
Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(store).forEach((k) => delete store[k]);
});

function renderChecklist(role: 'ORG_ADMIN' | 'INDIVIDUAL', context = {}) {
  return render(
    <MemoryRouter>
      <GettingStartedChecklist
        role={role}
        context={{
          hasRecords: false,
          hasTemplates: false,
          hasBillingPlan: false,
          ...context,
        }}
      />
    </MemoryRouter>
  );
}

describe('GettingStartedChecklist', () => {
  it('renders getting started title for ORG_ADMIN', () => {
    renderChecklist('ORG_ADMIN');
    expect(screen.getByText('Getting Started')).toBeInTheDocument();
  });

  it('shows org-specific steps for ORG_ADMIN', () => {
    renderChecklist('ORG_ADMIN');
    expect(screen.getByText(/document template/i)).toBeInTheDocument();
  });

  it('shows individual steps for INDIVIDUAL', () => {
    renderChecklist('INDIVIDUAL');
    expect(screen.getByText('Secure your first document')).toBeInTheDocument();
  });

  it('marks completed steps when context reflects progress', () => {
    renderChecklist('ORG_ADMIN', { hasRecords: true, hasTemplates: true });
    const checks = screen.getAllByTestId('step-complete');
    expect(checks.length).toBeGreaterThan(0);
  });

  it('can be dismissed via close button', () => {
    renderChecklist('ORG_ADMIN');
    const dismissButton = screen.getByLabelText(/dismiss/i);
    fireEvent.click(dismissButton);
    expect(localStorage.getItem('arkova_checklist_dismissed')).toBe('true');
  });

  it('does not render when already dismissed', () => {
    localStorage.setItem('arkova_checklist_dismissed', 'true');
    const { container } = renderChecklist('ORG_ADMIN');
    expect(container.querySelector('[data-testid="getting-started"]')).toBeNull();
  });

  it('shows progress bar', () => {
    renderChecklist('ORG_ADMIN', { hasRecords: true });
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });
});
