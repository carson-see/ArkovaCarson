/**
 * Route-level container for the Issuer Partnerships admin page —
 * SCRUM-2082 CSI-04D.
 *
 * Resolves the active org id via the existing useActiveOrg hook and
 * supplies a default fetch-based API client. Kept as a thin wrapper so
 * the underlying page component stays fully testable with explicit props.
 */
import { useMemo } from 'react';
import { useActiveOrg } from '@/hooks/useActiveOrg';
import {
  IssuerPartnershipsPage,
  type IssuerPartnershipsApi,
  type IssuerPartnershipRow,
} from './IssuerPartnershipsPage';
import type { ConnectIssuerSubmitBody } from '@/components/issuer-partnerships/ConnectIssuerDialog';

const API_BASE = '/api/v1/integrations/issuer-partnerships';

function defaultApi(): IssuerPartnershipsApi {
  return {
    async list(orgId: string): Promise<IssuerPartnershipRow[]> {
      const resp = await fetch(`${API_BASE}?org_id=${encodeURIComponent(orgId)}`, {
        credentials: 'include',
      });
      if (!resp.ok) {
        throw new Error(`list failed: HTTP ${resp.status}`);
      }
      const body = (await resp.json()) as { data: IssuerPartnershipRow[] };
      return body.data;
    },
    async connect(body: ConnectIssuerSubmitBody): Promise<void> {
      const resp = await fetch(API_BASE, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        throw new Error(`connect failed: HTTP ${resp.status}`);
      }
    },
    async disconnect(rowId: string): Promise<void> {
      const resp = await fetch(`${API_BASE}/${encodeURIComponent(rowId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!resp.ok) {
        throw new Error(`disconnect failed: HTTP ${resp.status}`);
      }
    },
  };
}

export function IssuerPartnershipsPageRoute() {
  const { orgId, loading } = useActiveOrg();
  const api = useMemo(() => defaultApi(), []);

  if (loading) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-8">
        <p className="text-sm text-gray-600">Loading…</p>
      </main>
    );
  }
  if (!orgId) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-8">
        <p className="text-sm text-gray-600">
          You must belong to an organisation to manage issuer partners.
        </p>
      </main>
    );
  }

  return <IssuerPartnershipsPage orgId={orgId} api={api} />;
}

export default IssuerPartnershipsPageRoute;
