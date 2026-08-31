/**
 * Adobe Sign connector card (SCRUM-1148 follow-up)
 *
 * Mirrors DocusignConnectorCard. Tokens never touch the browser — the worker
 * returns only an Adobe authorization URL after generating signed state.
 *
 * Two differences from the DocuSign card, both driven by real backend
 * behaviour rather than styling:
 *
 *  1. `adobe_sign_unconfigured` is a first-class denial. As of 2026-08-30 no
 *     Adobe Acrobat Sign application is registered and production carries no
 *     Adobe credential, so "not available here yet" is the LIVE path for this
 *     card, not an edge case. It gets its own message instead of falling into
 *     the generic connect-failed copy.
 *  2. The callback error codes are surfaced by name. Adobe's connect can fail
 *     in a way DocuSign's cannot — `webhook_registration_failed` means the
 *     account plan does not grant webhook access — and telling the admin
 *     "try again" for that would be wrong: retrying cannot fix a plan.
 *
 * The OAuth return-trip result (`?adobe_sign=connected` / `?adobe_sign_error=`)
 * is deliberately NOT read here. `OrgProfilePage`'s existing `useSearchParams`
 * effect consumes it alongside Drive and DocuSign, toasts, and strips the
 * params. An earlier draft of this card read the query string in a card-local
 * effect and set component state instead; that silently loses the message under
 * React StrictMode's double mount — the first mount strips the params and its
 * state is discarded, so the second mount reads an empty query string and
 * renders nothing. E2E caught it; unit tests did not, because they mount once.
 * A toast fired imperatively from the page has no such failure mode, which is
 * presumably why the existing connectors already do it there.
 *
 * `adobeSignErrorCopy()` is exported for that page-level handler, so the
 * code -> copy mapping lives in exactly one place.
 */

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle, FileSignature, Loader2, PlugZap, ShieldAlert, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/lib/supabase';
import { workerFetch } from '@/lib/workerClient';
import { CONNECTIONS_LABELS } from '@/lib/copy';
import { useCanIssueCredential } from '@/hooks/useCanIssueCredential';

interface AdobeSignConnectorCardProps {
  orgId: string;
}

interface AdobeSignConnection {
  id: string;
  account_label: string | null;
  account_id: string | null;
  connected_at: string | null;
  scope: string | null;
}

/**
 * Map a worker/callback error code to copy.
 *
 * Codes come from two places that must agree: the `code` field on a
 * `/oauth/start` 4xx/5xx body, and the `?adobe_sign_error=` query parameter the
 * callback redirects with. Both are listed here so the UI message and the
 * backend gate stay in lockstep (the same discipline as the Drive card).
 */
export function adobeSignErrorCopy(code: string | undefined): string {
  switch (code) {
    case 'org_unverified':
    case 'org_not_found':
      return CONNECTIONS_LABELS.ADOBE_SIGN_NOT_VERIFIED;
    case 'org_suspended':
      return CONNECTIONS_LABELS.ADOBE_SIGN_SUSPENDED;
    case 'adobe_sign_unconfigured':
      return CONNECTIONS_LABELS.ADOBE_SIGN_UNCONFIGURED;
    case 'webhook_registration_failed':
      return CONNECTIONS_LABELS.ADOBE_SIGN_WEBHOOK_FAILED;
    case 'webhook_already_claimed':
      return CONNECTIONS_LABELS.ADOBE_SIGN_ALREADY_CLAIMED;
    default:
      return CONNECTIONS_LABELS.CONNECT_FAILED;
  }
}

