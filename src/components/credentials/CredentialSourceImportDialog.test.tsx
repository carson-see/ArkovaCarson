import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CredentialSourceImportDialog } from './CredentialSourceImportDialog';

const workerFetchMock = vi.fn();

vi.mock('@/lib/workerClient', () => ({
  workerFetch: (...args: unknown[]) => workerFetchMock(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const PREVIEW = {
  normalized_source_url: 'https://www.credly.example/badges/abc',
  source_provider: 'credly',
  source_payload_hash: 'a'.repeat(64),
  source_payload_content_type: 'text/html',
  source_payload_byte_length: 4096,
  credential_type: 'BADGE',
  credential_title: 'Cloud Architecture Fundamentals',
  credential_issuer: 'Example Cloud',
  credential_issued_at: '2026-04-15',
  verification_level: 'captured_url',
  extraction_method: 'html_metadata',
  extraction_confidence: 0.72,
  evidence_package_hash: 'b'.repeat(64),
};

function renderDialog(onImported = vi.fn()) {
  return {
    onImported,
    onOpenChange: vi.fn(),
    ...render(
      <CredentialSourceImportDialog
        open
        onOpenChange={vi.fn()}
        onImported={onImported}
      />,
    ),
  };
}

describe('CredentialSourceImportDialog', () => {
  beforeEach(() => {
    workerFetchMock.mockReset();
  });

  it('previews a credential source and confirms the import', async () => {
    const user = userEvent.setup();
    const onImported = vi.fn();
    const onOpenChange = vi.fn();
    workerFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(PREVIEW), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        duplicate: false,
        anchor: { public_id: 'ARK-2026-ABC12345', record_uri: 'https://app.test/verify/ARK-2026-ABC12345' },
        preview: PREVIEW,
      }), { status: 201 }));

    render(
      <CredentialSourceImportDialog
        open
        onOpenChange={onOpenChange}
        onImported={onImported}
      />,
    );

    await user.type(screen.getByLabelText(/credential source url/i), 'https://www.credly.example/badges/abc');
    await user.type(screen.getByLabelText(/issuer/i), 'Example Cloud');
    await user.click(screen.getByRole('button', { name: /preview/i }));

    expect(await screen.findByText('Cloud Architecture Fundamentals')).toBeInTheDocument();
    expect(screen.getByText('Example Cloud')).toBeInTheDocument();
    expect(screen.getByText('72%')).toBeInTheDocument();

    const [previewEndpoint, previewInit] = workerFetchMock.mock.calls[0] as [string, RequestInit];
    expect(previewEndpoint).toBe('/api/v1/credential-sources/import-url/preview');
    expect(JSON.parse(previewInit.body as string)).toMatchObject({
      source_url: 'https://www.credly.example/badges/abc',
      credential_type: 'OTHER',
      issuer_hint: 'Example Cloud',
    });

    await user.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => {
      expect(onImported).toHaveBeenCalledTimes(1);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(workerFetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/credential-sources/import-url/confirm',
      expect.objectContaining({ method: 'POST' }),
    );
    const [, confirmInit] = workerFetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(confirmInit.body as string)).toMatchObject({
      expected_source_payload_hash: PREVIEW.source_payload_hash,
    });
  });

  it('shows worker validation errors without confirming', async () => {
    const user = userEvent.setup();
    workerFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Credential source URL must resolve to a public internet host' }), {
        status: 400,
      }),
    );

    renderDialog();
    await user.type(screen.getByLabelText(/credential source url/i), 'https://localhost/credential');
    await user.click(screen.getByRole('button', { name: /preview/i }));

    expect(await screen.findByText(/public internet host/i)).toBeInTheDocument();
    expect(workerFetchMock).toHaveBeenCalledTimes(1);
  });
});
