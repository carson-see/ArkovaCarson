/**
 * Rule Simulator Panel (SCRUM-1141)
 *
 * Wraps the worker `POST /api/rules/test` endpoint (SCRUM-1140) so an org
 * admin can run a sample event through the rule they're authoring without
 * persisting anything. Sits inside the rule builder review step + on the
 * read-only rule detail view.
 *
 * Acceptance Criteria:
 *   - Source-specific sample payload templates per trigger_type.
 *   - Editable vendor / filename / folder path / sender / subject /
 *     connector_type fields.
 *   - Shows matched/not matched, reason, semantic-match caveat, action preview.
 *   - "Test rule" action is clearly separate from Save/Enable.
 *   - Mobile and laptop layouts fit without text overlap.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, XCircle, FlaskConical, Loader2, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { workerFetch } from '@/lib/workerClient';
import { RULE_SIMULATOR_COPY as C, RULE_ACTION_COPY, RULE_TRIGGER_COPY } from '@/lib/copy';

export type SimulatorTriggerType =
  | 'ESIGN_COMPLETED'
  | 'WORKSPACE_FILE_MODIFIED'
  | 'CONNECTOR_DOCUMENT_RECEIVED'
  | 'MANUAL_UPLOAD'
  | 'EMAIL_INTAKE';

export interface RuleSimulatorRule {
  name?: string;
  description?: string;
  trigger_type?: string;
  trigger_config?: Record<string, unknown>;
  action_type?: string;
  action_config?: Record<string, unknown>;
}

export interface RuleSimulatorPanelProps {
  rule: RuleSimulatorRule;
  /** Optional: override workerFetch for tests. */
  fetcher?: typeof workerFetch;
}

interface SamplePayload {
  vendor: string;
  filename: string;
  folder_path: string;
  sender_email: string;
  subject: string;
}

const EMPTY_SAMPLE: SamplePayload = {
  vendor: '',
  filename: '',
  folder_path: '',
  sender_email: '',
  subject: '',
};

const SAMPLES: Record<SimulatorTriggerType, SamplePayload> = {
  ESIGN_COMPLETED: {
    vendor: 'docusign',
    filename: 'sample-msa-signed.pdf',
    folder_path: '',
    sender_email: 'signer@example.com',
    subject: '',
  },
  WORKSPACE_FILE_MODIFIED: {
    vendor: 'google_drive',
    filename: 'sample-policy.docx',
    folder_path: '/Legal/MSAs/',
    sender_email: '',
    subject: '',
  },
  CONNECTOR_DOCUMENT_RECEIVED: {
    vendor: 'veremark',
    filename: '',
    folder_path: '',
    sender_email: 'candidate@example.com',
    subject: '',
  },
  MANUAL_UPLOAD: {
    vendor: '',
    filename: 'sample-upload.pdf',
    folder_path: '',
    sender_email: '',
    subject: '',
  },
  EMAIL_INTAKE: {
    vendor: '',
    filename: 'sample-attachment.pdf',
    folder_path: '',
    sender_email: 'intake@example.com',
    subject: 'Signed contract attached',
  },
};

const SUPPORTED_TRIGGERS: ReadonlyArray<SimulatorTriggerType> = [
  'ESIGN_COMPLETED',
  'WORKSPACE_FILE_MODIFIED',
  'CONNECTOR_DOCUMENT_RECEIVED',
  'MANUAL_UPLOAD',
  'EMAIL_INTAKE',
];

function isSupported(t: string | undefined): t is SimulatorTriggerType {
  return typeof t === 'string' && (SUPPORTED_TRIGGERS as readonly string[]).includes(t);
}

interface SimulatorResult {
  matched: boolean;
  reason: string;
  needs_semantic_match: boolean;
  action_type?: string;
  action_preview?: { action_type: string; config: Record<string, unknown> };
}

