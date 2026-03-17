/**
 * Share Sheet Component
 *
 * Modal for sharing a credential's verification link.
 * Includes: copy link, QR code, email share.
 *
 * @see UF-08
 */

import { useState, useCallback } from 'react';
import { Copy, Check, Mail, QrCode } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { verifyUrl } from '@/lib/routes';
import { SHARE_LABELS } from '@/lib/copy';

interface ShareSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  publicId: string;
  filename?: string;
}

export function ShareSheet({ open, onOpenChange, publicId, filename }: Readonly<ShareSheetProps>) {
  const [linkCopied, setLinkCopied] = useState(false);
  const verificationUrl = verifyUrl(publicId);

  const handleCopyLink = useCallback(async () => {
    await navigator.clipboard.writeText(verificationUrl);
    setLinkCopied(true);
    toast.success(SHARE_LABELS.LINK_COPIED);
    setTimeout(() => setLinkCopied(false), 2000);
  }, [verificationUrl]);

  const handleEmailShare = useCallback(() => {
    const subject = encodeURIComponent(SHARE_LABELS.EMAIL_SUBJECT);
    const body = encodeURIComponent(
      `Verify this credential on Arkova:\n\n${verificationUrl}`
    );
    window.open(`mailto:?subject=${subject}&body=${body}`, '_self');
  }, [verificationUrl]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="h-5 w-5 text-primary" />
            {SHARE_LABELS.SHARE_TITLE}
          </DialogTitle>
          <DialogDescription>
            {filename
              ? `${SHARE_LABELS.SHARE_DESCRIPTION} (${filename})`
              : SHARE_LABELS.SHARE_DESCRIPTION}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Verification URL */}
          <div className="rounded-lg border bg-muted/50 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono truncate">
                {verificationUrl}
              </code>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 shrink-0"
                onClick={handleCopyLink}
              >
                {linkCopied ? (
                  <Check className="h-3.5 w-3.5 text-green-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </div>

          {/* Copy Link Button */}
          <Button onClick={handleCopyLink} className="w-full" variant="outline">
            {linkCopied ? (
              <Check className="mr-2 h-4 w-4" />
            ) : (
              <Copy className="mr-2 h-4 w-4" />
            )}
            {SHARE_LABELS.COPY_LINK}
          </Button>

          <Separator />

          {/* QR Code */}
          <div className="flex flex-col items-center gap-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {SHARE_LABELS.QR_CODE}
            </p>
            <div className="rounded-lg border bg-white p-4">
              <QRCodeSVG
                value={verificationUrl}
                size={160}
                level="M"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {SHARE_LABELS.QR_DESCRIPTION}
            </p>
          </div>

          <Separator />

          {/* Email Share */}
          <Button onClick={handleEmailShare} className="w-full" variant="outline">
            <Mail className="mr-2 h-4 w-4" />
            {SHARE_LABELS.EMAIL_SHARE}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
