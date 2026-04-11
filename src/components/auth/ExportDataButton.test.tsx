/**
 * ExportDataButton Tests — REG-11 (SCRUM-572)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExportDataButton } from './ExportDataButton';

vi.mock('@/lib/workerClient', () => ({
  workerFetch: vi.fn(),
}));

const workerClientMock = await import('@/lib/workerClient');

describe('ExportDataButton', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom doesn't implement URL.createObjectURL
    URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it('renders the download button', () => {
    render(<ExportDataButton />);
    expect(screen.getByRole('button', { name: /download my data/i })).toBeInTheDocument();
  });

  it('calls GET /api/account/export and triggers a file download on success', async () => {
    const blob = new Blob([JSON.stringify({ schema: 'arkova.data-export.v1' })], {
      type: 'application/json',
    });
    (workerClientMock.workerFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      blob: async () => blob,
      json: async () => ({}),
    });

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<ExportDataButton />);
    fireEvent.click(screen.getByRole('button', { name: /download my data/i }));

    await waitFor(() => {
      expect(workerClientMock.workerFetch).toHaveBeenCalledWith('/api/account/export', {
        method: 'GET',
      });
    });
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalled();

    clickSpy.mockRestore();
  });

  it('shows the 24h rate-limit message when the worker returns 429', async () => {
    (workerClientMock.workerFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 429,
      blob: async () => new Blob(),
      json: async () => ({ error: 'rate limited' }),
    });

    render(<ExportDataButton />);
    fireEvent.click(screen.getByRole('button', { name: /download my data/i }));

    await waitFor(() => {
      expect(screen.getByText(/24 hours/i)).toBeInTheDocument();
    });
  });

  it('shows a generic error message when the worker returns 500', async () => {
    (workerClientMock.workerFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      blob: async () => new Blob(),
      json: async () => ({ error: 'boom' }),
    });

    render(<ExportDataButton />);
    fireEvent.click(screen.getByRole('button', { name: /download my data/i }));

    await waitFor(() => {
      expect(screen.getByText('boom')).toBeInTheDocument();
    });
  });

  it('disables the button while downloading', async () => {
    let resolveFetch: ((v: unknown) => void) | undefined;
    (workerClientMock.workerFetch as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((r) => { resolveFetch = r; }),
    );

    render(<ExportDataButton />);
    const btn = screen.getByRole('button', { name: /download my data/i });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /preparing download/i })).toBeDisabled();
    });

    resolveFetch?.({
      ok: true,
      status: 200,
      blob: async () => new Blob(),
      json: async () => ({}),
    });
  });
});
