/**
 * DocuSign connector card (SCRUM-1101)
 *
 * Mirrors DriveConnectorCard. Tokens never touch the browser — the worker
 * returns only a DocuSign authorization URL after generating signed state.
 */

import { useCallback, useState } from 'react';
import { CheckCircle, FileSignature, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { workerFetch } from '@/lib/workerClient';
import { CONNECTIONS_LABELS } from '@/lib/copy';
import { useCanIssueCredential } from '@/hooks/useCanIssueCredential';
// These live with the OTHER integration cards (Adobe Sign also depends on
// useSignatureConnection and shares this status row) — not moved here with
// this card.
import { useSignatureConnection } from '../integrations/useSignatureConnection';
import { followSignatureOAuthStart } from '../integrations/signatureOAuthResponse';
import { ConnectorCardStatusRow } from '../integrations/ConnectorCardStatusRow';

interface DocusignConnectorCardProps {
  orgId: string;
}

export function DocusignConnectorCard({ orgId }: Readonly<DocusignConnectorCardProps>) {
  const { connection, setConnection, statusLoading, error, setError } =
    useSignatureConnection(orgId, 'docusign', 'Unable to load DocuSign connection status.');
  const [actionLoading, setActionLoading] = useState(false);

  // SCRUM-2361 (DS-01): gate the *connect* action on the shipped verified-org
  // entitlement signal (SCRUM-1755). This is UX defense-in-depth; the worker
  // `/oauth/start` endpoint is the authoritative gate. Disconnect is never
  // gated — a lapsed org must still be able to remove its connection.
  // TODO(PAY-01): when the paid-verified-individual (Stripe Identity) signal
  // ships, the personal/member connector gains its own entitlement; the org
  // connector here continues to key off org KYB verification.
  const issueGate = useCanIssueCredential({ orgId });
  const gateLoading = issueGate.loading;
  const gateBlocked = !issueGate.loading && !issueGate.allowed;

  const handleConnect = useCallback(async () => {
    // Defense in depth: never call the worker when the gate denies. The button
    // is disabled in this state, but guard the handler too.
    if (gateBlocked || gateLoading) {
      return;
    }
    setActionLoading(true);
    setError(null);
    try {
      const response = await workerFetch('/api/v1/integrations/docusign/oauth/start', {
        method: 'POST',
        body: JSON.stringify({
          org_id: orgId,
          return_to: window.location.href,
        }),
      });
      setError(await followSignatureOAuthStart(response, (body) =>
        body.error ?? CONNECTIONS_LABELS.CONNECT_FAILED,
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : CONNECTIONS_LABELS.CONNECT_FAILED);
    } finally {
      setActionLoading(false);
    }
  }, [orgId, gateBlocked, gateLoading, setError]);

  const handleDisconnect = useCallback(async () => {
    setActionLoading(true);
    setError(null);
    try {
      const response = await workerFetch('/api/v1/integrations/docusign/disconnect', {
        method: 'POST',
        body: JSON.stringify({ org_id: orgId }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };

      if (!response.ok) {
        setError(body.error ?? CONNECTIONS_LABELS.DISCONNECT_FAILED);
        return;
      }

      setConnection(null);
      toast.success(CONNECTIONS_LABELS.TOAST_DISCONNECTED);
    } catch (err) {
      setError(err instanceof Error ? err.message : CONNECTIONS_LABELS.DISCONNECT_FAILED);
    } finally {
      setActionLoading(false);
    }
  }, [orgId, setConnection, setError]);

  const connected = !!connection;
  const accountLabel = connection?.account_label || connection?.account_id;

  return (
    <Card data-testid="docusign-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileSignature className="h-5 w-5" />
          {CONNECTIONS_LABELS.DOCUSIGN_NAME}
          {connected && <CheckCircle className="h-5 w-5 text-emerald-500" />}
        </CardTitle>
        <CardDescription>
          {CONNECTIONS_LABELS.DOCUSIGN_DESC}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ConnectorCardStatusRow
          statusLoading={statusLoading}
          connected={connected}
          actionLoading={actionLoading}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          connectDisabled={gateBlocked || gateLoading}
        >
          {connected && accountLabel && (
            <p className="mt-1 text-xs text-muted-foreground">
              {CONNECTIONS_LABELS.ACCOUNT_LABEL_PREFIX}{accountLabel}
            </p>
          )}
        </ConnectorCardStatusRow>

        {/* SCRUM-2361 (DS-01): verified-org entitlement notice. Only shown when
            not already connected — a connected org manages via Disconnect. */}
        {!connected && gateLoading && (
          <p className="text-sm text-muted-foreground">{CONNECTIONS_LABELS.DOCUSIGN_GATE_CHECKING}</p>
        )}
        {!connected && gateBlocked && (
          <div
            data-testid="docusign-gate-denied"
            className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{CONNECTIONS_LABELS.DOCUSIGN_NOT_VERIFIED}</span>
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}
      </CardContent>
    </Card>
  );
}
