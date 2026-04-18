/**
 * Audit My Organization Button (NCA-07)
 *
 * Prominent dashboard CTA. Clicking triggers `POST /api/v1/compliance/audit`,
 * transitions through a "Analyzing credentials…" → "Checking requirements…"
 * → "Generating report…" progress sequence, and on completion routes the
 * admin to the compliance scorecard page (NCA-08).
 *
 * Jira: SCRUM-762 (NCA-07)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, AlertTriangle, ArrowRight, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AUDIT_MY_ORG_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';

type AuditState =
  | { kind: 'idle' }
  | { kind: 'analyzing' }
  | { kind: 'checking' }
  | { kind: 'generating' }
  | { kind: 'complete'; auditId: string }
  | { kind: 'error'; message: string };

export interface TriggerAuditResponse {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  error_message?: string | null;
}

export interface AuditMyOrganizationButtonProps {
  /** Endpoint for triggering a new audit — overridable for tests/sandboxes. */
  triggerUrl?: string;
  /** Injected fetch for tests. Defaults to window.fetch. */
  fetchFn?: typeof fetch;
  /** Fired when a click starts — useful for analytics. */
  onAuditStarted?: () => void;
  /** Fired when the audit reaches COMPLETED. */
  onAuditCompleted?: (auditId: string) => void;
  /** Progress phase durations in ms — short default to keep UX snappy. */
  phaseDurationMs?: number;
  /** Skips the artificial phase animation — used in tests. */
  disablePhaseAnimation?: boolean;
}

const DEFAULT_TRIGGER_URL = '/api/v1/compliance/audit';
const DEFAULT_PHASE_DURATION_MS = 1500;

export function AuditMyOrganizationButton(props: AuditMyOrganizationButtonProps = {}) {
  const {
    triggerUrl = DEFAULT_TRIGGER_URL,
    fetchFn = typeof window !== 'undefined' ? window.fetch.bind(window) : undefined,
    onAuditStarted,
    onAuditCompleted,
    phaseDurationMs = DEFAULT_PHASE_DURATION_MS,
    disablePhaseAnimation = false,
  } = props;

  const navigate = useNavigate();
  const [state, setState] = useState<AuditState>({ kind: 'idle' });
  const timers = useRef<number[]>([]);

  useEffect(() => () => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  }, []);

  const scheduleProgress = useCallback(() => {
    if (disablePhaseAnimation) return;
    const t1 = window.setTimeout(() => setState((s) => (s.kind === 'analyzing' ? { kind: 'checking' } : s)), phaseDurationMs);
    const t2 = window.setTimeout(() => setState((s) => (s.kind === 'checking' ? { kind: 'generating' } : s)), phaseDurationMs * 2);
    timers.current.push(t1, t2);
  }, [disablePhaseAnimation, phaseDurationMs]);

  const handleClick = useCallback(async () => {
    if (!fetchFn) {
      setState({ kind: 'error', message: AUDIT_MY_ORG_LABELS.ERROR_FETCH_UNAVAILABLE });
      return;
    }
    setState({ kind: 'analyzing' });
    scheduleProgress();
    onAuditStarted?.();
    try {
      const res = await fetchFn(triggerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        credentials: 'include',
      });
      if (!res.ok) {
        const msg = await readErrorMessage(res);
        setState({ kind: 'error', message: msg });
        return;
      }
      const body = (await res.json()) as TriggerAuditResponse;
      if (body.status === 'FAILED') {
        setState({ kind: 'error', message: body.error_message ?? AUDIT_MY_ORG_LABELS.ERROR_AUDIT_FAILED });
        return;
      }
      setState({ kind: 'complete', auditId: body.id });
      onAuditCompleted?.(body.id);
    } catch (err) {
      const message = (err as Error).message ?? AUDIT_MY_ORG_LABELS.ERROR_NETWORK;
      setState({ kind: 'error', message });
    }
  }, [fetchFn, triggerUrl, onAuditStarted, onAuditCompleted, scheduleProgress]);

  const handleRetry = () => setState({ kind: 'idle' });

  const handleViewResults = () => {
    navigate(ROUTES.COMPLIANCE_SCORECARD);
  };

  return (
    <Card
      className="border-primary/40 bg-gradient-to-br from-primary/5 to-transparent"
      data-testid="audit-my-organization-card"
    >
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
          {AUDIT_MY_ORG_LABELS.TITLE}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{AUDIT_MY_ORG_LABELS.DESCRIPTION}</p>

        {state.kind === 'idle' && (
          <Button
            type="button"
            size="lg"
            className="w-full sm:w-auto"
            onClick={handleClick}
            data-testid="audit-trigger"
            aria-label={AUDIT_MY_ORG_LABELS.TITLE}
          >
            {AUDIT_MY_ORG_LABELS.CTA}
          </Button>
        )}

        {(state.kind === 'analyzing' || state.kind === 'checking' || state.kind === 'generating') && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-3 rounded-md border border-border/60 bg-background/60 p-3 text-sm"
            data-testid="audit-progress"
          >
            <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
            <div className="flex-1">
              <p className="font-medium">{progressLabel(state.kind)}</p>
              <p className="text-xs text-muted-foreground">{AUDIT_MY_ORG_LABELS.PROGRESS_ESTIMATE}</p>
            </div>
          </div>
        )}

        {state.kind === 'complete' && (
          <Button
            type="button"
            size="lg"
            className="w-full sm:w-auto"
            onClick={handleViewResults}
            data-testid="audit-view-results"
          >
            {AUDIT_MY_ORG_LABELS.VIEW_RESULTS}
            <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
        )}

        {state.kind === 'error' && (
          <div
            role="alert"
            className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
            data-testid="audit-error"
          >
            <div className="flex items-start gap-2 text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4" aria-hidden="true" />
              <p className="flex-1">{state.message}</p>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={handleRetry} data-testid="audit-retry">
              {AUDIT_MY_ORG_LABELS.RETRY}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function progressLabel(kind: 'analyzing' | 'checking' | 'generating'): string {
  switch (kind) {
    case 'analyzing':
      return AUDIT_MY_ORG_LABELS.PROGRESS_ANALYZING;
    case 'checking':
      return AUDIT_MY_ORG_LABELS.PROGRESS_CHECKING;
    case 'generating':
      return AUDIT_MY_ORG_LABELS.PROGRESS_GENERATING;
  }
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    if (j.error) return j.error;
  } catch {
    /* fall through */
  }
  return `${AUDIT_MY_ORG_LABELS.ERROR_HTTP_PREFIX} ${res.status}`;
}
