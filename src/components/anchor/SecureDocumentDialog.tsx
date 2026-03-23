/**
 * Secure Document Dialog
 *
 * Anchor-first architecture: Upload → Secure → Done.
 * Clicking "Secure" immediately creates the anchor (PENDING),
 * shows success screen with verification URL.
 * AI extraction runs async in the background via useBackgroundExtraction.
 *
 * No intermediate steps (no template selection, no confirm screen).
 *
 * @see CRIT-1, UF-04, P8-S5
 */

import { useState, useCallback } from 'react';
import {
  Shield,
  CheckCircle,
  AlertCircle,
  Loader2,
  Copy,
  Check,
  ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FileUpload, type AttestationUpload } from './FileUpload';
import { BulkUploadWizard } from '@/components/upload';
import { WORKER_URL } from '@/lib/workerClient';
import { supabase } from '@/lib/supabase';
import { validateAnchorCreate } from '@/lib/validators';
import { logAuditEvent } from '@/lib/auditLog';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useBackgroundExtraction } from '@/hooks/useBackgroundExtraction';
import { toast } from 'sonner';
import { TOAST, ANCHORING_STATUS_LABELS, SECURE_DIALOG_LABELS } from '@/lib/copy';
import { verifyUrl, recordDetailPath } from '@/lib/routes';
import { useNavigate } from 'react-router-dom';

interface SecureDocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

type Step = 'upload' | 'processing' | 'success' | 'error' | 'bulk' | 'attestation-review' | 'attestation-submitting';

interface FileData {
  file: File;
  fingerprint: string;
}

interface CreatedAnchor {
  id: string;
  publicId: string;
}

