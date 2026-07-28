/**
 * L3-A6 — CE Noncredit Data Taxonomy 3.0 anchoring POC (2026-07-28).
 *
 * UI entry point (founder amendment A2: every user-facing capability ships a
 * reachable UI in the same PR). Two-step flow mirroring
 * `CredentialSourceImportDialog`:
 *   1. Look up — `GET /api/v1/credentials/ctdl/import?ctid=` fetches +
 *      parses the public registry record and returns the fetch+fingerprint
 *      result (no write).
 *   2. Add — `POST /api/v1/credentials/ctdl/registry-anchor` re-fetches
 *      (staleness-checked against the fingerprint shown in step 1), creates
 *      the record, and returns the resulting record link.
 *
 * §1.3-safe: "Fingerprint" not "Hash", "public registry" not chain
 * terminology, "Add Record" not "Issue Credential" (SCRUM-1672 restricts that
 * phrase to the verified-org issuance flow, which this is not).
 */
import { FormEvent, useState } from 'react';
import { CheckCircle2, ExternalLink, Landmark, Loader2 } from 'lucide-react';
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { workerFetch } from '@/lib/workerClient';
import { CE_REGISTRY_IMPORT_LABELS as LABELS } from '@/lib/copy';

interface CtdlLookupRecord {
  type: string | null;
  name: string | null;
  issuer: { name: string | null } | null;
}

interface CtdlLookupResponse {
  ctid: string;
  registry: {
    retrievedAt: string;
    envelopeSha256: string;
  };
  count: number;
  records: CtdlLookupRecord[];
}

interface CtdlAnchorResponse {
  duplicate: boolean;
  anchor: {
    public_id: string;
    status: string;
    record_uri: string;
  };
  registry: {
    ctid: string;
    registryUrl: string;
    envelopeSha256: string;
    retrievedAt: string;
  };
  record: {
    type: string | null;
    name: string | null;
    issuerName: string | null;
  };
}

interface CtdlRegistryImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void | Promise<void>;
}

async function parseWorkerResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (body as { message?: string; error?: string }).message
      ?? (body as { error?: string }).error
      ?? `${LABELS.REQUEST_FAILED} (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

function compactFingerprint(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function formatRecordType(type: string | null): string {
  if (!type) return LABELS.NOT_DETECTED;
  return type.replace(/^ceterms:/, '');
}

export function CtdlRegistryImportDialog({
  open,
  onOpenChange,
  onImported,
}: Readonly<CtdlRegistryImportDialogProps>) {
  const [ctid, setCtid] = useState('');
  const [lookup, setLookup] = useState<CtdlLookupResponse | null>(null);
  const [loadingLookup, setLoadingLookup] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CtdlAnchorResponse | null>(null);

  const resetState = () => {
    setCtid('');
    setLookup(null);
    setError(null);
    setLoadingLookup(false);
    setAdding(false);
    setResult(null);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) resetState();
    onOpenChange(nextOpen);
  };

  const canLookUp = ctid.trim().length > 0 && !loadingLookup && !adding;
  const primaryRecord = lookup?.records[0] ?? null;
  const canAdd = !!lookup && !!primaryRecord && !loadingLookup && !adding && !result;

  const handleLookup = async (event: FormEvent) => {
    event.preventDefault();
    setLoadingLookup(true);
    setError(null);
    setLookup(null);
    setResult(null);

    try {
      const response = await workerFetch(
        `/api/v1/credentials/ctdl/import?ctid=${encodeURIComponent(ctid.trim())}`,
        { method: 'GET' },
      );
      const parsed = await parseWorkerResponse<CtdlLookupResponse>(response);
      if (parsed.records.length === 0) {
        setError(LABELS.NO_RECORD);
        return;
      }
      setLookup(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : LABELS.LOOKUP_FAILED);
    } finally {
      setLoadingLookup(false);
    }
  };

  const handleAdd = async () => {
    if (!lookup) return;
    setAdding(true);
    setError(null);

    try {
      const response = await workerFetch('/api/v1/credentials/ctdl/registry-anchor', {
        method: 'POST',
        body: JSON.stringify({
          ctid: lookup.ctid,
          expected_envelope_sha256: lookup.registry.envelopeSha256,
        }),
      });
      const parsed = await parseWorkerResponse<CtdlAnchorResponse>(response);
      setResult(parsed);
      toast.success(parsed.duplicate ? LABELS.TOAST_DUPLICATE : LABELS.TOAST_ADDED);
      await onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : LABELS.ADD_FAILED);
    } finally {
      setAdding(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Landmark className="h-5 w-5 text-primary" />
            {LABELS.TITLE}
          </DialogTitle>
          <DialogDescription>{LABELS.DESCRIPTION}</DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleLookup}>
          <div className="space-y-2">
            <Label htmlFor="ctdl-registry-ctid">{LABELS.CTID_LABEL}</Label>
            <Input
              id="ctdl-registry-ctid"
              value={ctid}
              onChange={(event) => {
                setCtid(event.target.value);
                setLookup(null);
                setResult(null);
                setError(null);
              }}
              placeholder={LABELS.CTID_PLACEHOLDER}
              disabled={loadingLookup || adding}
              required
            />
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {lookup && primaryRecord && !result && (
            <div className="rounded-md border bg-muted/20 p-4" data-testid="ctdl-registry-lookup-result">
              <div className="mb-3">
                <p className="truncate font-medium">{primaryRecord.name ?? LABELS.NOT_DETECTED}</p>
                <p className="text-sm text-muted-foreground">{formatRecordType(primaryRecord.type)}</p>
              </div>
              <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted-foreground">{LABELS.ISSUER_FIELD}</dt>
                <dd>{primaryRecord.issuer?.name ?? LABELS.NOT_DETECTED}</dd>
                <dt className="text-muted-foreground">{LABELS.RETRIEVED_FIELD}</dt>
                <dd>{new Date(lookup.registry.retrievedAt).toLocaleString()}</dd>
                <dt className="text-muted-foreground">{LABELS.FINGERPRINT_FIELD}</dt>
                <dd className="font-mono text-xs" data-testid="ctdl-registry-envelope-fingerprint">
                  {compactFingerprint(lookup.registry.envelopeSha256)}
                </dd>
              </dl>
            </div>
          )}

          {result && (
            <div className="rounded-md border bg-muted/20 p-4" data-testid="ctdl-registry-anchor-result">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-primary">
                <CheckCircle2 className="h-4 w-4" />
                {result.duplicate ? LABELS.TOAST_DUPLICATE : LABELS.TOAST_ADDED}
              </div>
              <a
                href={result.anchor.record_uri}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
                data-testid="ctdl-registry-anchor-link"
              >
                {result.anchor.public_id}
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={loadingLookup || adding}
            >
              {LABELS.CANCEL}
            </Button>
            {!result && (
              <Button type="submit" disabled={!canLookUp}>
                {loadingLookup ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {loadingLookup ? LABELS.LOOKING_UP : LABELS.LOOKUP}
              </Button>
            )}
            {!result && (
              <Button type="button" onClick={handleAdd} disabled={!canAdd}>
                {adding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                {adding ? LABELS.ADDING : LABELS.ADD}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
