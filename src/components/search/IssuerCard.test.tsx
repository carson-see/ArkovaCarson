/**
 * IssuerCard Tests
 *
 * @see UF-02
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { IssuerCard } from './IssuerCard';
import type { IssuerResult } from '@/hooks/usePublicSearch';

const MOCK_ISSUER: IssuerResult = {
  org_id: 'aaaaaaaa-0000-0000-0000-000000000001',
  org_name: 'University of Michigan',
  org_domain: 'umich.edu',
  credential_count: 42,
};

function renderCard(issuer: IssuerResult = MOCK_ISSUER) {
  return render(
    <BrowserRouter>
      <IssuerCard issuer={issuer} />
    </BrowserRouter>
  );
}

describe('IssuerCard', () => {
  it('displays issuer name', () => {
    renderCard();
    expect(screen.getByText('University of Michigan')).toBeInTheDocument();
  });

  it('displays domain', () => {
    renderCard();
    expect(screen.getByText('umich.edu')).toBeInTheDocument();
  });

  it('displays credential count', () => {
    renderCard();
    expect(screen.getByText('42 verified credentials')).toBeInTheDocument();
  });

  it('links to issuer registry page', () => {
    renderCard();
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', `/issuer/${MOCK_ISSUER.org_id}`);
  });

  it('handles null domain gracefully', () => {
    renderCard({ ...MOCK_ISSUER, org_domain: null });
    expect(screen.getByText('University of Michigan')).toBeInTheDocument();
    expect(screen.queryByText('umich.edu')).not.toBeInTheDocument();
  });
});