export function AdobeSignConnectorCard({ orgId }: AdobeSignConnectorCardProps) {
  const [connection, setConnection] = useState<AdobeSignConnection | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Verified-org entitlement, same signal as the DocuSign card (SCRUM-1755).
  // UX defense-in-depth only — the worker `/oauth/start` endpoint is the
  // authoritative gate. Disconnect is never gated.
  const issueGate = useCanIssueCredential({ orgId });
  const gateLoading = issueGate.loading;
  const gateBlocked = !issueGate.loading && !issueGate.allowed;

  const refreshConnection = useCallback(async () => {
    setStatusLoading(true);
    setError(null);
    try {
      // org_integrations is newer than the generated frontend DB types.
      // Deliberately does NOT select webhook_id / encrypted_tokens /
      // token_secret_name: the card needs none of them, and a browser-side
      // select is exactly how DriveConnectorCard leaked `account_label`
      // secrets past the worker's own redaction (GH #1836, round 3).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: queryError } = await (supabase as any)
        .from('org_integrations')
        .select('id, account_label, account_id, connected_at, scope')
        .eq('org_id', orgId)
        .eq('provider', 'adobe_sign')
        .is('revoked_at', null)
        .order('connected_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (queryError) {
        setError('Unable to load Adobe Sign connection status.');
        setConnection(null);
        return;
      }

      setConnection(data ?? null);
    } catch {
      setError('Unable to load Adobe Sign connection status.');
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
    // Defense in depth: never call the worker when the gate denies. The button
    // is disabled in this state, but guard the handler too.
    if (gateBlocked || gateLoading) return;

    setActionLoading(true);
    setError(null);
    try {
      const response = await workerFetch('/api/v1/integrations/adobe-sign/oauth/start', {
        method: 'POST',
        body: JSON.stringify({ org_id: orgId, return_to: window.location.href }),
      });
      const body = await response.json().catch(() => ({})) as {
        authorizationUrl?: string;
        url?: string;
        error?: string;
        code?: string;
      };

      if (!response.ok) {
        // A 503 here is the kill switch: the connector is not enabled on this
        // deployment, which reads the same to the admin as "not configured".
        setError(
          response.status === 503
            ? CONNECTIONS_LABELS.ADOBE_SIGN_UNCONFIGURED
            : adobeSignErrorCopy(body.code),
        );
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
  }, [orgId, gateBlocked, gateLoading]);

  const handleDisconnect = useCallback(async () => {
    setActionLoading(true);
    setError(null);
    try {
      const response = await workerFetch('/api/v1/integrations/adobe-sign/disconnect', {
        method: 'POST',
        body: JSON.stringify({ org_id: orgId }),
      });
      const body = await response.json().catch(() => ({})) as {
        error?: string;
        adobe_webhook_removed?: boolean;
      };

      if (!response.ok) {
        setError(body.error ?? CONNECTIONS_LABELS.DISCONNECT_FAILED);
        return;
      }

      setConnection(null);
      if (body.adobe_webhook_removed === false) {
        // The local teardown succeeded but Adobe kept the registration. Say so:
        // it needs a manual removal in Adobe's console, and pretending
        // otherwise leaves a live webhook nobody knows about.
        setError(CONNECTIONS_LABELS.ADOBE_SIGN_WEBHOOK_STRANDED);
      }
      toast.success(CONNECTIONS_LABELS.ADOBE_SIGN_TOAST_DISCONNECTED);
    } catch (err) {
      setError(err instanceof Error ? err.message : CONNECTIONS_LABELS.DISCONNECT_FAILED);
    } finally {
      setActionLoading(false);
    }
  }, [orgId]);

  const connected = !!connection;
  const accountLabel = connection?.account_label || connection?.account_id;

  return (
    <Card data-testid="adobe-sign-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileSignature className="h-5 w-5" />
          {CONNECTIONS_LABELS.ADOBE_SIGN_NAME}
          {connected && <CheckCircle className="h-5 w-5 text-emerald-500" />}
        </CardTitle>
        <CardDescription>{CONNECTIONS_LABELS.ADOBE_SIGN_DESC}</CardDescription>
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
                  {statusLoading
                    ? CONNECTIONS_LABELS.STATUS_CHECKING
                    : connected
                      ? CONNECTIONS_LABELS.STATUS_CONNECTED
                      : CONNECTIONS_LABELS.STATUS_NOT_CONNECTED}
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
            <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={actionLoading}>
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
              disabled={statusLoading || actionLoading || gateBlocked || gateLoading}
            >
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {actionLoading ? CONNECTIONS_LABELS.CONNECTING : CONNECTIONS_LABELS.CONNECT_BUTTON}
            </Button>
          )}
        </div>

        {!connected && gateLoading && (
          <p className="text-sm text-muted-foreground">{CONNECTIONS_LABELS.ADOBE_SIGN_GATE_CHECKING}</p>
        )}
        {!connected && gateBlocked && (
          <div
            data-testid="adobe-sign-gate-denied"
            className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{CONNECTIONS_LABELS.ADOBE_SIGN_NOT_VERIFIED}</span>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
