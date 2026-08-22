/**
 * Webhook Settings Component
 *
 * Allows ORG_ADMIN to configure webhook endpoints.
 * Secrets are generated server-side and shown once after creation.
 * Secret is write-only — never displayed after the initial creation dialog closes.
 */

import { useState, FormEvent } from 'react';
import { Plus, Trash2, AlertCircle, CheckCircle, Loader2, Copy, Check, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { WEBHOOK_LABELS } from '@/lib/copy';

interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  is_active: boolean;
  created_at: string;
}

/** Result of a signed test ping (WH-02) as returned by the worker. */
export interface WebhookTestPingResult {
  success: boolean;
  status_code: number;
  event_id: string;
}

interface WebhookSettingsProps {
  endpoints: WebhookEndpoint[];
  onAdd: (url: string, events: string[]) => Promise<string>;
  onDelete: (id: string) => Promise<void>;
  onToggle: (id: string, active: boolean) => Promise<void>;
  /**
   * WH-02 (SCRUM-2397): fire a signed test event at the endpoint. Optional so
   * embedding surfaces without a worker session can omit the button entirely.
   */
  onTestPing?: (id: string) => Promise<WebhookTestPingResult>;
  loading?: boolean;
}

// SCRUM-1743: source of truth is `services/worker/src/api/v1/webhooks-schemas.ts`
// `VALID_WEBHOOK_EVENTS`. This array is the UI-facing list — keep it in sync
// when new event types ship there. The previous `anchor.created` entry was
// stale (never accepted by the CRUD allowlist) and was removed.
//
// Credential.* events are contract-defined today; per-event emit points
// land in Phase-2 follow-ups, so the UI shows them with a "Coming soon"
// hint to set the right expectation.
export const AVAILABLE_EVENTS = [
  { id: 'anchor.submitted', label: 'Anchor Submitted' },
  { id: 'anchor.secured', label: 'Anchor Secured' },
  { id: 'anchor.revoked', label: 'Anchor Revoked' },
  { id: 'anchor.expired', label: 'Anchor Expired' },
  { id: 'anchor.batch_secured', label: 'Anchor Batch Secured' },
  // Credential.* are contract-defined today but emit points land in Phase-2
  // follow-ups; the "coming soon" suffix sets the right expectation.
  { id: 'credential.issued', label: 'Credential Issued (coming soon)' },
  { id: 'credential.verified', label: 'Record Verified (coming soon)' },
  { id: 'credential.status_changed', label: 'Record Status Changed (coming soon)' },
  // BUG-002: the emit point (POST /cron/check-credential-expiry, gated on
  // ENABLE_EXPIRY_ALERTS) has existed since SCRUM-600, but the event type was
  // never registered in the worker allowlist, so this option could not be
  // offered and every dispatch matched zero endpoints.
  { id: 'compliance.document_expiring', label: 'Document Expiring Soon' },
];

