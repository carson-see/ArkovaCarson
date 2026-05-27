/**
 * AttestationStatusCard Tests (SCRUM-1874)
 *
 * TDD: written before the component implementation.
 * Verifies status card renders correct status, description, and styling
 * for each attestation status. No banned terms allowed in output.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AttestationStatusCard } from './AttestationStatusCard';
import { ATTESTATION_LABELS } from '@/lib/copy';

describe('AttestationStatusCard', () => {
  it('renders the status card title', () => {
    render(<AttestationStatusCard status="ACTIVE" />);
    expect(screen.getByText(ATTESTATION_LABELS.STATUS_CARD_TITLE)).toBeInTheDocument();
  });

  it('renders ACTIVE status with correct label and description', () => {
    render(<AttestationStatusCard status="ACTIVE" />);
    expect(screen.getByText(ATTESTATION_LABELS.STATUS_ACTIVE)).toBeInTheDocument();
    expect(screen.getByText(ATTESTATION_LABELS.STATUS_ACTIVE_DESC)).toBeInTheDocument();
  });

  it('renders PENDING status with correct label', () => {
    render(<AttestationStatusCard status="PENDING" />);
    expect(screen.getByText(ATTESTATION_LABELS.STATUS_PENDING)).toBeInTheDocument();
    expect(screen.getByText(ATTESTATION_LABELS.STATUS_PENDING_DESC)).toBeInTheDocument();
  });

  it('renders REVOKED status with correct label', () => {
    render(<AttestationStatusCard status="REVOKED" />);
    expect(screen.getByText(ATTESTATION_LABELS.STATUS_REVOKED)).toBeInTheDocument();
    expect(screen.getByText(ATTESTATION_LABELS.STATUS_REVOKED_DESC)).toBeInTheDocument();
  });

  it('renders EXPIRED status with correct label', () => {
    render(<AttestationStatusCard status="EXPIRED" />);
    expect(screen.getByText(ATTESTATION_LABELS.STATUS_EXPIRED)).toBeInTheDocument();
  });

  it('renders DRAFT status with correct label', () => {
    render(<AttestationStatusCard status="DRAFT" />);
    expect(screen.getByText(ATTESTATION_LABELS.STATUS_DRAFT)).toBeInTheDocument();
  });

  it('renders CHALLENGED status with correct label', () => {
    render(<AttestationStatusCard status="CHALLENGED" />);
    expect(screen.getByText(ATTESTATION_LABELS.STATUS_CHALLENGED)).toBeInTheDocument();
  });

  it('renders public_id when provided', () => {
    render(<AttestationStatusCard status="ACTIVE" publicId="ARK-ABC-VER-123" />);
    expect(screen.getByText('ARK-ABC-VER-123')).toBeInTheDocument();
  });

  it('renders attestation type badge when provided', () => {
    render(<AttestationStatusCard status="ACTIVE" attestationType="VERIFICATION" />);
    expect(screen.getByText('VERIFICATION')).toBeInTheDocument();
  });

  it('does not render banned terms in any status output', () => {
    const statuses = ['ACTIVE', 'PENDING', 'REVOKED', 'EXPIRED', 'DRAFT', 'CHALLENGED'] as const;
    const banned = ['wallet', 'gas', 'hash', 'block', 'transaction', 'crypto', 'blockchain', 'bitcoin'];

    for (const status of statuses) {
      const { container } = render(<AttestationStatusCard status={status} />);
      const text = container.textContent?.toLowerCase() ?? '';
      for (const term of banned) {
        expect(text).not.toContain(term);
      }
    }
  });
});
