/**
 * Webhook Settings Component
 *
 * Allows ORG_ADMIN to configure webhook endpoints.
 * Secrets are generated server-side and shown once after creation.
 * Secret is write-only — never displayed after the initial creation dialog closes.
 */

import { useState, FormEvent } from 'react';
import { Plus, Trash2, AlertCircle, CheckCircle, Loader2, Copy, Check } from 'lucide-react';
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

interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  is_active: boolean;
  created_at: string;
}

interface WebhookSettingsProps {
  endpoints: WebhookEndpoint[];
  onAdd: (url: string, events: string[]) => Promise<string>;
  onDelete: (id: string) => Promise<void>;
  onToggle: (id: string, active: boolean) => Promise<void>;
  loading?: boolean;
}

const AVAILABLE_EVENTS = [
  { id: 'anchor.secured', label: 'Anchor Secured' },
  { id: 'anchor.revoked', label: 'Anchor Revoked' },
  { id: 'anchor.created', label: 'Anchor Created' },
];

export function WebhookSettings({
  endpoints,
  onAdd,
  onDelete,
  onToggle,
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
    await navigator.clipboard.writeText(generatedSecret);
    setSecretCopied(true);
    setTimeout(() => setSecretCopied(false), 2000);
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
            {endpoints.map((endpoint) => (
              <div
                key={endpoint.id}
                className="flex items-center justify-between p-4 border rounded-lg"
              >
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
                    onClick={() => onDelete(endpoint.id)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
