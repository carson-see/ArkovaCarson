/**
 * Create-account dialog (SCRUM-3061).
 *
 * The email decision is the important one here. Defaulting to "send the link"
 * avoids the silent failure the pre-mortem flagged (F6): an account created
 * with nobody told, which cannot be used and reports no error. When the admin
 * opts out, the worker returns a one-time sign-in link and this dialog holds it
 * on screen with an explicit warning, because nothing else will deliver it.
 *
 * The admin never sets or sees a password — the link lets the recipient choose
 * their own.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Copy } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { workerFetch } from '@/lib/workerClient';
import { ADMIN_PROVISION_USER_LABELS as L } from '@/lib/copy';

type ProfileRole = 'INDIVIDUAL' | 'ORG_ADMIN' | 'ORG_MEMBER';

export interface OrgOption { id: string; display_name: string }

export interface CreateUserDialogProps {
  open: boolean;
  organizations: readonly OrgOption[];
  onClose: () => void;
  onCreated: () => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Maps a worker error code to its user-facing message. */
function messageForCode(code: unknown, fallback: string): string {
  if (code === 'account_exists') return L.ERROR_ACCOUNT_EXISTS;
  if (code === 'role_conflict') return L.ERROR_ROLE_CONFLICT;
  return fallback;
}

export function CreateUserDialog({
  open, organizations, onClose, onCreated,
}: Readonly<CreateUserDialogProps>) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<ProfileRole>('INDIVIDUAL');
  const [orgId, setOrgId] = useState<string>('');
  const [sendEmail, setSendEmail] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activationLink, setActivationLink] = useState<string | null>(null);

  const orgRequired = role !== 'INDIVIDUAL';

  function reset() {
    setEmail(''); setFullName(''); setRole('INDIVIDUAL'); setOrgId('');
    setSendEmail(true); setError(null); setActivationLink(null);
  }

  function handleClose() { reset(); onClose(); }

  async function submit() {
    if (!EMAIL_RE.test(email.trim())) { setError(L.EMAIL_REQUIRED_ERROR); return; }
    if (orgRequired && !orgId) { setError(L.ORG_REQUIRED_ERROR); return; }

    setSubmitting(true);
    setError(null);
    try {
      const res = await workerFetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          full_name: fullName.trim() || undefined,
          role,
          org_id: orgRequired ? orgId : null,
          org_role: role === 'ORG_ADMIN' ? 'owner' : 'member',
          send_invite_email: sendEmail,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(messageForCode(data.code, data.error ?? L.ERROR_GENERIC)); return; }

      onCreated();
      if (data.account?.activation_link) {
        // Hold the dialog open: this link is shown once and nothing else
        // delivers it.
        setActivationLink(data.account.activation_link);
        toast.success(L.SUCCESS_NO_EMAIL(email.trim()));
      } else {
        toast.success(L.SUCCESS_EMAILED(email.trim()));
        handleClose();
      }
    } catch {
      setError(L.ERROR_GENERIC);
    } finally {
      setSubmitting(false);
    }
  }

  async function copyLink() {
    if (!activationLink) return;
    await navigator.clipboard.writeText(activationLink);
    toast.success(L.LINK_COPIED);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{L.DIALOG_TITLE}</DialogTitle>
          <DialogDescription>{L.DIALOG_DESCRIPTION}</DialogDescription>
        </DialogHeader>

        {activationLink ? (
          <div className="space-y-3">
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{L.NO_EMAIL_WARNING}</AlertDescription>
            </Alert>
            <div className="space-y-2">
              <Label htmlFor="activation-link">{L.LINK_LABEL}</Label>
              <div className="flex gap-2">
                <Input id="activation-link" readOnly value={activationLink} />
                <Button type="button" variant="outline" onClick={copyLink} aria-label={L.LINK_COPY}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="user-email">{L.EMAIL_LABEL}</Label>
              <Input
                id="user-email" type="email" value={email} placeholder={L.EMAIL_PLACEHOLDER}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="user-full-name">{L.FULL_NAME_LABEL}</Label>
              <Input id="user-full-name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="user-role">{L.ROLE_LABEL}</Label>
              <Select value={role} onValueChange={(v) => setRole(v as ProfileRole)}>
                <SelectTrigger id="user-role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="INDIVIDUAL">{L.ROLE_INDIVIDUAL}</SelectItem>
                  <SelectItem value="ORG_ADMIN">{L.ROLE_ORG_ADMIN}</SelectItem>
                  <SelectItem value="ORG_MEMBER">{L.ROLE_ORG_MEMBER}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {orgRequired && (
              <div className="space-y-2">
                <Label htmlFor="user-org">{L.ORG_LABEL}</Label>
                <Select value={orgId} onValueChange={setOrgId}>
                  <SelectTrigger id="user-org"><SelectValue placeholder={L.ORG_PLACEHOLDER} /></SelectTrigger>
                  <SelectContent>
                    {organizations.map((o) => (
                      <SelectItem key={o.id} value={o.id}>{o.display_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="user-send-email">{L.SEND_EMAIL_LABEL}</Label>
                <p className="text-xs text-muted-foreground">{L.SEND_EMAIL_HINT}</p>
              </div>
              <Switch id="user-send-email" checked={sendEmail} onCheckedChange={setSendEmail} />
            </div>

            {!sendEmail && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{L.NO_EMAIL_WARNING}</AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
            )}
          </div>
        )}

        <DialogFooter>
          {activationLink ? (
            <Button onClick={handleClose}>{L.CANCEL_BUTTON}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={handleClose} disabled={submitting}>{L.CANCEL_BUTTON}</Button>
              <Button onClick={submit} disabled={submitting}>
                {submitting ? L.SUBMITTING_BUTTON : L.SUBMIT_BUTTON}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
