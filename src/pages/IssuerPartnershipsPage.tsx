/**
 * Issuer Partnerships admin page — SCRUM-2082 CSI-04D.
 *
 * Shows the list of connected issuer partners (Credly / Accredible / Udemy)
 * for the active org and exposes Connect / Disconnect actions. Last-sync
 * and credential-count columns are placeholders until CSI-05 (Sprint 2)
 * wires the auto-import cron.
 *
 * Data layer: thin fetch helpers (no TanStack Query here so unit tests
 * can drive the component without a QueryClient). Caller passes a custom
 * API client to make the component fully testable.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ConnectIssuerDialog,
  type ConnectIssuerSubmitBody,
} from '@/components/issuer-partnerships/ConnectIssuerDialog';
import { ISSUER_PARTNERSHIP_LABELS } from '@/lib/copy';

export interface IssuerPartnershipRow {
  id: string;
  org_id: string;
  provider: 'credly' | 'accredible' | 'udemy';
  account_id: string;
  account_label: string | null;
  connected_at: string;
  revoked_at: string | null;
  kek_version: number;
  last_sync_at: string | null;
  credential_count: number | null;
}

export interface IssuerPartnershipsApi {
  list(orgId: string): Promise<IssuerPartnershipRow[]>;
  connect(body: ConnectIssuerSubmitBody): Promise<void>;
  disconnect(rowId: string): Promise<void>;
}

export interface IssuerPartnershipsPageProps {
  orgId: string;
  api: IssuerPartnershipsApi;
}

function formatDateTime(value: string | null): string {
  if (!value) return ISSUER_PARTNERSHIP_LABELS.ROW_LAST_SYNC_NEVER;
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export function IssuerPartnershipsPage({
  orgId,
  api,
}: IssuerPartnershipsPageProps) {
  const [rows, setRows] = useState<IssuerPartnershipRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.list(orgId);
      setRows(data);
    } catch {
      setLoadError(ISSUER_PARTNERSHIP_LABELS.ERROR_LOAD);
    } finally {
      setLoading(false);
    }
  }, [api, orgId]);

  useEffect(() => {
    reload().catch(() => undefined);
  }, [reload]);

  const activeRows = useMemo(() => rows.filter((r) => !r.revoked_at), [rows]);

  async function handleConnect(body: ConnectIssuerSubmitBody) {
    setConnectError(null);
    try {
      await api.connect(body);
      setConnectOpen(false);
      await reload();
    } catch {
      setConnectError(ISSUER_PARTNERSHIP_LABELS.CONNECT_ERROR);
    }
  }

  async function handleDisconnect(rowId: string) {
    setActionError(null);
    try {
      await api.disconnect(rowId);
      await reload();
    } catch {
      setActionError(ISSUER_PARTNERSHIP_LABELS.ERROR_DISCONNECT);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8" data-testid="issuer-partnerships-page">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            {ISSUER_PARTNERSHIP_LABELS.PAGE_TITLE}
          </h1>
          <p className="mt-2 text-sm text-gray-600">
            {ISSUER_PARTNERSHIP_LABELS.PAGE_SUBTITLE}
          </p>
        </div>
        <button
          type="button"
          className="rounded bg-black px-3 py-1 text-sm text-white"
          onClick={() => setConnectOpen(true)}
          data-testid="connect-issuer-cta"
        >
          {ISSUER_PARTNERSHIP_LABELS.CONNECT_CTA}
        </button>
      </header>

      {actionError ? (
        <p role="alert" className="mt-4 text-sm text-red-600">
          {actionError}
        </p>
      ) : null}

      {loading ? (
        <p className="mt-8 text-sm text-gray-600">
          {ISSUER_PARTNERSHIP_LABELS.LOADING}
        </p>
      ) : loadError ? (
        <p role="alert" className="mt-8 text-sm text-red-600">
          {loadError}
        </p>
      ) : activeRows.length === 0 ? (
        <section className="mt-8 rounded border border-dashed border-gray-300 p-8 text-center">
          <h2 className="text-lg font-medium">
            {ISSUER_PARTNERSHIP_LABELS.EMPTY_TITLE}
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            {ISSUER_PARTNERSHIP_LABELS.EMPTY_BODY}
          </p>
          <button
            type="button"
            className="mt-4 rounded bg-black px-3 py-1 text-sm text-white"
            onClick={() => setConnectOpen(true)}
          >
            {ISSUER_PARTNERSHIP_LABELS.EMPTY_PRIMARY_CTA}
          </button>
        </section>
      ) : (
        <table className="mt-8 w-full text-sm" data-testid="issuer-partnerships-table">
          <thead>
            <tr className="border-b border-gray-200 text-left">
              <th className="py-2 pr-4">
                {ISSUER_PARTNERSHIP_LABELS.TABLE_HEADER_ISSUER}
              </th>
              <th className="py-2 pr-4">
                {ISSUER_PARTNERSHIP_LABELS.TABLE_HEADER_ACCOUNT}
              </th>
              <th className="py-2 pr-4">
                {ISSUER_PARTNERSHIP_LABELS.TABLE_HEADER_CONNECTED_AT}
              </th>
              <th className="py-2 pr-4">
                {ISSUER_PARTNERSHIP_LABELS.TABLE_HEADER_LAST_SYNC}
              </th>
              <th className="py-2 pr-4">
                {ISSUER_PARTNERSHIP_LABELS.TABLE_HEADER_CREDENTIALS}
              </th>
              <th className="py-2 pr-4">
                {ISSUER_PARTNERSHIP_LABELS.TABLE_HEADER_ACTIONS}
              </th>
            </tr>
          </thead>
          <tbody>
            {activeRows.map((row) => (
              <tr key={row.id} className="border-b border-gray-100">
                <td className="py-2 pr-4">
                  {ISSUER_PARTNERSHIP_LABELS.PROVIDER_NAMES[row.provider]}
                </td>
                <td className="py-2 pr-4">
                  {row.account_label ?? row.account_id}
                </td>
                <td className="py-2 pr-4">{formatDateTime(row.connected_at)}</td>
                <td className="py-2 pr-4">{formatDateTime(row.last_sync_at)}</td>
                <td className="py-2 pr-4">
                  {row.credential_count ??
                    ISSUER_PARTNERSHIP_LABELS.ROW_CREDENTIAL_COUNT_PENDING}
                </td>
                <td className="py-2 pr-4">
                  <button
                    type="button"
                    onClick={() => handleDisconnect(row.id)}
                    data-testid={`disconnect-${row.id}`}
                    className="rounded border border-gray-300 px-2 py-1 text-xs"
                  >
                    {ISSUER_PARTNERSHIP_LABELS.DISCONNECT_CTA}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ConnectIssuerDialog
        open={connectOpen}
        orgId={orgId}
        onClose={() => setConnectOpen(false)}
        onSubmit={handleConnect}
        submitError={connectError}
      />
    </main>
  );
}

export default IssuerPartnershipsPage;
