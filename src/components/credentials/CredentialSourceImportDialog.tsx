import { FormEvent, useMemo, useState } from 'react';
import { CheckCircle2, ExternalLink, Link2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { workerFetch } from '@/lib/workerClient';
import { CREDENTIAL_TYPE_LABELS, formatCredentialType } from '@/lib/copy';

const IMPORT_CREDENTIAL_TYPES = [
  'BADGE',
  'CERTIFICATE',
  'LICENSE',
  'DEGREE',
  'TRANSCRIPT',
  'PROFESSIONAL',
  'ACCREDITATION',
  'ATTESTATION',
  'FINANCIAL_ADVISOR',
  'BUSINESS_ENTITY',
  'OTHER',
] as const;

type ImportCredentialType = (typeof IMPORT_CREDENTIAL_TYPES)[number];

interface CredentialSourcePreview {
  normalized_source_url: string;
  source_provider: string;
  source_payload_hash: string;
  source_payload_content_type: string;
  source_payload_byte_length: number;
  credential_type: string;
  credential_title: string;
  credential_issuer: string | null;
  credential_issued_at: string | null;
  verification_level: string;
  extraction_method: string;
  extraction_confidence: number;
  evidence_package_hash: string;
}

interface CredentialSourceConfirmResponse {
  duplicate: boolean;
  anchor: {
    public_id: string;
    record_uri: string;
  };
  preview: CredentialSourcePreview;
}

interface CredentialSourceImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void | Promise<void>;
}

async function parseWorkerResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (body as { message?: string; error?: string }).message
      ?? (body as { error?: string }).error
      ?? `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

function compactHash(value: string): string {
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

export function CredentialSourceImportDialog({
  open,
  onOpenChange,
  onImported,
}: Readonly<CredentialSourceImportDialogProps>) {
  const [sourceUrl, setSourceUrl] = useState('');
  const [credentialType, setCredentialType] = useState<ImportCredentialType>('OTHER');
  const [issuerHint, setIssuerHint] = useState('');
  const [preview, setPreview] = useState<CredentialSourcePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetState = () => {
    setSourceUrl('');
    setCredentialType('OTHER');
    setIssuerHint('');
    setPreview(null);
    setError(null);
    setLoadingPreview(false);
    setConfirming(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) resetState();
    onOpenChange(nextOpen);
  };

  const canPreview = sourceUrl.trim().length > 0 && !loadingPreview && !confirming;
  const canConfirm = !!preview && !loadingPreview && !confirming;
  const sourceHost = useMemo(() => {
    if (!preview) return null;
    try {
      return new URL(preview.normalized_source_url).hostname;
    } catch {
      return preview.normalized_source_url;
    }
  }, [preview]);

  const requestBody = (expectedSourcePayloadHash?: string) => JSON.stringify({
    source_url: sourceUrl.trim(),
    credential_type: credentialType,
    issuer_hint: issuerHint.trim() || undefined,
    expected_source_payload_hash: expectedSourcePayloadHash,
  });

  const handlePreview = async (event: FormEvent) => {
    event.preventDefault();
    setLoadingPreview(true);
    setError(null);
    setPreview(null);

    try {
      const response = await workerFetch('/api/v1/credential-sources/import-url/preview', {
        method: 'POST',
        body: requestBody(),
      });
      setPreview(await parseWorkerResponse<CredentialSourcePreview>(response));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleConfirm = async () => {
    if (!preview) return;
    setConfirming(true);
    setError(null);

    try {
      const response = await workerFetch('/api/v1/credential-sources/import-url/confirm', {
        method: 'POST',
        body: requestBody(preview.source_payload_hash),
      });
      const result = await parseWorkerResponse<CredentialSourceConfirmResponse>(response);
      toast.success(result.duplicate ? 'Credential source already added' : 'Credential source added');
      await onImported?.();
      handleOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setConfirming(false);
    }
  };

  const resetPreview = () => {
    setPreview(null);
    setError(null);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5 text-primary" />
            Add Credential Source
          </DialogTitle>
          <DialogDescription>Import a public credential source URL.</DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handlePreview}>
          <div className="space-y-2">
            <Label htmlFor="credential-source-url">Credential source URL</Label>
            <Input
              id="credential-source-url"
              type="url"
              value={sourceUrl}
              onChange={(event) => {
                setSourceUrl(event.target.value);
                resetPreview();
              }}
              placeholder="https://"
              disabled={loadingPreview || confirming}
              required
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-[1fr_1fr]">
            <div className="space-y-2">
              <Label>Credential type</Label>
              <Select
                value={credentialType}
                onValueChange={(value) => {
                  setCredentialType(value as ImportCredentialType);
                  resetPreview();
                }}
                disabled={loadingPreview || confirming}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {IMPORT_CREDENTIAL_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {CREDENTIAL_TYPE_LABELS[type as keyof typeof CREDENTIAL_TYPE_LABELS] ?? formatCredentialType(type)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="credential-source-issuer">Issuer</Label>
              <Input
                id="credential-source-issuer"
                value={issuerHint}
                onChange={(event) => {
                  setIssuerHint(event.target.value);
                  resetPreview();
                }}
                disabled={loadingPreview || confirming}
              />
            </div>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {preview && (
            <div className="rounded-md border bg-muted/20 p-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{preview.credential_title}</p>
                  <p className="text-sm text-muted-foreground">
                    {preview.credential_issuer ?? sourceHost}
                  </p>
                </div>
                <Badge variant="secondary" className="shrink-0">
                  {formatCredentialType(preview.credential_type)}
                </Badge>
              </div>

              <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Issued</dt>
                <dd>{preview.credential_issued_at ?? 'Not detected'}</dd>
                <dt className="text-muted-foreground">Source</dt>
                <dd className="min-w-0">
                  <a
                    href={preview.normalized_source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex max-w-full items-center gap-1 text-primary hover:underline"
                  >
                    <span className="truncate">{sourceHost}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                </dd>
                <dt className="text-muted-foreground">Confidence</dt>
                <dd>{Math.round(preview.extraction_confidence * 100)}%</dd>
                <dt className="text-muted-foreground">Evidence</dt>
                <dd className="font-mono text-xs">{compactHash(preview.evidence_package_hash)}</dd>
                <dt className="text-muted-foreground">Payload</dt>
                <dd>{formatBytes(preview.source_payload_byte_length)}</dd>
              </dl>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={loadingPreview || confirming}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canPreview}>
              {loadingPreview ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
              Preview
            </Button>
            <Button type="button" onClick={handleConfirm} disabled={!canConfirm}>
              {confirming ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
