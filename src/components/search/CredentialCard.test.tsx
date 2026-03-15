/**
 * CredentialCard Tests
 *
 * @see UF-02
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { CredentialCard } from './CredentialCard';
import type { IssuerRegistryAnchor } from '@/hooks/usePublicSearch';

const MOCK_ANCHOR: IssuerRegistryAnchor = {
  public_id: 'abc-123-def',
  label: 'Bachelor of Science',
  filename: 'degree.pdf',
  credential_type: 'DEGREE',
  issued_at: '2025-06-15T00:00:00Z',
  created_at: '2025-06-01T00:00:00Z',
};

function renderCard(anchor: IssuerRegistryAnchor = MOCK_ANCHOR) {
  return render(
    <BrowserRouter>
      <CredentialCard anchor={anchor} />
    </BrowserRouter>
  );
}

describe('CredentialCard', () => {
  it('displays credential label', () => {
    renderCard();
    expect(screen.getByText('Bachelor of Science')).toBeInTheDocument();
  });

  it('falls back to filename when label is null', () => {
    renderCard({ ...MOCK_ANCHOR, label: null });
    expect(screen.getByText('degree.pdf')).toBeInTheDocument();
  });

  it('displays credential type badge', () => {
    renderCard();
    // CREDENTIAL_TYPE_LABELS maps DEGREE → 'Degree'
    expect(screen.getByText('Degree')).toBeInTheDocument();
  });

  it('displays formatted issued date', () => {
    renderCard();
    expect(screen.getByText(/Jun 15, 2025/)).toBeInTheDocument();
  });

  it('hides date when issued_at is null', () => {
    renderCard({ ...MOCK_ANCHOR, issued_at: null });
    expect(screen.queryByText(/Jun/)).not.toBeInTheDocument();
  });

  it('links to verify page', () => {
    renderCard();
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/verify/abc-123-def');
  });

  it('hides type badge when credential_type is null', () => {
    renderCard({ ...MOCK_ANCHOR, credential_type: null });
    expect(screen.queryByText('Degree')).not.toBeInTheDocument();
  });
});
