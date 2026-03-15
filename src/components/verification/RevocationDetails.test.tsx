/**
 * RevocationDetails Tests
 *
 * @see UF-07
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RevocationDetails } from './RevocationDetails';

describe('RevocationDetails', () => {
  it('displays revocation reason', () => {
    render(
      <RevocationDetails
        revocationReason="Credential was issued in error"
        revokedAt="2026-03-15T14:30:00Z"
      />
    );
    expect(screen.getByText('Credential was issued in error')).toBeInTheDocument();
  });

  it('shows "No reason provided" when reason is null', () => {
    render(<RevocationDetails revokedAt="2026-03-15T14:30:00Z" />);
    expect(screen.getByText('No reason provided')).toBeInTheDocument();
  });

  it('displays formatted revocation date', () => {
    render(
      <RevocationDetails
        revocationReason="Test"
        revokedAt="2026-03-15T14:30:00Z"
      />
    );
    // Should show formatted date
    expect(screen.getByText(/Mar 15, 2026/)).toBeInTheDocument();
  });

  it('hides date when revokedAt is null', () => {
    render(<RevocationDetails revocationReason="Issued in error" />);
    expect(screen.getByText('Issued in error')).toBeInTheDocument();
    // No date displayed
    expect(screen.queryByText(/UTC/)).not.toBeInTheDocument();
  });

  it('shows section title', () => {
    render(<RevocationDetails revocationReason="Test" />);
    expect(screen.getByText('Revocation Details')).toBeInTheDocument();
  });
});
