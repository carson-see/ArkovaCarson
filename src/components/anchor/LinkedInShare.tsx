/**
 * BETA-09: LinkedIn Verification Badge
 *
 * Components for sharing credentials on LinkedIn:
 * - LinkedInShareButton: Opens LinkedIn share-offsite URL
 * - LinkedInBadgeSnippet: Generates embeddable HTML badge for LinkedIn "Featured"
 */

import { useState, useCallback } from 'react';
import { Linkedin, Copy, Check, Code } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { verifyUrl } from '@/lib/routes';
import { LINKEDIN_LABELS } from '@/lib/copy';

interface LinkedInShareButtonProps {
  publicId: string;
  credentialType?: string;
}

export function LinkedInShareButton({
  publicId,
  credentialType,
}: Readonly<LinkedInShareButtonProps>) {
  const url = verifyUrl(publicId);
  const shareText = credentialType
    ? LINKEDIN_LABELS.SHARE_TEXT_WITH_TYPE.replace('{type}', credentialType)
    : LINKEDIN_LABELS.SHARE_TEXT_DEFAULT;

  const handleShare = useCallback(() => {
    const linkedInUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}&summary=${encodeURIComponent(shareText)}`;
    window.open(linkedInUrl, '_blank', 'noopener,noreferrer');
  }, [url, shareText]);

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleShare}
      aria-label={LINKEDIN_LABELS.SHARE_BUTTON}
    >
      <Linkedin className="mr-2 h-4 w-4" />
      {LINKEDIN_LABELS.SHARE_BUTTON}
    </Button>
  );
}

interface LinkedInBadgeSnippetProps {
  publicId: string;
  status: string;
}

export function LinkedInBadgeSnippet({
  publicId,
  status,
}: Readonly<LinkedInBadgeSnippetProps>) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const url = verifyUrl(publicId);
  const badgeColor = status === 'SECURED' ? '4ade80' : 'ef4444';
  const badgeLabel = status === 'SECURED' ? 'Verified' : 'Revoked';
  const badgeImageUrl = `https://img.shields.io/badge/Arkova-${badgeLabel}-${badgeColor}?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMTIgMkw0IDdWMTdMMTIgMjJMMjAgMTdWN0wxMiAyWiIgZmlsbD0id2hpdGUiLz48L3N2Zz4=`;

  const snippet = `<a href="${url}" target="_blank" rel="noopener noreferrer"><img src="${badgeImageUrl}" alt="Verified by Arkova" /></a>`;

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    toast.success(LINKEDIN_LABELS.SNIPPET_COPIED);
    setTimeout(() => setCopied(false), 2000);
  }, [snippet]);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={LINKEDIN_LABELS.GET_BADGE}
      >
        <Code className="mr-2 h-4 w-4" />
        {LINKEDIN_LABELS.GET_BADGE}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{LINKEDIN_LABELS.BADGE_TITLE}</DialogTitle>
            <DialogDescription>
              {LINKEDIN_LABELS.BADGE_DESCRIPTION}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="flex justify-center py-3">
              <img src={badgeImageUrl} alt="Verified by Arkova" />
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {LINKEDIN_LABELS.EMBED_CODE}
              </p>
              <code
                role="code"
                className="block rounded-lg border bg-muted/50 p-3 font-mono text-xs break-all select-all"
              >
                {snippet}
              </code>
            </div>

            <Button
              onClick={handleCopy}
              className="w-full"
              variant="outline"
              aria-label={LINKEDIN_LABELS.COPY_SNIPPET}
            >
              {copied ? (
                <Check className="mr-2 h-4 w-4 text-green-500" />
              ) : (
                <Copy className="mr-2 h-4 w-4" />
              )}
              {LINKEDIN_LABELS.COPY_SNIPPET}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
