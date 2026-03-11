/**
 * Secure Document Dialog
 *
 * Modal for securing a new document with step-by-step flow.
 * Uses real Supabase insert (following IssueCredentialForm pattern).
 *
 * @see CRIT-1 — replaced setTimeout simulation with real DB insert
 */

import { useState, useCallback } from 'react';
import { Shield, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FileUpload } from './FileUpload';
import { supabase } from '@/lib/supabase';
import { validateAnchorCreate } from '@/lib/validators';
import { logAuditEvent } from '@/lib/auditLog';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';

interface SecureDocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

type Step = 'upload' | 'confirm' | 'processing' | 'success' | 'error';

interface FileData {
  file: File;
  fingerprint: string;
}

export function SecureDocumentDialog({
  open,
  onOpenChange,
  onSuccess,
}: Readonly<SecureDocumentDialogProps>) {
  const { user } = useAuth();
  const { profile } = useProfile();

  const [step, setStep] = useState<Step>('upload');
  const [fileData, setFileData] = useState<FileData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileSelect = useCallback((file: File, fingerprint: string) => {
    setFileData({ file, fingerprint });
  }, []);

  const handleConfirm = useCallback(async () => {
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
        eventType: 'ANCHOR_CREATED',
        eventCategory: 'ANCHOR',
        targetType: 'anchor',
        targetId: inserted.id,
        orgId: profile?.org_id,
        details: `Secured document "${fileData.file.name}"`,
      });

      setStep('success');
      onSuccess?.();
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        const zodErr = err as import('zod').ZodError;
        setError(zodErr.issues.map((i) => i.message).join('; '));
      } else {
        setError(
          err instanceof Error ? err.message : 'Failed to secure document. Please try again.'
        );
      }
      setStep('error');
    }
  }, [fileData, user, profile, onSuccess]);

  const handleClose = useCallback(() => {
    setStep('upload');
    setFileData(null);
    setError(null);
    onOpenChange(false);
  }, [onOpenChange]);

  const handleRetry = useCallback(() => {
    setStep('upload');
    setFileData(null);
    setError(null);
  }, []);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            Secure Document
          </DialogTitle>
          <DialogDescription>
            Create a permanent, tamper-proof record of your document.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {step === 'upload' && (
            <FileUpload
              onFileSelect={handleFileSelect}
              disabled={false}
            />
          )}

          {step === 'confirm' && fileData && (
            <div className="space-y-4">
              <div className="rounded-lg border p-4">
                <h4 className="text-sm font-medium mb-2">Ready to Secure</h4>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Document</dt>
                    <dd className="font-medium truncate max-w-[200px]">
                      {fileData.file.name}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Size</dt>
                    <dd className="font-medium">
                      {(fileData.file.size / 1024).toFixed(1)} KB
                    </dd>
                  </div>
                </dl>
              </div>
              <Alert>
                <Shield className="h-4 w-4" />
                <AlertDescription>
                  Your document will be secured with cryptographic verification.
                  This creates a permanent record that can be verified at any time.
                </AlertDescription>
              </Alert>
            </div>
          )}

          {step === 'processing' && (
            <div className="space-y-4 text-center py-4">
              <div className="flex justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">Securing your document...</p>
              </div>
            </div>
          )}

          {step === 'success' && (
            <div className="space-y-4 text-center py-4">
              <div className="flex justify-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-success/10">
                  <CheckCircle className="h-8 w-8 text-success" />
                </div>
              </div>
              <div className="space-y-1">
                <h4 className="text-lg font-semibold">Document Secured</h4>
                <p className="text-sm text-muted-foreground">
                  Your document has been permanently secured. You can verify it at any time.
                </p>
              </div>
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
                <h4 className="text-lg font-semibold">Securing Failed</h4>
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
                Cancel
              </Button>
              <Button
                onClick={() => setStep('confirm')}
                disabled={!fileData}
              >
                Continue
              </Button>
            </>
          )}

          {step === 'confirm' && (
            <>
              <Button variant="outline" onClick={() => setStep('upload')}>
                Back
              </Button>
              <Button onClick={handleConfirm}>
                <Shield className="mr-2 h-4 w-4" />
                Secure Document
              </Button>
            </>
          )}

          {step === 'success' && (
            <Button onClick={handleClose} className="w-full">
              Done
            </Button>
          )}

          {step === 'error' && (
            <>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button onClick={handleRetry}>
                Try Again
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
