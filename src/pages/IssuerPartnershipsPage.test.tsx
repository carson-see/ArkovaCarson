/**
 * IssuerPartnershipsPage tests — SCRUM-2082 CSI-04D.
 * Drives the component with a fake API client so no real HTTP runs.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  IssuerPartnershipsPage,
  type IssuerPartnershipRow,
  type IssuerPartnershipsApi,
} from './IssuerPartnershipsPage';
import { ISSUER_PARTNERSHIP_LABELS } from '@/lib/copy';

const ARKOVA_ORG_ID = '00000000-0000-0000-0000-000000000001';

function makeRow(over: Partial<IssuerPartnershipRow> = {}): IssuerPartnershipRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    org_id: ARKOVA_ORG_ID,
    provider: 'credly',
    account_id: 'credly-org-1',
    account_label: 'Acme Credly',
    connected_at: '2026-05-01T00:00:00Z',
    revoked_at: null,
    kek_version: 1,
    last_sync_at: null,
    credential_count: null,
    ...over,
  };
}

function makeFakeApi(rows: IssuerPartnershipRow[]): IssuerPartnershipsApi {
  return {
    list: vi.fn(async () => rows),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
  };
}

describe('SCRUM-2082 — IssuerPartnershipsPage', () => {
  it('renders the loading state then the empty state when no rows exist', async () => {
    const api = makeFakeApi([]);
    render(<IssuerPartnershipsPage orgId={ARKOVA_ORG_ID} api={api} />);

    expect(screen.getByText(ISSUER_PARTNERSHIP_LABELS.LOADING)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(ISSUER_PARTNERSHIP_LABELS.EMPTY_TITLE)).toBeInTheDocument(),
    );
    expect(api.list).toHaveBeenCalledWith(ARKOVA_ORG_ID);
  });

  it('lists active issuer partnerships and excludes revoked rows', async () => {
    const api = makeFakeApi([
      makeRow({ id: 'r1', account_label: 'Acme Credly', provider: 'credly' }),
      makeRow({
        id: 'r2',
        account_label: 'Acme Accredible',
        provider: 'accredible',
        account_id: 'accredible-org-1',
        connected_at: '2026-05-02T00:00:00Z',
      }),
      // Revoked row should not appear in the table
      makeRow({
        id: 'r3-revoked',
        account_label: 'Old Credly',
        revoked_at: '2026-04-01T00:00:00Z',
      }),
    ]);
    render(<IssuerPartnershipsPage orgId={ARKOVA_ORG_ID} api={api} />);

    const table = await screen.findByTestId('issuer-partnerships-table');
    const rows = within(table).getAllByRole('row');
    // 1 header row + 2 active rows
    expect(rows).toHaveLength(3);
    expect(within(table).getByText('Acme Credly')).toBeInTheDocument();
    expect(within(table).getByText('Acme Accredible')).toBeInTheDocument();
    expect(within(table).queryByText('Old Credly')).not.toBeInTheDocument();
  });

  it('shows placeholder text for last_sync_at and credential_count until the cron is wired', async () => {
    const api = makeFakeApi([makeRow()]);
    render(<IssuerPartnershipsPage orgId={ARKOVA_ORG_ID} api={api} />);
    const table = await screen.findByTestId('issuer-partnerships-table');
    expect(
      within(table).getByText(ISSUER_PARTNERSHIP_LABELS.ROW_LAST_SYNC_NEVER),
    ).toBeInTheDocument();
    expect(
      within(table).getByText(ISSUER_PARTNERSHIP_LABELS.ROW_CREDENTIAL_COUNT_PENDING),
    ).toBeInTheDocument();
  });

  it('opens the connect dialog when the primary CTA is clicked', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi([]);
    render(<IssuerPartnershipsPage orgId={ARKOVA_ORG_ID} api={api} />);
    await screen.findByText(ISSUER_PARTNERSHIP_LABELS.EMPTY_TITLE);

    await user.click(screen.getByTestId('connect-issuer-cta'));
    expect(
      screen.getByText(ISSUER_PARTNERSHIP_LABELS.CONNECT_DIALOG_TITLE),
    ).toBeInTheDocument();
  });

  it('submits a Credly connect payload through the api adapter and reloads', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi([]);
    render(<IssuerPartnershipsPage orgId={ARKOVA_ORG_ID} api={api} />);
    await screen.findByText(ISSUER_PARTNERSHIP_LABELS.EMPTY_TITLE);

    await user.click(screen.getByTestId('connect-issuer-cta'));
    await user.type(screen.getByLabelText(/Account identifier/i), 'credly-org-1');
    await user.type(screen.getByLabelText(/Client ID/i), 'cid-1');
    await user.type(screen.getByLabelText(/Client secret/i), 'csec-1');
    await user.click(screen.getByText(ISSUER_PARTNERSHIP_LABELS.CONNECT_SUBMIT));

    await waitFor(() => expect(api.connect).toHaveBeenCalledTimes(1));
    const sent = (api.connect as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.provider).toBe('credly');
    expect(sent.account_id).toBe('credly-org-1');
    expect(sent.credentials).toEqual({ client_id: 'cid-1', client_secret: 'csec-1' });
    // Reload must have been triggered after the connect resolves
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('switches to api_key fields when Accredible is selected in the dialog', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi([]);
    render(<IssuerPartnershipsPage orgId={ARKOVA_ORG_ID} api={api} />);
    await screen.findByText(ISSUER_PARTNERSHIP_LABELS.EMPTY_TITLE);

    await user.click(screen.getByTestId('connect-issuer-cta'));
    await user.selectOptions(screen.getByLabelText(/Issuer/i), 'accredible');

    expect(screen.getByLabelText(/API key/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Client secret/i)).not.toBeInTheDocument();
  });

  it('disconnects a row through the api adapter and reloads', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi([makeRow({ id: 'r1' })]);
    render(<IssuerPartnershipsPage orgId={ARKOVA_ORG_ID} api={api} />);
    await screen.findByTestId('issuer-partnerships-table');

    await user.click(screen.getByTestId('disconnect-r1'));
    await waitFor(() => expect(api.disconnect).toHaveBeenCalledWith('r1'));
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('shows an error on list failure', async () => {
    const api: IssuerPartnershipsApi = {
      list: vi.fn(async () => {
        throw new Error('boom');
      }),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    render(<IssuerPartnershipsPage orgId={ARKOVA_ORG_ID} api={api} />);
    expect(
      await screen.findByText(ISSUER_PARTNERSHIP_LABELS.ERROR_LOAD),
    ).toBeInTheDocument();
  });

  it('shows an error on disconnect failure', async () => {
    const user = userEvent.setup();
    const api: IssuerPartnershipsApi = {
      list: vi.fn(async () => [makeRow({ id: 'r1' })]),
      connect: vi.fn(),
      disconnect: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    render(<IssuerPartnershipsPage orgId={ARKOVA_ORG_ID} api={api} />);
    await screen.findByTestId('issuer-partnerships-table');

    await user.click(screen.getByTestId('disconnect-r1'));
    expect(
      await screen.findByText(ISSUER_PARTNERSHIP_LABELS.ERROR_DISCONNECT),
    ).toBeInTheDocument();
  });

  it('never leaks the client_secret back into the DOM after dialog close', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi([]);
    render(<IssuerPartnershipsPage orgId={ARKOVA_ORG_ID} api={api} />);
    await screen.findByText(ISSUER_PARTNERSHIP_LABELS.EMPTY_TITLE);

    await user.click(screen.getByTestId('connect-issuer-cta'));
    const secretInput = screen.getByLabelText(/Client secret/i) as HTMLInputElement;
    await user.type(secretInput, 'super-secret-xyz');
    expect(secretInput.value).toBe('super-secret-xyz');

    await user.click(screen.getByText(ISSUER_PARTNERSHIP_LABELS.CONNECT_CANCEL));

    // Re-open the dialog and confirm the secret field is empty.
    await user.click(screen.getByTestId('connect-issuer-cta'));
    const reopened = screen.getByLabelText(/Client secret/i) as HTMLInputElement;
    expect(reopened.value).toBe('');
  });
});
