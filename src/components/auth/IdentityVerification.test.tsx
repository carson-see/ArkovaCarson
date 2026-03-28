import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IdentityVerification } from './IdentityVerification';

describe('IdentityVerification', () => {
  it('renders unstarted state with verify button', () => {
    render(<IdentityVerification status="unstarted" verifiedAt={null} />);
    expect(screen.getByText('Identity Verification')).toBeInTheDocument();
    expect(screen.getByText('Not Verified')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /get verified/i })).toBeInTheDocument();
  });

  it('renders pending state without verify button', () => {
    render(<IdentityVerification status="pending" verifiedAt={null} />);
    expect(screen.getByText('Verification Pending')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /verify identity/i })).not.toBeInTheDocument();
  });

  it('renders verified state with date', () => {
    render(<IdentityVerification status="verified" verifiedAt="2026-03-26T12:00:00Z" />);
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByText(/Verified on/)).toBeInTheDocument();
  });

  it('renders requires_input state with retry button', () => {
    render(<IdentityVerification status="requires_input" verifiedAt={null} />);
    expect(screen.getByText('Action Required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry verification/i })).toBeInTheDocument();
  });

  it('renders canceled state with retry button', () => {
    render(<IdentityVerification status="canceled" verifiedAt={null} />);
    expect(screen.getByText('Canceled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry verification/i })).toBeInTheDocument();
  });
});