export function WebhookSettings({
  endpoints,
  onAdd,
  onDelete,
  onToggle,
  onTestPing,
  loading = false,
}: Readonly<WebhookSettingsProps>) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<string[]>(['anchor.secured', 'anchor.revoked']);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Secret display state — shown once after creation
  const [generatedSecret, setGeneratedSecret] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);

  // BUG-D: deleting an endpoint is destructive (the event feed stops), so the
  // Trash button opens a confirm dialog instead of deleting immediately. We hold
  // the endpoint pending confirmation; onDelete only fires on confirm.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const pendingDeleteEndpoint = endpoints.find((ep) => ep.id === pendingDeleteId) ?? null;

  // WH-02: signed test ping state. `testingId` is the in-flight guard (the
  // button disables so a double-click can't fire two pings); `pingResults`
  // holds the last consumer-side verification result per endpoint.
  const [testingId, setTestingId] = useState<string | null>(null);
  const [pingResults, setPingResults] = useState<Record<string, { message: string; ok: boolean }>>({});

  const handleTestPing = async (id: string) => {
    if (!onTestPing || testingId) return;
    setTestingId(id);
    setPingResults((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const result = await onTestPing(id);
      const template = result.success
        ? WEBHOOK_LABELS.TEST_PING_SUCCESS
        : WEBHOOK_LABELS.TEST_PING_FAILURE;
      setPingResults((prev) => ({
        ...prev,
        [id]: {
          message: template.replace('{status}', String(result.status_code)),
          ok: result.success,
        },
      }));
    } catch (err) {
      setPingResults((prev) => ({
        ...prev,
        [id]: {
          message: err instanceof Error ? err.message : WEBHOOK_LABELS.TEST_PING_ERROR,
          ok: false,
        },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!pendingDeleteId) return;
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    await onDelete(id);
  };

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!newUrl.startsWith('https://')) {
      setError('URL must start with https://');
      return;
    }

    if (selectedEvents.length === 0) {
      setError('Select at least one event');
      return;
    }

    setSaving(true);
    try {
      const secret = await onAdd(newUrl, selectedEvents);
      setNewUrl('');
      setSelectedEvents(['anchor.secured', 'anchor.revoked']);
      // Show the generated secret (one-time display)
      setGeneratedSecret(secret);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add endpoint');
    } finally {
      setSaving(false);
    }
  };

  const handleCopySecret = async () => {
    if (!generatedSecret) return;
    try {
      await navigator.clipboard.writeText(generatedSecret);
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 2000);
    } catch {
      // Fallback: select the text so the user can manually copy
      setError('Could not copy to clipboard. Please select and copy the secret manually.');
    }
  };

  const handleCloseDialog = () => {
    setIsDialogOpen(false);
    setGeneratedSecret(null);
    setSecretCopied(false);
    setError(null);
    setNewUrl('');
    setSelectedEvents(['anchor.secured', 'anchor.revoked']);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Webhook Endpoints</CardTitle>
            <CardDescription>
              Receive notifications when events occur in your organization
            </CardDescription>
          </div>
          <Dialog open={isDialogOpen} onOpenChange={(open) => {
            if (!open) {
              handleCloseDialog();
            } else {
              setIsDialogOpen(true);
            }
          }}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Add Endpoint
              </Button>
            </DialogTrigger>
            <DialogContent>
              {generatedSecret ? (
                /* Secret display — shown once after successful creation */
                <>
                  <DialogHeader>
                    <DialogTitle>Endpoint Created</DialogTitle>
                    <DialogDescription>
                      Copy your signing secret now. It will not be shown again.
                    </DialogDescription>
                  </DialogHeader>

                  <div className="space-y-4 py-4">
                    <Alert>
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription>
                        Save this secret securely. You will need it to verify webhook signatures.
                        This is the only time it will be displayed.
                      </AlertDescription>
                    </Alert>

                    <div className="space-y-2">
                      <Label>Signing Secret</Label>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 rounded border bg-muted px-3 py-2 text-xs font-mono break-all select-all">
                          {generatedSecret}
                        </code>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={handleCopySecret}
                        >
                          {secretCopied ? (
                            <Check className="h-4 w-4 text-green-500" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>

                  <DialogFooter>
                    <Button onClick={handleCloseDialog}>
                      Done
                    </Button>
                  </DialogFooter>
                </>
              ) : (
                /* Endpoint creation form */
                <form onSubmit={handleAdd}>
                  <DialogHeader>
                    <DialogTitle>Add Webhook Endpoint</DialogTitle>
                    <DialogDescription>
                      Configure a new endpoint to receive event notifications.
                      A signing secret will be generated automatically.
                    </DialogDescription>
                  </DialogHeader>

                  <div className="space-y-4 py-4">
                    {error && (
                      <Alert variant="destructive">
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription>{error}</AlertDescription>
                      </Alert>
                    )}

                    <div className="space-y-2">
                      <Label htmlFor="url">Endpoint URL</Label>
                      <Input
                        id="url"
                        type="url"
                        value={newUrl}
                        onChange={(e) => setNewUrl(e.target.value)}
                        placeholder="https://your-server.com/webhooks"
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Events</Label>
                      <div className="space-y-2">
                        {AVAILABLE_EVENTS.map((event) => (
                          <label key={event.id} className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selectedEvents.includes(event.id)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedEvents([...selectedEvents, event.id]);
                                } else {
                                  setSelectedEvents(selectedEvents.filter((id) => id !== event.id));
                                }
                              }}
                              className="rounded"
                            />
                            <span className="text-sm">{event.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>

                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={handleCloseDialog}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={saving}>
                      {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      Add Endpoint
                    </Button>
                  </DialogFooter>
                </form>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (endpoints.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <p>No webhook endpoints configured</p>
            <p className="text-sm">Add an endpoint to receive event notifications</p>
          </div>
        ) : (
          <div className="space-y-4">
            {endpoints.map((endpoint) => {
              const isTesting = testingId === endpoint.id;
              const pingResult = pingResults[endpoint.id];
              return (
                <div key={endpoint.id} className="p-4 border rounded-lg space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        {endpoint.is_active ? (
                          <CheckCircle className="h-4 w-4 text-green-500" />
                        ) : (
                          <AlertCircle className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span className="font-mono text-sm">{endpoint.url}</span>
                      </div>
                      <div className="flex gap-1">
                        {endpoint.events.map((event) => (
                          <Badge key={event} variant="secondary" className="text-xs">
                            {event}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {onTestPing && endpoint.is_active && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isTesting}
                          onClick={() => handleTestPing(endpoint.id)}
                        >
                          {isTesting ? (
                            <>
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                              {WEBHOOK_LABELS.TEST_PING_SENDING}
                            </>
                          ) : (
                            <>
                              <Send className="mr-1 h-3 w-3" />
                              {WEBHOOK_LABELS.TEST_PING_ACTION}
                            </>
                          )}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onToggle(endpoint.id, !endpoint.is_active)}
                      >
                        {endpoint.is_active ? 'Disable' : 'Enable'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`${WEBHOOK_LABELS.DELETE_CONFIRM_ACTION}: ${endpoint.url}`}
                        onClick={() => setPendingDeleteId(endpoint.id)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                  {/* WH-02: consumer-side verification result of the signed
                      test event — success = the receiver accepted the signed
                      request with a 2xx. */}
                  {pingResult && (
                    <Alert variant={pingResult.ok ? 'default' : 'destructive'}>
                      {pingResult.ok ? (
                        <CheckCircle className="h-4 w-4" />
                      ) : (
                        <AlertCircle className="h-4 w-4" />
                      )}
                      <AlertDescription>{pingResult.message}</AlertDescription>
                    </Alert>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </CardContent>

      {/* BUG-D: destructive-delete confirmation. Mirrors RevokeDialog /
          ApiKeySettings — onDelete only fires after the user confirms. */}
      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{WEBHOOK_LABELS.DELETE_CONFIRM_TITLE}</AlertDialogTitle>
            <AlertDialogDescription>
              {WEBHOOK_LABELS.DELETE_CONFIRM_DESC.replace(
                '{url}',
                pendingDeleteEndpoint?.url ?? '',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{WEBHOOK_LABELS.DELETE_CONFIRM_CANCEL}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {WEBHOOK_LABELS.DELETE_CONFIRM_ACTION}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
