/**
 * Member-level DocuSign connector card (SCRUM-2044)
 *
 * Per-member DocuSign OAuth. Writes to `member_integrations` and uses
 * the member-level OAuth endpoints. Mirrors DocusignConnectorCard pattern —
 * and now shares its status query, redirect handling, disconnect request and
 * card chrome rather than restating them (see this folder's agents.md).
 *
 * There is no entitlement gate here: per-member DocuSign is not gated on org
 * KYB verification the way the org-level connector is.
 */

import { useCallback, useState } from 'react';
import { CheckCircle, FileSignature } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { workerFetch } from '@/lib/workerClient';
import { CONNECTIONS_LABELS } from '@/lib/copy';
import { useSignatureConnection } from './useSignatureConnection';
import { followSignatureOAuthStart } from './signatureOAuthResponse';
import { requestConnectorDisconnect } from './connectorDisconnect';
import { ConnectorCardStatusRow } from './ConnectorCardStatusRow';

interface MemberDocusignConnectorCardProps {
  orgId: string;
}

export function MemberDocusignConnectorCard({ orgId }: Readonly<MemberDocusignConnectorCardProps>) {
  const { connection, setConnection, statusLoading, error, setError } = useSignatureConnection(
    orgId,
    'docusign',
    'Unable to load personal DocuSign connection status.',
    'member_integrations',
  );
  const [actionLoading, setActionLoading] = useState(false);

  const handleConnect = useCallback(async () => {
    setActionLoading(true);
    setError(null);
    try {
      const response = await workerFetch('/api/v1/integrations/docusign/member/oauth/start', {
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
  }, [orgId, setError]);

  const handleDisconnect = useCallback(async () => {
    setActionLoading(true);
    setError(null);
    try {
      const { error: failure } = await requestConnectorDisconnect(
        '/api/v1/integrations/docusign/member/disconnect',
        orgId,
      );
      if (failure) {
        setError(failure);
        return;
      }

      setConnection(null);
      toast.success(CONNECTIONS_LABELS.MEMBER_TOAST_DISCONNECTED);
    } catch (err) {
      setError(err instanceof Error ? err.message : CONNECTIONS_LABELS.DISCONNECT_FAILED);
    } finally {
      setActionLoading(false);
    }
  }, [orgId, setConnection, setError]);

  const connected = !!connection;
  const accountLabel = connection?.account_label || connection?.account_id;

  return (
    <Card data-testid="member-docusign-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileSignature className="h-5 w-5" />
          {CONNECTIONS_LABELS.MEMBER_DOCUSIGN_NAME}
          {connected && <CheckCircle className="h-5 w-5 text-emerald-500" />}
        </CardTitle>
        <CardDescription>
          {CONNECTIONS_LABELS.MEMBER_DOCUSIGN_DESC}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ConnectorCardStatusRow
          statusLoading={statusLoading}
          connected={connected}
          actionLoading={actionLoading}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
        >
          {connected && accountLabel && (
            <p className="mt-1 text-xs text-muted-foreground">
              {CONNECTIONS_LABELS.ACCOUNT_LABEL_PREFIX}{accountLabel}
            </p>
          )}
        </ConnectorCardStatusRow>

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}
      </CardContent>
    </Card>
  );
}