export function SecureDocumentDialog({
  open,
  onOpenChange,
  onSuccess,
}: Readonly<SecureDocumentDialogProps>) {
  const { user } = useAuth();
  const { profile } = useProfile();
  const navigate = useNavigate();
  const { runInBackground } = useBackgroundExtraction();

  const [step, setStep] = useState<Step>('upload');
  const [fileData, setFileData] = useState<FileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createdAnchor, setCreatedAnchor] = useState<CreatedAnchor | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string>('');

  // Attestation upload state
  const [attestationData, setAttestationData] = useState<AttestationUpload | null>(null);

  const handleFileSelect = useCallback((file: File, fingerprint: string) => {
    setFileData({ file, fingerprint });
  }, []);

  const handleBulkDetected = useCallback((_files: File[]) => {
    setStep('bulk');
  }, []);

  const handleAttestationDetected = useCallback((data: AttestationUpload) => {
    setAttestationData(data);
    setStep('attestation-review');
  }, []);

  const handleAttestationSubmit = useCallback(async () => {
    if (!attestationData || !user) return;
    setStep('attestation-submitting');
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setError('Authentication required'); setStep('error'); return; }

      const workerUrl = import.meta.env.VITE_WORKER_URL ?? WORKER_URL;
      const response = await fetch(`${workerUrl}/api/v1/attestations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          attestation_type: attestationData.attestation_type,
          attester_name: attestationData.attester_name,
          attester_type: attestationData.attester_type,
          attester_title: attestationData.attester_title || undefined,
          subject_type: attestationData.subject_type,
          subject_identifier: attestationData.subject_identifier,
          claims: attestationData.claims.filter(c => c.claim.trim()),
          summary: attestationData.summary || undefined,
          jurisdiction: attestationData.jurisdiction || undefined,
          expires_at: attestationData.expires_at || undefined,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Failed to create attestation' }));
        setError(err.error || 'Failed to create attestation');
        setStep('error');
        return;
      }

      const result = await response.json();
      setCreatedAnchor({ id: result.attestation_id, publicId: result.public_id });
      toast.success('Attestation created successfully');
      setStep('success');
      onSuccess?.();
    } catch {
      setError('Network error — please try again');
      setStep('error');
    }
  }, [attestationData, user, onSuccess]);

  // Anchor-first: immediately create anchor, then run AI extraction in background
  const handleSecure = useCallback(async () => {
    if (!fileData || !user) return;

    setStep('processing');
    setError(null);

    try {
      const validated = validateAnchorCreate({
        fingerprint: fileData.fingerprint,
        filename: fileData.file.name,
        file_size: fileData.file.size,
        file_mime: fileData.file.type || null,
        org_id: profile?.org_id || null,
        ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}),
      });

      const { data: inserted, error: insertError } = await supabase
        .from('anchors')
        .insert({
          ...validated,
          user_id: user.id,
        })
        .select('id, public_id')
        .single();

      if (insertError) throw insertError;

      const anchor: CreatedAnchor = {
        id: inserted.id,
        publicId: inserted.public_id!,
      };
      setCreatedAnchor(anchor);

      logAuditEvent({
        eventType: 'ANCHOR_CREATED',
        eventCategory: 'ANCHOR',
        targetType: 'anchor',
        targetId: inserted.id,
        orgId: profile?.org_id,
        details: `Secured document "${fileData.file.name}"`,
      });

      toast.success(TOAST.ANCHOR_SUBMITTED);
      setStep('success');
      onSuccess?.();

      // Fire-and-forget: background AI extraction updates metadata async
      runInBackground({
        anchorId: anchor.id,
        file: fileData.file,
        fingerprint: fileData.fingerprint,
        userId: user.id,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        const zodErr = err as import('zod').ZodError;
        setError(zodErr.issues.map((i) => i.message).join('; '));
      } else {
        setError(
          err instanceof Error ? err.message : 'Failed to secure document. Please try again.'
        );
      }
      toast.error(TOAST.ANCHOR_FAILED);
      setStep('error');
    }
  }, [fileData, user, profile, expiresAt, onSuccess, runInBackground]);

  const handleClose = useCallback(() => {
    setStep('upload');
    setFileData(null);
    setError(null);
    setCreatedAnchor(null);
    setLinkCopied(false);
    setExpiresAt('');
    setAttestationData(null);
    onOpenChange(false);
  }, [onOpenChange]);

  const handleRetry = useCallback(() => {
    setStep('upload');
    setFileData(null);
    setError(null);
    setCreatedAnchor(null);
    setExpiresAt('');
  }, []);

  const handleCopyLink = useCallback(async () => {
    if (!createdAnchor) return;
    const url = verifyUrl(createdAnchor.publicId);
    await navigator.clipboard.writeText(url);
    setLinkCopied(true);
    toast.success(ANCHORING_STATUS_LABELS.LINK_COPIED);
    setTimeout(() => setLinkCopied(false), 2000);
  }, [createdAnchor]);

  const handleViewRecord = useCallback(() => {
    if (!createdAnchor) return;
    handleClose();
    navigate(recordDetailPath(createdAnchor.id));
  }, [createdAnchor, handleClose, navigate]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className={step === 'bulk' ? 'max-w-3xl max-h-[90vh] overflow-y-auto' : 'sm:max-w-lg max-h-[90vh] overflow-y-auto'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            {step === 'bulk' ? 'Bulk Upload' : SECURE_DIALOG_LABELS.TITLE}
          </DialogTitle>
          <DialogDescription>
            {step === 'bulk'
              ? 'Upload a CSV or XLSX file to secure multiple documents at once'
              : SECURE_DIALOG_LABELS.DESCRIPTION}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {step === 'upload' && (
            <div className="space-y-4">
              <FileUpload
                onFileSelect={handleFileSelect}
                onBulkDetected={handleBulkDetected}
                onAttestationDetected={handleAttestationDetected}
                disabled={false}
              />
              {fileData && (
                <div className="space-y-2">
                  <Label htmlFor="expires-at" className="text-sm">
                    Expiration Date <span className="text-muted-foreground font-normal">(optional)</span>
                  </Label>
                  <Input
                    id="expires-at"
                    type="date"
                    value={expiresAt}
                    min={new Date().toISOString().split('T')[0]}
                    onChange={(e) => setExpiresAt(e.target.value)}
                    className="w-full"
                  />
                  <p className="text-xs text-muted-foreground">
                    Set an expiration date to receive a reminder when this credential expires.
                  </p>
                </div>
              )}
            </div>
          )}

          {step === 'attestation-review' && attestationData && (
            <div className="space-y-4">
              <div className="rounded-lg border border-[#00d4ff]/20 bg-[#00d4ff]/5 px-4 py-3">
                <p className="text-sm font-medium flex items-center gap-2">
                  <Shield className="h-4 w-4 text-[#00d4ff]" />
                  Attestation detected
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  This file contains an attestation that will be anchored to the network.
                </p>
              </div>
              <div className="rounded-lg border p-4 space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Type</span>
                  <span className="font-medium">{attestationData.attestation_type.replace(/_/g, ' ')}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Subject</span>
                  <span className="font-medium truncate max-w-[250px]">{attestationData.subject_identifier}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Attester</span>
                  <span className="font-medium">{attestationData.attester_name}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Claims</span>
                  <span className="font-medium">{attestationData.claims.length}</span>
                </div>
                {attestationData.jurisdiction && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Jurisdiction</span>
                    <span className="font-medium">{attestationData.jurisdiction}</span>
                  </div>
                )}
                {attestationData.summary && (
                  <div className="border-t pt-2 mt-2">
                    <p className="text-xs text-muted-foreground">{attestationData.summary}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 'attestation-submitting' && (
            <div className="flex flex-col items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
              <p className="text-sm text-muted-foreground">Creating attestation and anchoring to network...</p>
            </div>
          )}

          {step === 'bulk' && (
            <BulkUploadWizard
              onComplete={() => {
                handleClose();
                onSuccess?.();
              }}
              onCancel={() => {
                setStep('upload');
              }}
            />
          )}

          {step === 'processing' && (
            <div className="space-y-4 text-center py-4">
              <div className="flex justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">{SECURE_DIALOG_LABELS.SECURING_LOADING}</p>
              </div>
            </div>
          )}

          {step === 'success' && (
            <div className="space-y-4 py-4">
              <div className="flex flex-col items-center text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10 mb-3">
                  <CheckCircle className="h-8 w-8 text-green-500" />
                </div>
                <h4 className="text-lg font-semibold">
                  {ANCHORING_STATUS_LABELS.SUCCESS_TITLE}
                </h4>
                <p className="text-sm text-muted-foreground mt-1">
                  {ANCHORING_STATUS_LABELS.SUCCESS_PROCESSING}
                </p>
              </div>

              {/* Verification link */}
              {createdAnchor && (
                <div className="rounded-lg border bg-muted/50 p-3 space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {SECURE_DIALOG_LABELS.VERIFICATION_LINK}
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono truncate">
                      {verifyUrl(createdAnchor.publicId)}
                    </code>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 shrink-0"
                      onClick={handleCopyLink}
                      aria-label={SECURE_DIALOG_LABELS.COPY_LINK_ARIA}
                    >
                      {linkCopied ? (
                        <Check className="h-3.5 w-3.5 text-green-500" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {ANCHORING_STATUS_LABELS.SHARE_LINK_NOTE}
                  </p>
                </div>
              )}
            </div>
          )}

          {step === 'error' && (
            <div className="space-y-4 text-center py-4">
              <div className="flex justify-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
                  <AlertCircle className="h-8 w-8 text-destructive" />
                </div>
              </div>
              <div className="space-y-1">
                <h4 className="text-lg font-semibold">{SECURE_DIALOG_LABELS.SECURING_FAILED}</h4>
                <p className="text-sm text-muted-foreground">
                  {error || 'An unexpected error occurred. Please try again.'}
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          {step === 'upload' && (
            <>
              <Button variant="outline" onClick={handleClose}>
                {SECURE_DIALOG_LABELS.CANCEL}
              </Button>
              <Button
                onClick={handleSecure}
                disabled={!fileData}
              >
                <Shield className="mr-2 h-4 w-4" />
                {SECURE_DIALOG_LABELS.SECURE_BUTTON}
              </Button>
            </>
          )}

          {step === 'success' && (
            <div className="flex w-full gap-2">
              <Button
                variant="outline"
                onClick={handleCopyLink}
                className="flex-1"
              >
                {linkCopied ? (
                  <Check className="mr-2 h-4 w-4" />
                ) : (
                  <Copy className="mr-2 h-4 w-4" />
                )}
                {ANCHORING_STATUS_LABELS.COPY_LINK}
              </Button>
              {createdAnchor && (
                <Button
                  variant="outline"
                  onClick={handleViewRecord}
                  className="flex-1"
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  {ANCHORING_STATUS_LABELS.VIEW_RECORD}
                </Button>
              )}
              <Button onClick={handleClose}>
                {ANCHORING_STATUS_LABELS.DONE}
              </Button>
            </div>
          )}

          {step === 'error' && (
            <>
              <Button variant="outline" onClick={handleClose}>
                {SECURE_DIALOG_LABELS.CANCEL}
              </Button>
              <Button onClick={handleRetry}>
                {SECURE_DIALOG_LABELS.TRY_AGAIN}
              </Button>
            </>
          )}
          {step === 'attestation-review' && (
            <>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button onClick={handleAttestationSubmit}>
                <Shield className="mr-2 h-4 w-4" />
                Create Attestation
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
