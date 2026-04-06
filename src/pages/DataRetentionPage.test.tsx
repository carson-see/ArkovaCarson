/**
 * Tests for DataRetentionPage (COMP-04)
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DataRetentionPage } from './DataRetentionPage';
import { DATA_RETENTION_LABELS } from '@/lib/copy';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/privacy/data-retention']}>
      <DataRetentionPage />
    </MemoryRouter>,
  );
}

describe('DataRetentionPage', () => {
  it('renders page title and description', () => {
    renderPage();

    expect(screen.getByText(DATA_RETENTION_LABELS.PAGE_TITLE)).toBeInTheDocument();
    expect(screen.getByText(DATA_RETENTION_LABELS.INTRO)).toBeInTheDocument();
  });

  it('renders retention schedule table with data categories', () => {
    renderPage();

    expect(screen.getByText('Anchor Records')).toBeInTheDocument();
    expect(screen.getByText('Audit Events')).toBeInTheDocument();
    expect(screen.getByText('Signature Records')).toBeInTheDocument();
    expect(screen.getByText('Timestamp Tokens')).toBeInTheDocument();
    expect(screen.getByText('User Accounts')).toBeInTheDocument();
  });

  it('renders retention periods', () => {
    renderPage();

    expect(screen.getAllByText('Indefinite').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('7 years').length).toBeGreaterThanOrEqual(1);
  });

  it('renders right to erasure section', () => {
    renderPage();

    expect(screen.getByText(DATA_RETENTION_LABELS.ERASURE_TITLE)).toBeInTheDocument();
    expect(screen.getByText(DATA_RETENTION_LABELS.ERASURE_BODY)).toBeInTheDocument();
  });

  it('renders legal hold section', () => {
    renderPage();

    expect(screen.getByText(DATA_RETENTION_LABELS.LEGAL_HOLD_TITLE)).toBeInTheDocument();
    expect(screen.getByText(DATA_RETENTION_LABELS.LEGAL_HOLD_BODY)).toBeInTheDocument();
  });

  it('renders network permanence note', () => {
    renderPage();

    expect(screen.getByText(DATA_RETENTION_LABELS.NETWORK_NOTE)).toBeInTheDocument();
  });

  it('links back to privacy page', () => {
    renderPage();

    const link = screen.getByRole('link', { name: /privacy policy/i });
    expect(link).toHaveAttribute('href', '/privacy');
  });
});
