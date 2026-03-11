/**
 * Issue Credential Form
 *
 * Dialog for ORG_ADMIN users to issue credentials with
 * credential_type, label, and metadata. Reuses FileUpload
 * for document fingerprinting.
 *
 * @see P5-TS-05
 */

import { useState, useCallback } from 'react';
import { Shield, Loader2, Award } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FileUpload } from '@/components/anchor/FileUpload';
import { supabase } from '@/lib/supabase';
import { validateAnchorCreate, CREDENTIAL_TYPES } from '@/lib/validators';
import { logAuditEvent } from '@/lib/auditLog';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import {
  FORM_LABELS,
  CREDENTIAL_TYPE_LABELS,
} from '@/lib/copy';
import type { CredentialType } from '@/lib/validators';

interface IssueCredentialFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function IssueCredentialForm({
  open,
  onOpenChange,
  onSuccess,
}: Readonly<IssueCredentialFormProps>) {
  const { user } = useAuth();
  const { profile } = useProfile();

  const [file, setFile] = useState<File | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [credentialType, setCredentialType] = useState<CredentialType | ''>('');
  const [label, setLabel] = useState('');
  const [issuedAt, setIssuedAt] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileSelect = useCallback((f: File, fp: string) => {
    setFile(f);
    setFingerprint(fp);
    setError(null);
  }, []);

  const resetForm = useCallback(() => {
    setFile(null);
    setFingerprint(null);
    setCredentialType('');
    setLabel('');
    setIssuedAt('');
    setCreating(false);
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    if (!creating) {
      resetForm();
      onOpenChange(false);
    }
  }, [creating, resetForm, onOpenChange]);

  const handleSubmit = useCallback(async () => {
    if (!file || !fingerprint || !user || !credentialType) return;

    setCreating(true);
    setError(null);

    try {
      const validated = validateAnchorCreate({
        fingerprint,
        filename: file.name,
        file_size: file.size,
        file_mime: file.type || null,
        org_id: profile?.org_id || null,
        credential_type: credentialType,
        label: label.trim() || null,
        metadata: issuedAt
          ? { issued_at: `${issuedAt}T00:00:00Z` }
          : null,
      });

      const { data: inserted, error: insertError } = await supabase
        .from('anchors')
        .insert({
          ...validated,
          user_id: user.id,
        })
        .select('id')
        .single();

      if (insertError) throw insertError;

      logAuditEvent({
        eventType: 'CREDENTIAL_ISSUED',
        eventCategory: 'ANCHOR',
        targetType: 'anchor',
        targetId: inserted.id,
        orgId: profile?.org_id,
        details: `Issued ${credentialType} credential for "${file.name}"`,
      });

      resetForm();
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        const zodErr = err as import('zod').ZodError;
        setError(zodErr.issues.map((i) => i.message).join('; '));
      } else {
        setError(
          err instanceof Error ? err.message : 'Failed to issue credential'
        );
      }
    } finally {
      setCreating(false);
    }
  }, [
    file,
    fingerprint,
    user,
    profile,
    credentialType,
    label,
    issuedAt,
    resetForm,
    onOpenChange,
    onSuccess,
  ]);

  const canSubmit = !!file && !!fingerprint && !!credentialType && !creating;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Award className="h-5 w-5 text-primary" />
            Issue Credential
          </DialogTitle>
          <DialogDescription>
            Create a verifiable credential record for your organization.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* File upload */}
          <FileUpload onFileSelect={handleFileSelect} disabled={creating} />

          {/* Credential type */}
          <div className="space-y-2">
            <Label htmlFor="credential-type">
              {FORM_LABELS.CREDENTIAL_TYPE}
            </Label>
            <Select
              value={credentialType}
              onValueChange={(v) => setCredentialType(v as CredentialType)}
              disabled={creating}
            >
              <SelectTrigger id="credential-type">
                <SelectValue
                  placeholder={FORM_LABELS.CREDENTIAL_TYPE_PLACEHOLDER}
                />
              </SelectTrigger>
              <SelectContent>
                {CREDENTIAL_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {CREDENTIAL_TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Label */}
          <div className="space-y-2">
            <Label htmlFor="credential-label">{FORM_LABELS.LABEL}</Label>
            <Input
              id="credential-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={FORM_LABELS.LABEL_PLACEHOLDER}
              disabled={creating}
              maxLength={500}
            />
          </div>

          {/* Issued date (optional) */}
          <div className="space-y-2">
            <Label htmlFor="issued-at">{FORM_LABELS.ISSUED_AT}</Label>
            <Input
              id="issued-at"
              type="date"
              value={issuedAt}
              onChange={(e) => setIssuedAt(e.target.value)}
              disabled={creating}
            />
          </div>

          {/* Status notice */}
          {file && fingerprint && (
            <Alert>
              <Shield className="h-4 w-4" />
              <AlertDescription>
                The credential will be created with <strong>Pending</strong>{' '}
                status and assigned a unique verification ID immediately.
              </AlertDescription>
            </Alert>
          )}

          {/* Error display */}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={creating}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {creating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Issuing...
              </>
            ) : (
              <>
                <Award className="mr-2 h-4 w-4" />
                Issue Credential
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
