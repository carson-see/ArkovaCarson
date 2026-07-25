/**
 * ShareSheet Component Tests
 *
 * Tests the share verification link dialog (copy link, QR code, email share).
 *
 * @see UF-08
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ShareSheet } from './ShareSheet';

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

// Mock QRCodeSVG
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => (
    <div data-testid="qr-code" data-value={value} />
  ),
}));

// Mock clipboard
const mockWriteText = vi.fn().mockResolvedValue(undefined);
Object.assign(navigator, {
  clipboard: { writeText: mockWriteText },
});

// Mock window.open for mailto
const mockWindowOpen = vi.fn();
vi.spyOn(window, 'open').mockImplementation(mockWindowOpen);

describe('ShareSheet', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    publicId: 'test-pub-id',
    filename: 'diploma.pdf',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders dialog with title', () => {
    render(<ShareSheet {...defaultProps} />);
    expect(screen.getByText('Share Record')).toBeInTheDocument();
  });

  it('renders description with filename', () => {
    render(<ShareSheet {...defaultProps} />);
    expect(screen.getByText(/Share the verification link.*diploma\.pdf/)).toBeInTheDocument();
  });

  it('renders QR code with correct verification URL', () => {
    render(<ShareSheet {...defaultProps} />);
    const qr = screen.getByTestId('qr-code');
    expect(qr.getAttribute('data-value')).toContain('/verify/test-pub-id');
  });

  it('copies verification link to clipboard', async () => {
    render(<ShareSheet {...defaultProps} />);
    const copyButton = screen.getByText('Copy Verification Link');
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith(
        expect.stringContaining('/verify/test-pub-id')
      );
    });
  });

  it('opens mailto when email share is clicked', () => {
    render(<ShareSheet {...defaultProps} />);
    const emailButton = screen.getByText('Share via Email');
    fireEvent.click(emailButton);
    expect(mockWindowOpen).toHaveBeenCalledWith(
      expect.stringContaining('mailto:'),
      '_self'
    );
  });

  it('does not render when closed', () => {
    render(<ShareSheet {...defaultProps} open={false} />);
    expect(screen.queryByText('Share Record')).not.toBeInTheDocument();
  });
});
