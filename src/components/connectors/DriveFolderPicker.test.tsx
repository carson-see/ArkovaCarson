import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { DriveFolderPicker, DRIVE_FOLDER_SELECTION_CAP } from './DriveFolderPicker';
import { CONNECTORS_LABELS } from '@/lib/copy';

const workerFetch = vi.fn();
vi.mock('@/lib/workerClient', () => ({
  workerFetch: (...args: unknown[]) => workerFetch(...args),
}));

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  workerFetch.mockReset();
});

describe('DriveFolderPicker', () => {
  it('fetches My Drive root on open and renders returned rows', async () => {
    workerFetch.mockResolvedValueOnce(
      jsonRes(200, { folders: [{ id: 'f1', name: 'Signed contracts', hasChildren: null, driveId: null }] }),
    );

    render(
      <DriveFolderPicker orgId="org-1" open initialSelected={[]} onOpenChange={vi.fn()} onDone={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByText('Signed contracts')).toBeInTheDocument());

    const call = workerFetch.mock.calls[0];
    expect(call[0]).toContain('/api/v1/integrations/google_drive/folders?');
    const url = new URL(`https://x${call[0]}`);
    expect(url.searchParams.get('org_id')).toBe('org-1');
    expect(url.searchParams.get('parent')).toBe('root');
  });

  it('does not fetch anything while closed', () => {
    render(
      <DriveFolderPicker orgId="org-1" open={false} initialSelected={[]} onOpenChange={vi.fn()} onDone={vi.fn()} />,
    );
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it('selecting two folders then "Use these folders" calls onDone with both, in drive_folder shape', async () => {
    workerFetch.mockResolvedValueOnce(
      jsonRes(200, {
        folders: [
          { id: 'f1', name: 'Contracts', hasChildren: null, driveId: null },
          { id: 'f2', name: 'Onboarding', hasChildren: null, driveId: null },
        ],
      }),
    );
    const onDone = vi.fn();
    render(
      <DriveFolderPicker orgId="org-1" open initialSelected={[]} onOpenChange={vi.fn()} onDone={onDone} />,
    );

    await waitFor(() => expect(screen.getByText('Contracts')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('checkbox', { name: 'Contracts' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Onboarding' }));
    fireEvent.click(screen.getByText(CONNECTORS_LABELS.DRIVE_PICKER_DONE));

    expect(onDone).toHaveBeenCalledWith([
      { type: 'drive_folder', folder_id: 'f1', folder_name: 'Contracts' },
      { type: 'drive_folder', folder_id: 'f2', folder_name: 'Onboarding' },
    ]);
  });

  it('navigating into a folder refetches with the new parent and updates breadcrumbs', async () => {
    workerFetch.mockResolvedValueOnce(
      jsonRes(200, { folders: [{ id: 'f1', name: 'HR', hasChildren: null, driveId: null }] }),
    );
    workerFetch.mockResolvedValueOnce(
      jsonRes(200, { folders: [{ id: 'f2', name: '2026-Q2', hasChildren: null, driveId: null }] }),
    );

    render(
      <DriveFolderPicker orgId="org-1" open initialSelected={[]} onOpenChange={vi.fn()} onDone={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText('HR')).toBeInTheDocument());

    fireEvent.click(screen.getByText('HR'));

    await waitFor(() => expect(screen.getByText('2026-Q2')).toBeInTheDocument());
    const secondCall = workerFetch.mock.calls[1];
    const url = new URL(`https://x${secondCall[0]}`);
    expect(url.searchParams.get('parent')).toBe('f1');
  });

  it('disables unchecked rows once the 20-folder cap is reached (client-side, test 6)', async () => {
    workerFetch.mockResolvedValueOnce(
      jsonRes(200, { folders: [{ id: 'f-new', name: 'Extra folder', hasChildren: null, driveId: null }] }),
    );
    const already = Array.from({ length: DRIVE_FOLDER_SELECTION_CAP }, (_, i) => ({
      type: 'drive_folder' as const,
      folder_id: `existing-${i}`,
      folder_name: `Folder ${i}`,
    }));

    render(
      <DriveFolderPicker orgId="org-1" open initialSelected={already} onOpenChange={vi.fn()} onDone={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText('Extra folder')).toBeInTheDocument());

    expect(screen.getByRole('checkbox', { name: 'Extra folder' })).toBeDisabled();
    expect(screen.getByText(CONNECTORS_LABELS.DRIVE_FOLDERS_CAP)).toBeInTheDocument();
  });

  it('insufficient_drive_scope renders a Reconnect button, not Retry (test 8)', async () => {
    workerFetch.mockResolvedValueOnce(jsonRes(409, { error: { code: 'insufficient_drive_scope' } }));
    const onReconnect = vi.fn();

    render(
      <DriveFolderPicker
        orgId="org-1"
        open
        initialSelected={[]}
        onOpenChange={vi.fn()}
        onDone={vi.fn()}
        onReconnect={onReconnect}
      />,
    );

    await waitFor(() => expect(screen.getByText(CONNECTORS_LABELS.DRIVE_FOLDERS_SCOPE_MISSING)).toBeInTheDocument());
    expect(screen.getByText(CONNECTORS_LABELS.CONNECTOR_RECONNECT_BUTTON)).toBeInTheDocument();
    expect(screen.queryByText(CONNECTORS_LABELS.CONNECTOR_RETRY_BUTTON)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(CONNECTORS_LABELS.CONNECTOR_RECONNECT_BUTTON));
    expect(onReconnect).toHaveBeenCalled();
  });

  it('an unmapped error code falls back to the generic connector load-failed copy', async () => {
    workerFetch.mockResolvedValueOnce(jsonRes(500, { error: { code: 'internal' } }));

    render(
      <DriveFolderPicker orgId="org-1" open initialSelected={[]} onOpenChange={vi.fn()} onDone={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByText(CONNECTORS_LABELS.CONNECTOR_LOAD_FAILED)).toBeInTheDocument());
    expect(screen.getByText(CONNECTORS_LABELS.CONNECTOR_RETRY_BUTTON)).toBeInTheDocument();
  });
});
