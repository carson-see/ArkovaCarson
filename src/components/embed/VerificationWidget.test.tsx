/**
 * Tests for VerificationWidget (P6-TS-03)
 *
 * Validates the embeddable verification widget renders correctly
 * in both compact and full modes, handles errors, and logs
 * verification events with method='embed'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { VerificationWidget } from './VerificationWidget';

// Mock Supabase
const mockRpc = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

// Mock logVerificationEvent
const mockLogEvent = vi.fn();
vi.mock('@/lib/logVerificationEvent', () => ({
  logVerificationEvent: (...args: unknown[]) => mockLogEvent(...args),
}));

const MOCK_ANCHOR = {
  public_id: 'ARK-2026-001',
  fingerprint: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd',
  status: 'SECURED',
  filename: 'diploma.pdf',
  file_size: 1024,
  verified: true,
  credential_type: 'ACADEMIC_TRANSCRIPT',
  issuer_name: 'University of Michigan',
  secured_at: '2026-03-15T12:00:00Z',
};

describe('VerificationWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockRpc.mockReturnValue(new Promise(() => {})); // never resolves
    render(<VerificationWidget publicId="ARK-2026-001" />);
    // Loader2 has animate-spin class
    expect(document.querySelector('.animate-spin')).toBeTruthy();
  });

  it('renders full mode with anchor data', async () => {
    mockRpc.mockResolvedValue({ data: MOCK_ANCHOR, error: null });
    render(<VerificationWidget publicId="ARK-2026-001" />);

    await waitFor(() => {
      expect(screen.getByText('Verified')).toBeInTheDocument();
    });
    expect(screen.getByText('diploma.pdf')).toBeInTheDocument();
    expect(screen.getByText('University of Michigan')).toBeInTheDocument();
    expect(screen.getByText('Full verification details')).toBeInTheDocument();
  });

  it('renders compact mode', async () => {
    mockRpc.mockResolvedValue({ data: MOCK_ANCHOR, error: null });
    render(<VerificationWidget publicId="ARK-2026-001" compact />);

    await waitFor(() => {
      expect(screen.getByText('Verified')).toBeInTheDocument();
    });
    expect(screen.getByText('diploma.pdf')).toBeInTheDocument();
    // Compact mode should NOT show "Full verification details"
    expect(screen.queryByText('Full verification details')).not.toBeInTheDocument();
  });

  it('shows error state for not found', async () => {
    mockRpc.mockResolvedValue({ data: { error: 'Record not found' }, error: null });
    render(<VerificationWidget publicId="INVALID-ID" />);

    await waitFor(() => {
      expect(screen.getByText('Not Found')).toBeInTheDocument();
    });
    expect(screen.getByText('This record could not be verified.')).toBeInTheDocument();
  });

  it('shows error state on RPC failure', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'RPC error' } });
    render(<VerificationWidget publicId="ARK-2026-001" />);

    await waitFor(() => {
      expect(screen.getByText('Not Found')).toBeInTheDocument();
    });
  });

  it('renders revoked status correctly', async () => {
    mockRpc.mockResolvedValue({
      data: { ...MOCK_ANCHOR, status: 'REVOKED' },
      error: null,
    });
    render(<VerificationWidget publicId="ARK-2026-001" />);

    await waitFor(() => {
      expect(screen.getByText('Record Revoked')).toBeInTheDocument();
    });
  });

  it('logs verification event with method embed', async () => {
    mockRpc.mockResolvedValue({ data: MOCK_ANCHOR, error: null });
    render(<VerificationWidget publicId="ARK-2026-001" />);

    await waitFor(() => {
      expect(screen.getByText('Verified')).toBeInTheDocument();
    });

    expect(mockLogEvent).toHaveBeenCalledWith({
      publicId: 'ARK-2026-001',
      method: 'embed',
      result: 'verified',
    });
  });

  it('logs revoked result in verification event', async () => {
    mockRpc.mockResolvedValue({
      data: { ...MOCK_ANCHOR, status: 'REVOKED' },
      error: null,
    });
    render(<VerificationWidget publicId="ARK-2026-001" />);

    await waitFor(() => {
      expect(screen.getByText('Record Revoked')).toBeInTheDocument();
    });

    expect(mockLogEvent).toHaveBeenCalledWith({
      publicId: 'ARK-2026-001',
      method: 'embed',
      result: 'revoked',
    });
  });

  it('logs not_found result on error', async () => {
    mockRpc.mockResolvedValue({ data: { error: 'not found' }, error: null });
    render(<VerificationWidget publicId="INVALID" />);

    await waitFor(() => {
      expect(screen.getByText('Not Found')).toBeInTheDocument();
    });

    expect(mockLogEvent).toHaveBeenCalledWith({
      publicId: 'INVALID',
      method: 'embed',
      result: 'not_found',
    });
  });

  it('does not fetch when publicId is empty', () => {
    render(<VerificationWidget publicId="" />);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
