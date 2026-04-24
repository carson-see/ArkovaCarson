/**
 * Google Drive connector card (SCRUM-1168)
 *
 * User-facing OAuth controls for organization admins. Tokens are never handled
 * in the browser; the worker returns only a Google authorization URL.
 */

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle, Cloud, Loader2, PlugZap, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/lib/supabase';
import { workerFetch } from '@/lib/workerClient';

interface DriveConnectorCardProps {
  orgId: string;
}

interface DriveConnection {
  id: string;
  account_label: string | null;
  connected_at: string | null;
  subscription_expires_at: string | null;
  scope: string | null;
}

export function DriveConnectorCard({ orgId }: DriveConnectorCardProps) {
  const [connection, setConnection] = useState<DriveConnection | null>(null);
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
        .select('id, account_label, connected_at, subscription_expires_at, scope')
        .eq('org_id', orgId)
        .eq('provider', 'google_drive')
        .is('revoked_at', null)
        .order('connected_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (queryError) {
        setError('Unable to load Drive connection status.');
        setConnection(null);
        return;
      }

      setConnection(data ?? null);
    } catch {
      setError('Unable to load Drive connection status.');
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
      const response = await workerFetch('/api/v1/integrations/google_drive/oauth/start', {
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
        setError(body.error ?? 'Failed to start Google Drive connection.');
        return;
      }

      const nextUrl = body.authorizationUrl ?? body.url;
      if (!nextUrl) {
        setError('No Google authorization URL returned.');
        return;
      }

      window.location.assign(nextUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start Google Drive connection.');
    } finally {
      setActionLoading(false);
    }
  }, [orgId]);

  const handleDisconnect = useCallback(async () => {
    setActionLoading(true);
    setError(null);
    try {
      const response = await workerFetch('/api/v1/integrations/google_drive/disconnect', {
        method: 'POST',
        body: JSON.stringify({ org_id: orgId }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };

      if (!response.ok) {
        setError(body.error ?? 'Failed to disconnect Google Drive.');
        return;
      }

      setConnection(null);
      toast.success('Google Drive disconnected.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect Google Drive.');
    } finally {
      setActionLoading(false);
    }
  }, [orgId]);

  const connected = !!connection;
  const subscriptionDate = connection?.subscription_expires_at
    ? new Date(connection.subscription_expires_at).toLocaleDateString('en-US', { dateStyle: 'medium' })
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cloud className="h-5 w-5" />
          Google Drive
          {connected && <CheckCircle className="h-5 w-5 text-emerald-500" />}
        </CardTitle>
        <CardDescription>
          Connect Drive so workspace file changes can trigger organization rules
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
                  {statusLoading ? 'Checking' : connected ? 'Connected' : 'Not Connected'}
                </Badge>
              </div>
              <p className="mt-1 max-w-md text-xs text-muted-foreground">
                {connected
                  ? `Connected${connection?.account_label ? ` as ${connection.account_label}` : ''}.`
                  : 'Authorize Arkova with least-privilege Drive access.'}
              </p>
              {connected && subscriptionDate && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Push channel renews before {subscriptionDate}
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
              Disconnect
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={handleConnect}
              disabled={statusLoading || actionLoading}
            >
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Connect Drive
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
