/**
 * Tests for ComplianceTrendPage (COMP-07)
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ComplianceTrendPage } from './ComplianceTrendPage';
import { COMPLIANCE_TREND_LABELS } from '@/lib/copy';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ session: null, user: null, loading: false, signOut: vi.fn() }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ profile: null, destination: '/dashboard', loading: false }),
}));

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <ComplianceTrendPage />
    </MemoryRouter>,
  );
}

describe('ComplianceTrendPage', () => {
  it('renders page title', () => {
    renderPage();
    expect(screen.getByText(COMPLIANCE_TREND_LABELS.PAGE_TITLE, { exact: false })).toBeInTheDocument();
  });

  it('renders granularity selector', () => {
    renderPage();
    expect(screen.getByText(COMPLIANCE_TREND_LABELS.DAILY)).toBeInTheDocument();
  });

  it('renders page description', () => {
    renderPage();
    expect(screen.getByText(COMPLIANCE_TREND_LABELS.PAGE_DESCRIPTION)).toBeInTheDocument();
  });
});
