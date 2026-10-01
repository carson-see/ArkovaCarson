/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * OrgRegistryTable.connector-readability.test.tsx
 *
 * TDD red-first (coordinator scope addition, 2026-09-29): the org registry
 * table's desktop row and mobile card both titled themselves with the raw
 * connector-internal filename and gave no version indication.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OrgRegistryTable } from './OrgRegistryTable';

const DRIVE_INTERNAL_FILENAME = 'google_drive:1IxoLk_vWeuU-BB-2Qkmvs8QmV1qi_GKnGxZF8YheIu8';

const driveRow = {
  id: '1',
  filename: DRIVE_INTERNAL_FILENAME,
  fingerprint: 'a'.repeat(64),
  status: 'SUPERSEDED',
  credential_type: null,
  label: null,
  public_id: 'ARK-DOC-1',
  file_size: 0,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  chain_timestamp: null,
  chain_tx_id: null,
  chain_block_height: null,
  version_number: 1,
  metadata: { connector_source: 'google_drive', _drive_folder_path: '/Legal/Q3 Vendor Agreement.gsheet' },
};

vi.mock('@/lib/supabase', () => {
  const builder: Record<string, unknown> = {};
  const passthrough = () => builder;
  for (const method of ['select', 'filter', 'order', 'range', 'or', 'gte', 'lte', 'eq', 'is']) {
    builder[method] = passthrough;
  }
  builder.then = (resolve: (value: unknown) => void) =>
    Promise.resolve({ data: [driveRow], count: 1, error: null }).then(resolve);
  return { supabase: { from: () => builder } };
});

vi.mock('@/hooks/useExportAnchors', () => ({
  useExportAnchors: () => ({ exportAnchors: vi.fn(), loading: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderTable() {
  return render(
    <MemoryRouter>
      <OrgRegistryTable orgId="org-1" isAdmin currentUserId="user-1" />
    </MemoryRouter>,
  );
}

describe('OrgRegistryTable — connector record readability (2026-09-29)', () => {
  it('derives the row title from the Drive folder path instead of the raw internal id', async () => {
    renderTable();
    expect(await screen.findAllByText('Q3 Vendor Agreement.gsheet')).not.toHaveLength(0);
    expect(screen.queryByText(DRIVE_INTERNAL_FILENAME)).not.toBeInTheDocument();
  });

  it('shows a "replaced by newer version" chip for a superseded record without hiding the row', async () => {
    renderTable();
    await waitFor(() => {
      expect(screen.getAllByTestId('record-superseded-chip').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('Q3 Vendor Agreement.gsheet').length).toBeGreaterThan(0);
  });
});
