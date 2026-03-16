/**
 * API Key Settings Component (P4.5-TS-09)
 *
 * Full CRUD for API keys:
 * - List keys with prefix, name, status, scopes, last used
 * - Create new key (two-phase: form → one-time secret display)
 * - Revoke/delete keys with confirmation
 *
 * Follows WebhookSettings pattern for two-phase secret display.
 */

import { useState, FormEvent } from 'react';
import { Plus, Trash2, Key, Copy, Check, AlertCircle, Loader2, Ban } from 'lucide-react';
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
import { API_KEY_LABELS } from '@/lib/copy';
import { ApiKeyScopeDisplay } from './ApiKeyScopeDisplay';
import type { ApiKeyMasked, ApiKeyCreated } from '@/hooks/useApiKeys';

interface ApiKeySettingsProps {
  keys: ApiKeyMasked[];
  onCreate: (name: string, scopes: string[], expiresInDays?: number) => Promise<ApiKeyCreated>;
  onRevoke: (keyId: string) => Promise<void>;
  onDelete: (keyId: string) => Promise<void>;
  loading?: boolean;
}

const AVAILABLE_SCOPES = [
  { id: 'verify', label: API_KEY_LABELS.SCOPE_VERIFY, description: 'Single credential verification' },
  { id: 'batch', label: API_KEY_LABELS.SCOPE_BATCH, description: 'Batch verification (up to 100)' },
  { id: 'usage', label: API_KEY_LABELS.SCOPE_USAGE, description: 'View usage statistics' },
];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function KeyStatusBadge({ apiKey }: { apiKey: ApiKeyMasked }) {
  if (!apiKey.is_active) {
    return <Badge variant="secondary" className="bg-gray-100 text-gray-600">{API_KEY_LABELS.REVOKED}</Badge>;
  }
  if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
    return <Badge variant="secondary" className="bg-gray-100 text-gray-600">{API_KEY_LABELS.EXPIRED}</Badge>;
  }
  return <Badge variant="default" className="bg-green-100 text-green-700">{API_KEY_LABELS.ACTIVE}</Badge>;
}

