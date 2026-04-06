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

    expect(screen.getByRole('heading', { name: DATA_RETENTION_LABELS.PAGE_TITLE })).toBeInTheDocument();
    expect(screen.getByText(DATA_RETENTION_LABELS.INTRO)).toBeInTheDocument();
  });

  it('renders retention schedule table with data categories', () => {
    renderPage();

    expect(screen.getByText(DATA_RETENTION_LABELS.CAT_ANCHOR_RECORDS)).toBeInTheDocument();
    expect(screen.getByText(DATA_RETENTION_LABELS.CAT_AUDIT_EVENTS)).toBeInTheDocument();
    expect(screen.getByText(DATA_RETENTION_LABELS.CAT_SIGNATURE_RECORDS)).toBeInTheDocument();
    expect(screen.getByText(DATA_RETENTION_LABELS.CAT_TIMESTAMP_TOKENS)).toBeInTheDocument();
    expect(screen.getByText(DATA_RETENTION_LABELS.CAT_USER_ACCOUNTS)).toBeInTheDocument();
  });

  it('renders retention periods', () => {
    renderPage();

    expect(screen.getAllByText(DATA_RETENTION_LABELS.PERIOD_INDEFINITE).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(DATA_RETENTION_LABELS.PERIOD_7_YEARS).length).toBeGreaterThanOrEqual(1);
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

  it('renders section schedule heading from copy.ts', () => {
    renderPage();

    expect(screen.getByText(DATA_RETENTION_LABELS.SECTION_SCHEDULE)).toBeInTheDocument();
  });
});
