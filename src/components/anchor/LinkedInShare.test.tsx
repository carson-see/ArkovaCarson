/**
 * BETA-09: LinkedIn Verification Badge Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LinkedInShareButton, LinkedInBadgeSnippet } from './LinkedInShare';

// Mock clipboard
const mockWriteText = vi.fn().mockResolvedValue(undefined);
Object.assign(navigator, {
  clipboard: { writeText: mockWriteText },
});

// Mock window.open
const mockOpen = vi.fn();
vi.stubGlobal('open', mockOpen);

describe('LinkedInShareButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders share on LinkedIn button', () => {
    render(
      <LinkedInShareButton
        publicId="abc-123"
        credentialType="Degree"
      />
    );

    expect(screen.getByRole('button', { name: /linkedin/i })).toBeInTheDocument();
  });

  it('opens LinkedIn share URL on click', () => {
    render(
      <LinkedInShareButton
        publicId="abc-123"
        credentialType="Degree"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /linkedin/i }));

    expect(mockOpen).toHaveBeenCalledWith(
      expect.stringContaining('linkedin.com/sharing/share-offsite'),
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('includes verification URL in share link', () => {
    render(
      <LinkedInShareButton
        publicId="abc-123"
        credentialType="Degree"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /linkedin/i }));

    const callUrl = mockOpen.mock.calls[0][0] as string;
    expect(callUrl).toContain('abc-123');
  });
});

describe('LinkedInBadgeSnippet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders badge snippet dialog trigger', () => {
    render(
      <LinkedInBadgeSnippet
        publicId="abc-123"
        status="SECURED"
      />
    );

    expect(screen.getByRole('button', { name: /badge/i })).toBeInTheDocument();
  });

  it('shows HTML snippet when dialog opens', async () => {
    render(
      <LinkedInBadgeSnippet
        publicId="abc-123"
        status="SECURED"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /badge/i }));

    await waitFor(() => {
      expect(screen.getByText('Embed Code')).toBeInTheDocument();
    });

    // Should contain the badge HTML snippet
    const codeBlock = screen.getByRole('code');
    expect(codeBlock.textContent).toContain('abc-123');
    expect(codeBlock.textContent).toContain('Verified by Arkova');
  });

  it('copies snippet to clipboard', async () => {
    render(
      <LinkedInBadgeSnippet
        publicId="abc-123"
        status="SECURED"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /badge/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /copy/i }));

    expect(mockWriteText).toHaveBeenCalledWith(
      expect.stringContaining('abc-123')
    );
  });
});