export function ApiKeySettings({
  keys,
  onCreate,
  onRevoke,
  onDelete,
  loading = false,
}: ApiKeySettingsProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [phase, setPhase] = useState<'form' | 'secret'>('form');
  const [name, setName] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<string[]>(['verify']);
  const [expiryDays, setExpiryDays] = useState('');
  const [createdKey, setCreatedKey] = useState<ApiKeyCreated | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: 'revoke' | 'delete'; keyId: string } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const resetForm = () => {
    setPhase('form');
    setName('');
    setSelectedScopes(['verify']);
    setExpiryDays('');
    setCreatedKey(null);
    setCreating(false);
    setError(null);
    setCopied(false);
  };

  const handleDialogChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) resetForm();
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setCreating(true);
    setError(null);

    try {
      const days = expiryDays ? parseInt(expiryDays, 10) : undefined;
      if (days !== undefined && (isNaN(days) || days < 1)) {
        setError('Expiry must be a positive number of days');
        setCreating(false);
        return;
      }

      const result = await onCreate(name.trim(), selectedScopes, days);
      setCreatedKey(result);
      setPhase('secret');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create key');
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!createdKey) return;
    await navigator.clipboard.writeText(createdKey.key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const toggleScope = (scope: string) => {
    setSelectedScopes((prev) =>
      prev.includes(scope)
        ? prev.filter((s) => s !== scope)
        : [...prev, scope],
    );
  };

  const handleConfirmAction = async () => {
    if (!confirmAction) return;
    setActionLoading(true);
    try {
      if (confirmAction.type === 'revoke') {
        await onRevoke(confirmAction.keyId);
      } else {
        await onDelete(confirmAction.keyId);
      }
    } catch {
      // Error handled by parent
    } finally {
      setActionLoading(false);
      setConfirmAction(null);
    }
  };

  return (
    <div className="space-y-6 animate-in-view">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{API_KEY_LABELS.PAGE_TITLE}</h1>
          <p className="text-muted-foreground mt-1">{API_KEY_LABELS.PAGE_DESCRIPTION}</p>
        </div>

        <Dialog open={dialogOpen} onOpenChange={handleDialogChange}>
          <DialogTrigger asChild>
            <Button className="shadow-glow-sm hover:shadow-glow-md">
              <Plus className="mr-2 h-4 w-4" />
              {API_KEY_LABELS.CREATE_KEY}
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            {phase === 'form' ? (
              <>
                <DialogHeader>
                  <DialogTitle>{API_KEY_LABELS.CREATE_KEY}</DialogTitle>
                  <DialogDescription>
                    Create a new API key for programmatic access.
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleCreate} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="key-name">{API_KEY_LABELS.KEY_NAME_LABEL}</Label>
                    <Input
                      id="key-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={API_KEY_LABELS.KEY_NAME_PLACEHOLDER}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>{API_KEY_LABELS.SCOPES_LABEL}</Label>
                    <div className="space-y-2">
                      {AVAILABLE_SCOPES.map((scope) => (
                        <label
                          key={scope.id}
                          className="flex items-center space-x-2 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={selectedScopes.includes(scope.id)}
                            onChange={() => toggleScope(scope.id)}
                            className="rounded border-gray-300"
                          />
                          <span className="text-sm font-medium">{scope.label}</span>
                          <span className="text-xs text-muted-foreground">— {scope.description}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="key-expiry">{API_KEY_LABELS.EXPIRY_LABEL}</Label>
                    <Input
                      id="key-expiry"
                      type="number"
                      min="1"
                      value={expiryDays}
                      onChange={(e) => setExpiryDays(e.target.value)}
                      placeholder={API_KEY_LABELS.EXPIRY_PLACEHOLDER}
                    />
                  </div>

                  {error && (
                    <Alert variant="destructive">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  )}

                  <DialogFooter>
                    <Button type="submit" disabled={creating || !name.trim() || selectedScopes.length === 0}>
                      {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {API_KEY_LABELS.CREATE_KEY}
                    </Button>
                  </DialogFooter>
                </form>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>{API_KEY_LABELS.KEY_CREATED_TITLE}</DialogTitle>
                  <DialogDescription>{API_KEY_LABELS.KEY_CREATED_WARNING}</DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <Alert>
                    <Key className="h-4 w-4" />
                    <AlertDescription className="font-mono text-sm break-all select-all">
                      {createdKey?.key}
                    </AlertDescription>
                  </Alert>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={handleCopy}
                  >
                    {copied ? (
                      <><Check className="mr-2 h-4 w-4 text-green-600" /> Copied</>
                    ) : (
                      <><Copy className="mr-2 h-4 w-4" /> Copy to Clipboard</>
                    )}
                  </Button>
                </div>
                <DialogFooter>
                  <Button onClick={() => handleDialogChange(false)}>Done</Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {/* Confirm action dialog */}
      <Dialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {confirmAction?.type === 'revoke' ? 'Revoke API Key' : 'Delete API Key'}
            </DialogTitle>
            <DialogDescription>
              {confirmAction?.type === 'revoke'
                ? API_KEY_LABELS.CONFIRM_REVOKE
                : API_KEY_LABELS.CONFIRM_DELETE}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAction(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleConfirmAction}
              disabled={actionLoading}
            >
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {confirmAction?.type === 'revoke' ? API_KEY_LABELS.REVOKE_KEY : API_KEY_LABELS.DELETE_KEY}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Key list */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : keys.length === 0 ? (
        <Card className="shadow-card-rest">
          <CardContent className="py-12 text-center">
            <Key className="mx-auto h-10 w-10 text-muted-foreground/50 mb-3" />
            <p className="text-muted-foreground">{API_KEY_LABELS.NO_KEYS}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {keys.map((apiKey, index) => (
            <Card
              key={apiKey.id}
              className={`shadow-card-rest hover:shadow-card-hover transition-all hover:-translate-y-0.5 stagger-${index + 1}`}
            >
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <CardTitle className="text-base">{apiKey.name}</CardTitle>
                    <KeyStatusBadge apiKey={apiKey} />
                  </div>
                  <div className="flex items-center gap-1">
                    {apiKey.is_active && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmAction({ type: 'revoke', keyId: apiKey.id })}
                      >
                        <Ban className="h-4 w-4 mr-1" />
                        {API_KEY_LABELS.REVOKE_KEY}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setConfirmAction({ type: 'delete', keyId: apiKey.id })}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <CardDescription className="font-mono text-xs">
                  {apiKey.key_prefix}••••••••
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <ApiKeyScopeDisplay scopes={apiKey.scopes} />
                  <span>
                    Created {formatDate(apiKey.created_at)}
                  </span>
                  {apiKey.expires_at && (
                    <span>
                      Expires {formatDate(apiKey.expires_at)}
                    </span>
                  )}
                  <span>
                    {apiKey.last_used_at
                      ? `${API_KEY_LABELS.LAST_USED} ${formatDate(apiKey.last_used_at)}`
                      : API_KEY_LABELS.NEVER_USED}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
