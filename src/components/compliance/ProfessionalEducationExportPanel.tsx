import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { z } from 'zod';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { workerFetch } from '@/lib/workerClient';
import { PROFESSIONAL_EDUCATION_EXPORT_LABELS } from '@/lib/copy';
import { cn } from '@/lib/utils';

type ExportKind = 'cpe' | 'cle';
type ExportFormat = 'pdf' | 'json';

interface ExportArtifact {
  signed_url?: string;
}

interface ExportResponseBody {
  record_count?: number;
  exports?: Partial<Record<ExportFormat, ExportArtifact>>;
  error?: string | { message?: string };
}

interface EducationExportState {
  start: string;
  end: string;
  jurisdiction: string;
}

export interface ProfessionalEducationExportPanelProps {
  userId: string;
}

const LABELS = PROFESSIONAL_EDUCATION_EXPORT_LABELS;

const exportRequestSchema = z.object({
  user_id: z.string().uuid(),
  jurisdiction: z.string().trim().min(1).max(32).optional(),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  format: z.enum(['pdf', 'json']),
}).refine((value) => value.period_start <= value.period_end, {
  path: ['period_end'],
});

function parseError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const error = (body as ExportResponseBody).error;
  if (typeof error === 'string') return error;
  return error?.message ?? null;
}

function getSignedUrl(body: ExportResponseBody, format: ExportFormat): string | null {
  return body.exports?.[format]?.signed_url ?? null;
}

function isSafeDownloadUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function FormatButton({
  format,
  selected,
  onClick,
}: Readonly<{
  format: ExportFormat;
  selected: boolean;
  onClick: () => void;
}>) {
  const label = format === 'pdf' ? LABELS.FORMAT_PDF : LABELS.FORMAT_JSON;
  return (
    <Button
      type="button"
      variant={selected ? 'default' : 'outline'}
      size="sm"
      aria-pressed={selected}
      onClick={onClick}
      className="min-w-20"
    >
      {label}
    </Button>
  );
}

export function ProfessionalEducationExportPanel({ userId }: Readonly<ProfessionalEducationExportPanelProps>) {
  const [format, setFormat] = useState<ExportFormat>('pdf');
  const [cpe, setCpe] = useState<EducationExportState>({ start: '', end: '', jurisdiction: '' });
  const [cle, setCle] = useState<EducationExportState>({ start: '', end: '', jurisdiction: '' });
  const [loading, setLoading] = useState<ExportKind | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  async function submitExport(kind: ExportKind) {
    const state = kind === 'cpe' ? cpe : cle;
    if (!state.start || !state.end || state.start > state.end) {
      setMessage({ kind: 'error', text: LABELS.REQUIRED_FIELDS });
      return;
    }

    setLoading(kind);
    setMessage(null);

    const body = {
      user_id: userId,
      ...(kind === 'cle' ? { jurisdiction: state.jurisdiction } : {}),
      period_start: state.start,
      period_end: state.end,
      format,
    };

    if (!exportRequestSchema.safeParse(body).success) {
      setMessage({ kind: 'error', text: LABELS.REQUIRED_FIELDS });
      return;
    }

    try {
      const response = await workerFetch(`/api/v1/exports/${kind}-log`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const parsed = await response.json().catch(() => ({})) as ExportResponseBody;

      if (!response.ok) {
        throw new Error(parseError(parsed) ?? LABELS.GENERIC_ERROR);
      }

      const signedUrl = getSignedUrl(parsed, format);
      if (!signedUrl) {
        throw new Error(LABELS.MISSING_URL);
      }
      if (!isSafeDownloadUrl(signedUrl)) {
        throw new Error(LABELS.UNSAFE_URL);
      }

      window.open(signedUrl, '_blank', 'noopener,noreferrer');
      const count = parsed.record_count ?? 0;
      setMessage({
        kind: 'success',
        text: kind === 'cpe' ? LABELS.SUCCESS_CPE(count) : LABELS.SUCCESS_CLE(count),
      });
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : LABELS.GENERIC_ERROR,
      });
    } finally {
      setLoading(null);
    }
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg font-semibold">
          <Download className="h-5 w-5 text-[#00d4ff]" />
          {LABELS.TITLE}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{LABELS.DESCRIPTION}</p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label>{LABELS.FORMAT_LABEL}</Label>
          <div className="flex gap-2" role="group" aria-label={LABELS.FORMAT_LABEL}>
            <FormatButton format="pdf" selected={format === 'pdf'} onClick={() => setFormat('pdf')} />
            <FormatButton format="json" selected={format === 'json'} onClick={() => setFormat('json')} />
          </div>
        </div>

        {message && (
          <Alert variant={message.kind === 'success' ? 'success' : 'destructive'}>
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void submitExport('cpe'); }}>
            <div>
              <h3 className="text-sm font-semibold text-foreground">{LABELS.CPE_TITLE}</h3>
              <p className="text-xs text-muted-foreground">{LABELS.CPE_DESCRIPTION}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="cpe-period-start">{LABELS.CPE_PERIOD_START}</Label>
                <Input
                  id="cpe-period-start"
                  type="date"
                  value={cpe.start}
                  onChange={(event) => setCpe((current) => ({ ...current, start: event.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cpe-period-end">{LABELS.CPE_PERIOD_END}</Label>
                <Input
                  id="cpe-period-end"
                  type="date"
                  value={cpe.end}
                  onChange={(event) => setCpe((current) => ({ ...current, end: event.target.value }))}
                />
              </div>
            </div>
            <Button type="submit" className="w-full" disabled={loading !== null || !cpe.start || !cpe.end}>
              <Loader2 className={cn('h-4 w-4', loading === 'cpe' ? 'animate-spin' : 'hidden')} />
              {loading === 'cpe' ? LABELS.CPE_EXPORTING : LABELS.CPE_EXPORT}
            </Button>
          </form>

          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void submitExport('cle'); }}>
            <div>
              <h3 className="text-sm font-semibold text-foreground">{LABELS.CLE_TITLE}</h3>
              <p className="text-xs text-muted-foreground">{LABELS.CLE_DESCRIPTION}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="cle-jurisdiction">{LABELS.CLE_JURISDICTION}</Label>
                <Input
                  id="cle-jurisdiction"
                  value={cle.jurisdiction}
                  placeholder={LABELS.CLE_JURISDICTION_PLACEHOLDER}
                  onChange={(event) => setCle((current) => ({ ...current, jurisdiction: event.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cle-period-start">{LABELS.CLE_PERIOD_START}</Label>
                <Input
                  id="cle-period-start"
                  type="date"
                  value={cle.start}
                  onChange={(event) => setCle((current) => ({ ...current, start: event.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cle-period-end">{LABELS.CLE_PERIOD_END}</Label>
                <Input
                  id="cle-period-end"
                  type="date"
                  value={cle.end}
                  onChange={(event) => setCle((current) => ({ ...current, end: event.target.value }))}
                />
              </div>
            </div>
            <Button type="submit" className="w-full" disabled={loading !== null || !cle.jurisdiction || !cle.start || !cle.end}>
              <Loader2 className={cn('h-4 w-4', loading === 'cle' ? 'animate-spin' : 'hidden')} />
              {loading === 'cle' ? LABELS.CLE_EXPORTING : LABELS.CLE_EXPORT}
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  );
}
