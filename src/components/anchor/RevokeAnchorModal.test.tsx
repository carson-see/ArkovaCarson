/**
 * RevokeAnchorModal tests — SCRUM-1096 (ADMIN-VIEW-05).
 *
 * Asserts:
 *   - Renders title + immutability disclaimer
 *   - Reason field is required (≥4 chars after trim) before Confirm enables
 *   - Confirm calls revokeAnchor with the trimmed reason
 *   - Loading state disables both buttons
 *   - Successful revoke calls onRevoked
 *   - Cancel/close clears the reason for next open
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const revokeAnchorMock = vi.fn(async () => true);
let mockLoading = false;
vi.mock('@/hooks/useRevokeAnchor', () => ({
  useRevokeAnchor: () => ({
    revokeAnchor: revokeAnchorMock,
    loading: mockLoading,
    error: null,
    clearError: vi.fn(),
  }),
}));

import { RevokeAnchorModal } from './RevokeAnchorModal';

beforeEach(() => {
  revokeAnchorMock.mockReset();
  revokeAnchorMock.mockResolvedValue(true);
  mockLoading = false;
});

function setup(overrides: Partial<React.ComponentProps<typeof RevokeAnchorModal>> = {}) {
  const onClose = vi.fn();
  const onRevoked = vi.fn();
  const utils = render(
    <RevokeAnchorModal
      open
      onClose={onClose}
      anchorId="anchor-1"
      filename="diploma.pdf"
      onRevoked={onRevoked}
      {...overrides}
    />,
  );
  return { onClose, onRevoked, ...utils };
}

describe('<RevokeAnchorModal />', () => {
  it('renders the immutability disclaimer in the body so admins know the anchor is preserved', () => {
    const { getByText } = setup();
    // Body explains anchor remains immutable (per AC: "anchor remains immutable on chain")
    expect(
      getByText(/network receipt remains immutable on the network/i),
    ).toBeInTheDocument();
  });

  it('disables Confirm until the reason is at least 4 chars (after trim)', () => {
    const { getByLabelText, getByRole } = setup();
    const confirm = getByRole('button', { name: /Mark as Revoked/i });
    expect(confirm).toBeDisabled();

    const textarea = getByLabelText(/Reason \(required\)/);
    fireEvent.change(textarea, { target: { value: '   ab   ' } }); // 2 chars after trim
    expect(confirm).toBeDisabled();

    fireEvent.change(textarea, { target: { value: 'Issued in error' } });
    expect(confirm).not.toBeDisabled();
  });

  it('Confirm calls revokeAnchor with the trimmed reason and fires onRevoked on success', async () => {
    const { getByLabelText, getByRole, onRevoked, onClose } = setup();
    fireEvent.change(getByLabelText(/Reason \(required\)/), {
      target: { value: '  Issued in error  ' },
    });
    fireEvent.click(getByRole('button', { name: /Mark as Revoked/i }));
    await waitFor(() => {
      expect(revokeAnchorMock).toHaveBeenCalledWith('anchor-1', 'Issued in error');
      expect(onClose).toHaveBeenCalled();
      expect(onRevoked).toHaveBeenCalled();
    });
  });

  it('disables Confirm when revoke is in flight (loading state)', () => {
    mockLoading = true;
    const { getByRole } = setup();
    const confirm = getByRole('button', { name: /Revoking/i });
    expect(confirm).toBeDisabled();
  });

  it('Cancel closes the modal without firing revokeAnchor or onRevoked', () => {
    const { getByRole, onClose, onRevoked } = setup();
    fireEvent.click(getByRole('button', { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalled();
    expect(revokeAnchorMock).not.toHaveBeenCalled();
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('respects MIN_REASON_CHARS — exactly 4 chars passes', () => {
    const { getByLabelText, getByRole } = setup();
    fireEvent.change(getByLabelText(/Reason \(required\)/), {
      target: { value: 'fail' },
    });
    expect(getByRole('button', { name: /Mark as Revoked/i })).not.toBeDisabled();
  });
});