export function RuleSimulatorPanel({ rule, fetcher = workerFetch }: RuleSimulatorPanelProps) {
  const triggerType = rule.trigger_type;
  const supported = isSupported(triggerType);
  const baseSample = useMemo<SamplePayload>(
    () => (supported ? SAMPLES[triggerType] : EMPTY_SAMPLE),
    [supported, triggerType],
  );

  // React's "adjust state on prop change" pattern: when trigger_type
  // changes mid-edit, re-seed the sample fields. Done by tracking the
  // previous trigger in state and comparing during render — this is the
  // documented alternative to a setState-in-effect.
  const [prevTrigger, setPrevTrigger] = useState<string | undefined>(triggerType);
  const [sample, setSample] = useState<SamplePayload>(baseSample);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SimulatorResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  if (prevTrigger !== triggerType) {
    setPrevTrigger(triggerType);
    setSample(baseSample);
    setResult(null);
    setError(null);
  }

  // Abort the in-flight test fetch on unmount so React doesn't fire
  // setState after the component is gone.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  function update<K extends keyof SamplePayload>(key: K, value: string) {
    setSample((prev) => ({ ...prev, [key]: value }));
  }

  function reset() {
    setSample(baseSample);
    setResult(null);
    setError(null);
  }

  async function runTest() {
    if (!rule.trigger_type || !rule.action_type) {
      setError(C.ERR_NEED_TRIGGER_AND_ACTION);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetcher('/api/rules/test', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          rule: {
            name: rule.name?.trim() || 'simulator-rule',
            description: rule.description,
            trigger_type: rule.trigger_type,
            trigger_config: rule.trigger_config ?? {},
            action_type: rule.action_type,
            action_config: rule.action_config ?? {},
          },
          event: {
            trigger_type: rule.trigger_type,
            // Empty strings → omit so the worker's Zod validation doesn't
            // reject an obviously-empty optional field.
            vendor: sample.vendor || undefined,
            filename: sample.filename || undefined,
            folder_path: sample.folder_path || undefined,
            sender_email: sample.sender_email || undefined,
            subject: sample.subject || undefined,
          },
          assume_enabled: true,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = (body as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`;
        setError(msg);
        return;
      }
      const data = (await res.json()) as SimulatorResult;
      if (controller.signal.aborted) return;
      setResult(data);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : C.ERR_GENERIC);
    } finally {
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  return (
    <Card data-testid="rule-simulator-panel" className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="h-4 w-4" />
          {C.PANEL_TITLE}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{C.PANEL_SUBTITLE}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <h4 className="text-sm font-medium mb-1">{C.SAMPLE_HEADING}</h4>
          <p className="text-xs text-muted-foreground mb-3">{C.SAMPLE_HINT}</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="sim-vendor">{C.FIELD_VENDOR}</Label>
              <Input
                id="sim-vendor"
                placeholder={C.FIELD_VENDOR_PLACEHOLDER}
                value={sample.vendor}
                onChange={(e) => update('vendor', e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="sim-filename">{C.FIELD_FILENAME}</Label>
              <Input
                id="sim-filename"
                placeholder={C.FIELD_FILENAME_PLACEHOLDER}
                value={sample.filename}
                onChange={(e) => update('filename', e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="sim-folder">{C.FIELD_FOLDER_PATH}</Label>
              <Input
                id="sim-folder"
                placeholder={C.FIELD_FOLDER_PATH_PLACEHOLDER}
                value={sample.folder_path}
                onChange={(e) => update('folder_path', e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="sim-sender">{C.FIELD_SENDER}</Label>
              <Input
                id="sim-sender"
                placeholder={C.FIELD_SENDER_PLACEHOLDER}
                value={sample.sender_email}
                onChange={(e) => update('sender_email', e.target.value)}
              />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="sim-subject">{C.FIELD_SUBJECT}</Label>
              <Input
                id="sim-subject"
                placeholder={C.FIELD_SUBJECT_PLACEHOLDER}
                value={sample.subject}
                onChange={(e) => update('subject', e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-2 border-t">
          <Button
            type="button"
            onClick={runTest}
            disabled={submitting}
            data-testid="simulator-run"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                {C.TESTING}
              </>
            ) : (
              <>
                <FlaskConical className="h-4 w-4 mr-1" />
                {C.TEST_BUTTON}
              </>
            )}
          </Button>
          <Button type="button" variant="ghost" onClick={reset} disabled={submitting}>
            {C.RESET_SAMPLE}
          </Button>
        </div>

        {error && (
          <div
            className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-900 flex items-start gap-2"
            role="alert"
            data-testid="simulator-error"
          >
            <AlertTriangle className="h-4 w-4 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {result && (
          <div className="space-y-2" data-testid="simulator-result">
            <div className="flex items-center gap-2">
              {result.matched ? (
                <Badge className="bg-emerald-100 text-emerald-900 border-emerald-300">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  {C.RESULT_MATCHED}
                </Badge>
              ) : (
                <Badge className="bg-slate-100 text-slate-900 border-slate-300">
                  <XCircle className="h-3 w-3 mr-1" />
                  {C.RESULT_NOT_MATCHED}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                {C.RESULT_REASON_LABEL}: <code>{result.reason}</code>
              </span>
            </div>
            {result.needs_semantic_match && (
              <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2">
                {C.RESULT_NEEDS_SEMANTIC}
              </p>
            )}
            {result.matched && result.action_preview && (
              <div className="text-sm">
                <div className="text-muted-foreground text-xs mb-1">{C.RESULT_ACTION_PREVIEW}</div>
                <div className="font-medium">
                  {RULE_ACTION_COPY[result.action_preview.action_type as keyof typeof RULE_ACTION_COPY]?.label
                    ?? result.action_preview.action_type}
                </div>
                {rule.trigger_type && RULE_TRIGGER_COPY[rule.trigger_type as keyof typeof RULE_TRIGGER_COPY] && (
                  <div className="text-xs text-muted-foreground">
                    Trigger: {RULE_TRIGGER_COPY[rule.trigger_type as keyof typeof RULE_TRIGGER_COPY].label}
                  </div>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground italic">{C.RESULT_DRY_RUN_BANNER}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
