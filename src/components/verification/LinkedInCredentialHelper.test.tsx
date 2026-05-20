/**
 * LinkedInCredentialHelper Tests (CSI-03 / SCRUM-1599)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LinkedInCredentialHelper } from './LinkedInCredentialHelper';

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

// Mock clipboard
const writeText = vi.fn().mockResolvedValue(undefined);
Object.assign(navigator, { clipboard: { writeText } });

// Mock sonner toast
vi.mock('sonner', () => ({ toast: toastMock }));

beforeEach(() => {
  vi.clearAllMocks();
  writeText.mockResolvedValue(undefined);
});

describe('LinkedInCredentialHelper', () => {
  it('renders the credential URL', () => {
    render(<LinkedInCredentialHelper publicId="ARK-2026-001" />);
    expect(screen.getByText('https://app.arkova.ai/verify/ARK-2026-001')).toBeInTheDocument();
  });

  it('uses Arkova verification URL, not LinkedIn URL', () => {
    render(<LinkedInCredentialHelper publicId="ARK-2026-001" />);
    const url = screen.getByText('https://app.arkova.ai/verify/ARK-2026-001');
    expect(url.textContent).not.toContain('linkedin.com');
  });

  it('shows credential URL label', () => {
    render(<LinkedInCredentialHelper publicId="ARK-2026-001" />);
    expect(screen.getByText('Credential URL for LinkedIn')).toBeInTheDocument();
  });

  it('shows the note about credential URL for LinkedIn profile', () => {
    render(<LinkedInCredentialHelper publicId="ARK-2026-001" />);
    expect(screen.getByText(/Credential URL when adding to your LinkedIn profile/)).toBeInTheDocument();
  });

  it('copies URL to clipboard on button click', async () => {
    render(<LinkedInCredentialHelper publicId="ARK-2026-001" />);
    const button = screen.getByRole('button', { name: 'Copy verification URL' });
    fireEvent.click(button);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('https://app.arkova.ai/verify/ARK-2026-001');
    });
    expect(toastMock.success).toHaveBeenCalledWith('Verification URL copied to clipboard');
  });

  it('shows a fallback toast when clipboard copy is unavailable', async () => {
    const clipboardError = new Error('clipboard denied');
    writeText.mockRejectedValueOnce(clipboardError);

    render(<LinkedInCredentialHelper publicId="ARK-2026-001" />);
    const button = screen.getByRole('button', { name: 'Copy verification URL' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith('Unable to copy verification URL');
    });
    expect(clipboardError.message).toContain('clipboard denied');
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('shows help text about not being a native LinkedIn badge', () => {
    render(<LinkedInCredentialHelper publicId="ARK-2026-001" />);
    expect(screen.getByText(/not a native LinkedIn badge/)).toBeInTheDocument();
  });
});
