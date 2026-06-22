import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfessionalEducationExportPanel } from './ProfessionalEducationExportPanel';

const workerFetchMock = vi.hoisted(() => vi.fn());
const openMock = vi.hoisted(() => vi.fn());
const userId = '11111111-1111-4111-8111-111111111111';

vi.mock('@/lib/workerClient', () => ({
  workerFetch: (...args: unknown[]) => workerFetchMock(...args),
}));

vi.stubGlobal('open', openMock);

function exportResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      request_id: 'request-1',
      record_count: 2,
      requested_format: 'pdf',
      exports: {
        pdf: { signed_url: 'https://exports.example/cpe.pdf', path: 'cpe.pdf', expires_in: 3600 },
        json: { signed_url: 'https://exports.example/cpe.json', path: 'cpe.json', expires_in: 3600 },
      },
    }),
  } as Response;
}

describe('ProfessionalEducationExportPanel', () => {
  beforeEach(() => {
    workerFetchMock.mockReset();
    openMock.mockReset();
  });

  it('posts CPE period and selected format, then opens the matching signed URL', async () => {
    const user = userEvent.setup();
    workerFetchMock.mockResolvedValueOnce(exportResponse());

    render(<ProfessionalEducationExportPanel userId={userId} />);

    await user.type(screen.getByLabelText('CPE period start'), '2026-01-01');
    await user.type(screen.getByLabelText('CPE period end'), '2026-12-31');
    await user.click(screen.getByRole('button', { name: 'Export CPE log' }));

    await waitFor(() => expect(workerFetchMock).toHaveBeenCalledTimes(1));
    expect(workerFetchMock).toHaveBeenCalledWith('/api/v1/exports/cpe-log', {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId,
        period_start: '2026-01-01',
        period_end: '2026-12-31',
        format: 'pdf',
      }),
    });
    expect(openMock).toHaveBeenCalledWith('https://exports.example/cpe.pdf', '_blank', 'noopener,noreferrer');
    expect(await screen.findByText('CPE log ready. 2 records included.')).toBeInTheDocument();
  });

  it('posts CLE jurisdiction, period, and JSON format, then opens the JSON signed URL', async () => {
    const user = userEvent.setup();
    workerFetchMock.mockResolvedValueOnce(exportResponse());

    render(<ProfessionalEducationExportPanel userId={userId} />);

    await user.type(screen.getByLabelText('CLE jurisdiction'), 'US-MI');
    await user.type(screen.getByLabelText('CLE period start'), '2026-01-01');
    await user.type(screen.getByLabelText('CLE period end'), '2026-12-31');
    await user.click(screen.getByRole('button', { name: 'JSON' }));
    await user.click(screen.getByRole('button', { name: 'Export CLE log' }));

    await waitFor(() => expect(workerFetchMock).toHaveBeenCalledTimes(1));
    expect(workerFetchMock).toHaveBeenCalledWith('/api/v1/exports/cle-log', {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId,
        jurisdiction: 'US-MI',
        period_start: '2026-01-01',
        period_end: '2026-12-31',
        format: 'json',
      }),
    });
    expect(openMock).toHaveBeenCalledWith('https://exports.example/cpe.json', '_blank', 'noopener,noreferrer');
  });

  it('disables the export button while a request is running and surfaces failures', async () => {
    const user = userEvent.setup();
    workerFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Failed to generate CPE compliance log' }),
    } as Response);

    render(<ProfessionalEducationExportPanel userId={userId} />);

    await user.type(screen.getByLabelText('CPE period start'), '2026-01-01');
    await user.type(screen.getByLabelText('CPE period end'), '2026-12-31');
    await user.click(screen.getByRole('button', { name: 'Export CPE log' }));

    expect(await screen.findByText('Failed to generate CPE compliance log')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CPE log' })).toBeEnabled();
    expect(openMock).not.toHaveBeenCalled();
  });

  it('rejects a non-http signed URL before opening a new window', async () => {
    const user = userEvent.setup();
    workerFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        record_count: 1,
        exports: {
          pdf: { signed_url: 'javascript:alert(1)' },
          json: { signed_url: 'https://exports.example/cpe.json' },
        },
      }),
    } as Response);

    render(<ProfessionalEducationExportPanel userId={userId} />);

    await user.type(screen.getByLabelText('CPE period start'), '2026-01-01');
    await user.type(screen.getByLabelText('CPE period end'), '2026-12-31');
    await user.click(screen.getByRole('button', { name: 'Export CPE log' }));

    expect(await screen.findByText('The export completed, but the download link was not safe to open.')).toBeInTheDocument();
    expect(openMock).not.toHaveBeenCalled();
  });

  it('does not leave the button stuck loading when Zod rejects the request (over-long jurisdiction)', async () => {
    const user = userEvent.setup();

    render(<ProfessionalEducationExportPanel userId={userId} />);

    // 33 chars > the schema's .max(32) jurisdiction cap → safeParse fails,
    // but the start <= end pre-check passes, so we exercise the Zod guard.
    await user.type(screen.getByLabelText('CLE jurisdiction'), 'X'.repeat(33));
    await user.type(screen.getByLabelText('CLE period start'), '2026-01-01');
    await user.type(screen.getByLabelText('CLE period end'), '2026-12-31');

    const exportButton = screen.getByRole('button', { name: 'Export CLE log' });
    await user.click(exportButton);

    // Validation error surfaces…
    expect(await screen.findByText('Choose a valid reporting period before exporting.')).toBeInTheDocument();
    // …the network is never hit (Zod blocked it before workerFetch)…
    expect(workerFetchMock).not.toHaveBeenCalled();
    // …and the button is NOT stuck in the loading state.
    expect(screen.getByRole('button', { name: 'Export CLE log' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Exporting CLE log' })).not.toBeInTheDocument();
  });

  it('does not leave the button stuck loading when Zod rejects a malformed user id', async () => {
    const user = userEvent.setup();

    render(<ProfessionalEducationExportPanel userId="not-a-uuid" />);

    await user.type(screen.getByLabelText('CPE period start'), '2026-01-01');
    await user.type(screen.getByLabelText('CPE period end'), '2026-12-31');

    await user.click(screen.getByRole('button', { name: 'Export CPE log' }));

    expect(await screen.findByText('Choose a valid reporting period before exporting.')).toBeInTheDocument();
    expect(workerFetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Export CPE log' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Exporting CPE log' })).not.toBeInTheDocument();
  });
});
