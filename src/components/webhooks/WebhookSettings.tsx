/**
 * Webhook Settings Component
 *
 * Allows ORG_ADMIN to configure webhook endpoints.
 * Secret is write-only - never displayed after creation.
 */

import { useState, FormEvent } from 'react';
import { Plus, Trash2, AlertCircle, CheckCircle, Loader2, Eye, EyeOff } from 'lucide-react';
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
  onAdd: (url: string, secret: string, events: string[]) => Promise<void>;
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
  const [newSecret, setNewSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [selectedEvents, setSelectedEvents] = useState<string[]>(['anchor.secured', 'anchor.revoked']);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!newUrl.startsWith('https://')) {
      setError('URL must start with https://');
      return;
    }

    if (newSecret.length < 16) {
      setError('Secret must be at least 16 characters');
      return;
    }

    if (selectedEvents.length === 0) {
      setError('Select at least one event');
      return;
    }

    setSaving(true);
    try {
      await onAdd(newUrl, newSecret, selectedEvents);
      setNewUrl('');
      setNewSecret('');
      setSelectedEvents(['anchor.secured', 'anchor.revoked']);
      setIsDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add endpoint');
    } finally {
      setSaving(false);
    }
  };

  const generateSecret = () => {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    const secret = Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
    setNewSecret(secret);
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
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Add Endpoint
              </Button>
            </DialogTrigger>
            <DialogContent>
              <form onSubmit={handleAdd}>
                <DialogHeader>
                  <DialogTitle>Add Webhook Endpoint</DialogTitle>
                  <DialogDescription>
                    Configure a new endpoint to receive event notifications
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
                    <div className="flex items-center justify-between">
                      <Label htmlFor="secret">Signing Secret</Label>
                      <Button type="button" variant="ghost" size="sm" onClick={generateSecret}>
                        Generate
                      </Button>
                    </div>
                    <div className="relative">
                      <Input
                        id="secret"
                        type={showSecret ? 'text' : 'password'}
                        value={newSecret}
                        onChange={(e) => setNewSecret(e.target.value)}
                        placeholder="Enter or generate a secret"
                        required
                        className="pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-0 top-0 h-full"
                        onClick={() => setShowSecret(!showSecret)}
                      >
                        {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Save this secret - it will not be shown again
                    </p>
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
                  <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={saving}>
                    {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Add Endpoint
                  </Button>
                </DialogFooter>
              </form>
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
