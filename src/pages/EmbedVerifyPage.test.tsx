/**
 * Tests for EmbedVerifyPage (P6-TS-03)
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { EmbedVerifyPage } from './EmbedVerifyPage';

// Mock VerificationWidget to avoid Supabase dependency
vi.mock('@/components/embed/VerificationWidget', () => ({
  VerificationWidget: ({ publicId }: { publicId: string }) => (
    <div data-testid="verification-widget">{publicId}</div>
  ),
}));

describe('EmbedVerifyPage', () => {
  it('renders VerificationWidget with publicId from route params', () => {
    render(
      <MemoryRouter initialEntries={['/embed/verify/ARK-2026-001']}>
        <Routes>
          <Route path="/embed/verify/:publicId" element={<EmbedVerifyPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const widget = screen.getByTestId('verification-widget');
    expect(widget).toBeInTheDocument();
    expect(widget.textContent).toBe('ARK-2026-001');
  });

  it('shows missing ID message when no publicId param', () => {
    render(
      <MemoryRouter initialEntries={['/embed/verify/']}>
        <Routes>
          <Route path="/embed/verify/" element={<EmbedVerifyPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Missing record ID.')).toBeInTheDocument();
  });
});
