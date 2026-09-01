/**
 * Create-organization dialog (SCRUM-3061).
 *
 * Closes the platform-admin gap found while provisioning PlanBook by hand: the
 * console could set an existing org's allowance and credits but could not
 * create the org itself.
 *
 * Two behaviours are deliberate and load-bearing:
 *  - The submit button is disabled while a request is in flight. There is no
 *    unique constraint on `organizations.display_name` (a DB constraint would
 *    be wrong — two real companies can share a name), so the double-submit
 *    guard is the client-side disable plus the server's 409.
 *  - A 409 does not discard the form. It surfaces an explicit
 *    "create it anyway" confirmation that re-sends with allow_duplicate_name.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { workerFetch } from '@/lib/workerClient';
import { ADMIN_PROVISION_ORG_LABELS as L } from '@/lib/copy';

export interface CreateOrganizationDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateOrganizationDialog({
  open, onClose, onCreated,
}: Readonly<CreateOrganizationDialogProps>) {
  const [displayName, setDisplayName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [capEnabled, setCapEnabled] = useState(true);
  const [quota, setQuota] = useState('10');
  const [credits, setCredits] = useState('0');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState(false);

  function reset() {
    setDisplayName(''); setLegalName(''); setCapEnabled(true);
    setQuota('10'); setCredits('0'); setError(null); setDuplicateWarning(false);
  }

  function handleClose() { reset(); onClose(); }

  function validate(): { anchor_quota: number | null; credits: number } | null {
    if (displayName.trim().length === 0) { setError(L.NAME_REQUIRED_ERROR); return null; }
    let anchorQuota: number | null = null;
    if (capEnabled) {
      const n = Number(quota);
      if (!Number.isInteger(n) || n < 0) { setError(L.QUOTA_INVALID_ERROR); return null; }
      anchorQuota = n;
    }
    const c = Number(credits);
    if (!Number.isInteger(c) || c < 0) { setError(L.CREDITS_INVALID_ERROR); return null; }
    return { anchor_quota: anchorQuota, credits: c };
  }

  async function submit(allowDuplicateName: boolean) {
    const parsed = validate();
    if (!parsed) return;

    setSubmitting(true);
    setError(null);
    try {
      const res = await workerFetch('/api/admin/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: displayName.trim(),
          legal_name: legalName.trim() || undefined,
          anchor_quota: parsed.anchor_quota,
          credits: parsed.credits,
          is_test: capEnabled,
          allow_duplicate_name: allowDuplicateName,
        }),
      });
      const data = await res.json();

      if (res.status === 409 && data.code === 'org_exists' && !allowDuplicateName) {
        setDuplicateWarning(true);
        return;
      }
      if (!res.ok) { setError(data.error ?? L.ERROR_GENERIC); return; }

      toast.success(L.SUCCESS(displayName.trim()));
      reset();
      onCreated();
      onClose();
    } catch {
      setError(L.ERROR_GENERIC);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{L.DIALOG_TITLE}</DialogTitle>
          <DialogDescription>{L.DIALOG_DESCRIPTION}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="org-name">{L.NAME_LABEL}</Label>
            <Input
              id="org-name" value={displayName} placeholder={L.NAME_PLACEHOLDER}
              onChange={(e) => { setDisplayName(e.target.value); setDuplicateWarning(false); }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="org-legal-name">{L.LEGAL_NAME_LABEL}</Label>
            <Input id="org-legal-name" value={legalName} onChange={(e) => setLegalName(e.target.value)} />
            <p className="text-xs text-muted-foreground">{L.LEGAL_NAME_HINT}</p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="org-cap">{L.CAP_TOGGLE_LABEL}</Label>
              <p className="text-xs text-muted-foreground">{L.CAP_TOGGLE_HINT}</p>
            </div>
            <Switch id="org-cap" checked={capEnabled} onCheckedChange={setCapEnabled} />
          </div>

          {capEnabled && (
            <div className="space-y-2">
              <Label htmlFor="org-quota">{L.QUOTA_LABEL}</Label>
              <Input id="org-quota" type="number" min={0} value={quota} onChange={(e) => setQuota(e.target.value)} />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="org-credits">{L.CREDITS_LABEL}</Label>
            <Input id="org-credits" type="number" min={0} value={credits} onChange={(e) => setCredits(e.target.value)} />
          </div>

          {duplicateWarning && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{L.DUPLICATE_TITLE}</AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={submitting}>{L.CANCEL_BUTTON}</Button>
          <Button onClick={() => submit(duplicateWarning)} disabled={submitting}>
            {(() => {
              if (submitting) return L.SUBMITTING_BUTTON;
              return duplicateWarning ? L.DUPLICATE_CONFIRM : L.SUBMIT_BUTTON;
            })()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
