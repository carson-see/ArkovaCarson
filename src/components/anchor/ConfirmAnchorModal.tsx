/**
 * Confirm Anchor Modal
 *
 * Shows fingerprint and confirms anchor creation with PENDING status.
 */

import { useState } from 'react';
import { Shield, FileText, Loader2, CheckCircle, Copy, Check } from 'lucide-react';
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
import { formatFingerprint } from '@/lib/fileHasher';
import { supabase } from '@/lib/supabase';
import { validateAnchorCreate } from '@/lib/validators';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';

interface ConfirmAnchorModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: File | null;
  fingerprint: string | null;
  onSuccess?: (anchorId: string) => void;
  onError?: (error: string) => void;
}

export function ConfirmAnchorModal({
  open,
  onOpenChange,
  file,
  fingerprint,
  onSuccess,
  onError,
}: ConfirmAnchorModalProps) {
  const { user } = useAuth();
  const { profile } = useProfile();
  const [isCreating, setIsCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopyFingerprint = async () => {
    if (!fingerprint) return;
    await navigator.clipboard.writeText(fingerprint);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleConfirm = async () => {
    if (!file || !fingerprint || !user) {
      onError?.('Missing required data');
      return;
    }

    setIsCreating(true);

    try {
      // Validate client-side fields via Zod before inserting
      const validated = validateAnchorCreate({
        fingerprint,
        filename: file.name,
        file_size: file.size,
        file_mime: file.type || null,
        org_id: profile?.org_id || null,
      });

      // user_id is required (no column DEFAULT); RLS enforces user_id = auth.uid().
      // status is omitted — column DEFAULT is 'PENDING', and RLS enforces status = 'PENDING' on INSERT.
      const { data, error } = await supabase
        .from('anchors')
        .insert({
          ...validated,
          user_id: user.id,
        })
        .select('id')
        .single();

      if (error) {
        throw error;
      }

      onSuccess?.(data.id);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') {
        const zodErr = err as import('zod').ZodError;
        const message = zodErr.issues.map((i) => i.message).join('; ');
        onError?.(message);
      } else {
        const message = err instanceof Error ? err.message : 'Failed to create anchor';
        onError?.(message);
      }
    } finally {
      setIsCreating(false);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (!file || !fingerprint) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            Confirm Anchor
          </DialogTitle>
          <DialogDescription>
            Review the details and create a permanent record
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* File info */}
          <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 shrink-0">
              <FileText className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{file.name}</p>
              <p className="text-xs text-muted-foreground">
                {formatFileSize(file.size)}
                {file.type && ` • ${file.type}`}
              </p>
            </div>
          </div>

          {/* Fingerprint display */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Document Fingerprint</label>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={handleCopyFingerprint}
              >
                {copied ? (
                  <>
                    <Check className="mr-1 h-3 w-3" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="mr-1 h-3 w-3" />
                    Copy
                  </>
                )}
              </Button>
            </div>
            <div className="p-3 rounded-lg bg-muted font-mono text-xs break-all">
              {fingerprint}
            </div>
            <p className="text-xs text-muted-foreground">
              SHA-256 • {formatFingerprint(fingerprint, 8, 4)}
            </p>
          </div>

          {/* Status notice */}
          <Alert>
            <CheckCircle className="h-4 w-4" />
            <AlertDescription>
              Your anchor will be created with <strong>Pending</strong> status.
              It will be secured once processed by the network.
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter className="flex gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isCreating}
          >
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isCreating}>
            {isCreating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Shield className="mr-2 h-4 w-4" />
                Create Anchor
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
