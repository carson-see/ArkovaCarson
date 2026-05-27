/**
 * VerificationResultDisplay Tests (SCRUM-1874)
 *
 * TDD: written before the component implementation.
 * Verifies the attestation verification result display renders
 * chain proof data, fingerprint, and status correctly.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VerificationResultDisplay } from './VerificationResultDisplay';
import { ATTESTATION_LABELS } from '@/lib/copy';

// Mock clipboard
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
});

describe('VerificationResultDisplay', () => {
  const chainProof = {
    tx_id: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
    block_height: 850000,
    timestamp: '2026-05-15T10:00:00Z',
    explorer_url: 'https://mempool.space/signet/tx/abc123def456',
  };

  it('renders verification result title', () => {
    render(
      <VerificationResultDisplay
        status="ACTIVE"
        fingerprint="aabbcc1122334455"
        chainProof={chainProof}
      />,
    );
    expect(screen.getByText(ATTESTATION_LABELS.VERIFICATION_RESULT_TITLE)).toBeInTheDocument();
  });

  it('renders passed status for ACTIVE attestation with chain proof', () => {
    render(
      <VerificationResultDisplay
        status="ACTIVE"
        fingerprint="aabbcc1122334455"
        chainProof={chainProof}
      />,
    );
    expect(screen.getByText(ATTESTATION_LABELS.VERIFICATION_PASSED)).toBeInTheDocument();
    expect(screen.getByText(ATTESTATION_LABELS.VERIFICATION_PASSED_DESC)).toBeInTheDocument();
  });

  it('renders pending status when status is PENDING and no chain proof', () => {
    render(
      <VerificationResultDisplay
        status="PENDING"
        fingerprint="aabbcc1122334455"
        chainProof={null}
      />,
    );
    expect(screen.getByText(ATTESTATION_LABELS.VERIFICATION_PENDING)).toBeInTheDocument();
  });

  it('renders failed status for REVOKED attestation', () => {
    render(
      <VerificationResultDisplay
        status="REVOKED"
        fingerprint="aabbcc1122334455"
        chainProof={chainProof}
      />,
    );
    expect(screen.getByText(ATTESTATION_LABELS.VERIFICATION_FAILED)).toBeInTheDocument();
  });

  it('renders fingerprint when provided', () => {
    render(
      <VerificationResultDisplay
        status="ACTIVE"
        fingerprint="aabbcc11223344556677889900aabbcc11223344556677889900aabbcc112233"
        chainProof={chainProof}
      />,
    );
    expect(screen.getByText(ATTESTATION_LABELS.FINGERPRINT)).toBeInTheDocument();
    expect(screen.getByText(/aabbcc112233/)).toBeInTheDocument();
  });

  it('renders network receipt when chain proof is present', () => {
    render(
      <VerificationResultDisplay
        status="ACTIVE"
        fingerprint="aabbcc1122334455"
        chainProof={chainProof}
      />,
    );
    expect(screen.getByText(ATTESTATION_LABELS.NETWORK_RECEIPT)).toBeInTheDocument();
  });

  it('renders network checkpoint (block height) when available', () => {
    render(
      <VerificationResultDisplay
        status="ACTIVE"
        fingerprint="aabbcc1122334455"
        chainProof={chainProof}
      />,
    );
    expect(screen.getByText(ATTESTATION_LABELS.NETWORK_CHECKPOINT)).toBeInTheDocument();
    expect(screen.getByText('850,000')).toBeInTheDocument();
  });

  it('renders network observed time when chain proof has timestamp', () => {
    render(
      <VerificationResultDisplay
        status="ACTIVE"
        fingerprint="aabbcc1122334455"
        chainProof={chainProof}
      />,
    );
    expect(screen.getByText(ATTESTATION_LABELS.NETWORK_OBSERVED_TIME)).toBeInTheDocument();
  });

  it('calls clipboard on copy fingerprint click', () => {
    render(
      <VerificationResultDisplay
        status="ACTIVE"
        fingerprint="aabbcc1122334455"
        chainProof={chainProof}
      />,
    );
    const copyBtn = screen.getByLabelText(ATTESTATION_LABELS.COPY_FINGERPRINT);
    fireEvent.click(copyBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('aabbcc1122334455');
  });

  it('does not render banned terms in any output', () => {
    const banned = ['wallet', 'gas', 'hash', 'block', 'transaction', 'crypto', 'blockchain', 'bitcoin'];
    const { container } = render(
      <VerificationResultDisplay
        status="ACTIVE"
        fingerprint="aabbcc1122334455"
        chainProof={chainProof}
      />,
    );
    const text = container.textContent?.toLowerCase() ?? '';
    for (const term of banned) {
      expect(text).not.toContain(term);
    }
  });
});
