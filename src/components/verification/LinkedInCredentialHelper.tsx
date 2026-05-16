/**
 * LinkedIn Credential URL Helper (CSI-03 / SCRUM-1599)
 *
 * Provides the Arkova verification URL for use as the Credential URL
 * when adding credentials to LinkedIn profiles.
 *
 * Per CSI-03 AC: uses Arkova verification URL, does NOT claim native
 * LinkedIn verification checkmark.
 */

import { useState, useCallback } from 'react';
import { Copy, Check, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { LINKEDIN_SHARE_LABELS } from '@/lib/copy';
import { linkedInCredentialUrl } from '@/lib/sourceProvenance';

interface LinkedInCredentialHelperProps {
  publicId: string;
  className?: string;
}

export function LinkedInCredentialHelper({
  publicId,
  className,
}: Readonly<LinkedInCredentialHelperProps>) {
  const [copied, setCopied] = useState(false);
  const credentialUrl = linkedInCredentialUrl(publicId);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(credentialUrl);
    setCopied(true);
    toast.success(LINKEDIN_SHARE_LABELS.URL_COPIED);
    setTimeout(() => setCopied(false), 2000);
  }, [credentialUrl]);

  return (
    <div className={`space-y-2 ${className ?? ''}`} data-testid="linkedin-credential-helper">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {LINKEDIN_SHARE_LABELS.CREDENTIAL_URL_LABEL}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <code className="flex-1 rounded border bg-muted/50 px-3 py-1.5 font-mono text-xs break-all select-all">
          {credentialUrl}
        </code>
        <Button
          variant="outline"
          size="sm"
          onClick={handleCopy}
          aria-label={LINKEDIN_SHARE_LABELS.COPY_URL}
          className="shrink-0"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Info className="h-3 w-3 mt-0.5 shrink-0" />
        <span>{LINKEDIN_SHARE_LABELS.NOTE}</span>
      </p>

      <p className="text-xs text-muted-foreground">
        {LINKEDIN_SHARE_LABELS.CREDENTIAL_URL_HELP}
      </p>
    </div>
  );
}
