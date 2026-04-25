/**
 * DocuSign connector card (SCRUM-1101)
 *
 * Mirrors DriveConnectorCard. Tokens never touch the browser — the worker
 * returns only a DocuSign authorization URL after generating signed state.
 */

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle, FileSignature, Loader2, PlugZap, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/lib/supabase';
import { workerFetch } from '@/lib/workerClient';
import { CONNECTIONS_LABELS } from '@/lib/copy';

interface DocusignConnectorCardProps {
  orgId: string;
}

interface DocusignConnection {
  id: string;
  account_label: string | null;
  account_id: string | null;
  connected_at: string | null;
  scope: string | null;
}

export function DocusignConnectorCard({ orgId }: DocusignConnectorCardProps) {
  const [connection, setConnection] = useState<DocusignConnection | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshConnection = useCallback(async () => {
    setStatusLoading(true);
    setError(null);
    try {
      // org_integrations is newer than generated frontend DB types.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: queryError } = await (supabase as any)
        .from('org_integrations')
        .select('id, account_label, account_id, connected_at, scope')
        .eq('org_id', orgId)
        .eq('provider', 'docusign')
        .is('revoked_at', null)
        .order('connected_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (queryError) {
        setError('Unable to load DocuSign connection status.');
        setConnection(null);
        return;
      }

      setConnection(data ?? null);
    } catch {
      setError('Unable to load DocuSign connection status.');
      setConnection(null);
    } finally {
      setStatusLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async Supabase refresh settles after the effect returns
    void refreshConnection();
  }, [refreshConnection]);

  const handleConnect = useCallback(async () => {
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
      const body = await response.json().catch(() => ({})) as {
        authorizationUrl?: string;
        url?: string;
        error?: string;
      };

      if (!response.ok) {
        setError(body.error ?? CONNECTIONS_LABELS.CONNECT_FAILED);
        return;
      }

      const nextUrl = body.authorizationUrl ?? body.url;
      if (!nextUrl) {
        setError(CONNECTIONS_LABELS.CONNECT_FAILED);
        return;
      }

      window.location.assign(nextUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : CONNECTIONS_LABELS.CONNECT_FAILED);
    } finally {
      setActionLoading(false);
    }
  }, [orgId]);

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
  }, [orgId]);

  const connected = !!connection;
  const accountLabel = connection?.account_label || connection?.account_id;

  return (
    <Card>
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
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            {statusLoading ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : connected ? (
              <CheckCircle className="h-5 w-5 text-emerald-500" />
            ) : (
              <PlugZap className="h-5 w-5 text-muted-foreground" />
            )}
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">Status</p>
                <Badge variant={connected ? 'default' : 'secondary'}>
                  {statusLoading ? 'Checking' : connected ? CONNECTIONS_LABELS.STATUS_CONNECTED : CONNECTIONS_LABELS.STATUS_NOT_CONNECTED}
                </Badge>
              </div>
              {connected && accountLabel && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {CONNECTIONS_LABELS.ACCOUNT_LABEL_PREFIX}{accountLabel}
                </p>
              )}
            </div>
          </div>

          {connected ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleDisconnect}
              disabled={actionLoading}
            >
              {actionLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Unplug className="mr-2 h-4 w-4" />
              )}
              {actionLoading ? CONNECTIONS_LABELS.DISCONNECTING : CONNECTIONS_LABELS.DISCONNECT_BUTTON}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={handleConnect}
              disabled={statusLoading || actionLoading}
            >
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {actionLoading ? CONNECTIONS_LABELS.CONNECTING : CONNECTIONS_LABELS.CONNECT_BUTTON}
            </Button>
          )}
        </div>

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}
      </CardContent>
    </Card>
  );
}
