/**
 * Rule Builder Wizard (ARK-108 — SCRUM-1020)
 *
 * Four-step no-code wizard for org admins to author rules:
 *   1. Trigger        — pick an event source
 *   2. Configure      — filters per trigger type
 *   3. Action         — pick what happens when the rule fires
 *   4. Review & Save  — final check; rules ship with enabled=false
 *
 * Submits to POST /api/rules. After save the admin lands on the list page
 * where they can flip `enabled` on manually (SEC-02 defense).
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckCircle, Save } from 'lucide-react';
import { AppShell } from '@/components/layout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { workerFetch } from '@/lib/workerClient';
import { ROUTES } from '@/lib/routes';

type TriggerType =
  | 'ESIGN_COMPLETED'
  | 'WORKSPACE_FILE_MODIFIED'
  | 'CONNECTOR_DOCUMENT_RECEIVED'
  | 'MANUAL_UPLOAD'
  | 'SCHEDULED_CRON'
  | 'QUEUE_DIGEST'
  | 'EMAIL_INTAKE';

type ActionType =
  | 'AUTO_ANCHOR'
  | 'FAST_TRACK_ANCHOR'
  | 'QUEUE_FOR_REVIEW'
  | 'FLAG_COLLISION'
  | 'NOTIFY'
  | 'FORWARD_TO_URL';

const TRIGGER_COPY: Record<TriggerType, { label: string; desc: string }> = {
  ESIGN_COMPLETED: {
    label: 'E-signature completed',
    desc: 'When a DocuSign or Adobe Sign envelope is signed.',
  },
  WORKSPACE_FILE_MODIFIED: {
    label: 'Workspace file modified',
    desc: 'When a file changes in Google Drive, SharePoint, or OneDrive.',
  },
  CONNECTOR_DOCUMENT_RECEIVED: {
    label: 'Connector delivered a document',
    desc: 'When a partner (Veremark, Checkr, ...) posts a completed report.',
  },
  MANUAL_UPLOAD: {
    label: 'Manual upload',
    desc: 'When a user uploads through the web app.',
  },
  SCHEDULED_CRON: {
    label: 'Schedule',
    desc: 'On a recurring schedule (e.g. daily at 9am).',
  },
  QUEUE_DIGEST: {
    label: 'Queue review digest',
    desc: 'A daily/weekly digest of the review queue.',
  },
  EMAIL_INTAKE: {
    label: 'Email intake',
    desc: 'When a document arrives at your org intake address.',
  },
};

const ACTION_COPY: Record<ActionType, { label: string; desc: string }> = {
  AUTO_ANCHOR: { label: 'Secure the document', desc: 'Anchor it on the network automatically.' },
  FAST_TRACK_ANCHOR: {
    label: 'Fast-track secure',
    desc: 'Priority batch (paid plans only).',
  },
  QUEUE_FOR_REVIEW: {
    label: 'Queue for admin review',
    desc: 'Surface on the review dashboard; admin decides.',
  },
  FLAG_COLLISION: {
    label: 'Flag version collision',
    desc: 'If multiple versions arrive within a window, flag them for review.',
  },
  NOTIFY: { label: 'Notify', desc: 'Email and/or Slack the team.' },
  FORWARD_TO_URL: {
    label: 'Forward to a URL',
    desc: 'POST the event to a pre-allowlisted webhook target.',
  },
};

interface WizardState {
  step: 1 | 2 | 3 | 4;
  name: string;
  description: string;
  trigger_type: TriggerType | '';
  trigger_config: Record<string, unknown>;
  action_type: ActionType | '';
  action_config: Record<string, unknown>;
  enabled: boolean;
}

const EMPTY: WizardState = {
  step: 1,
  name: '',
  description: '',
  trigger_type: '',
  trigger_config: {},
  action_type: '',
  action_config: {},
  enabled: false,
};

export function RuleBuilderPage() {
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const navigate = useNavigate();
  const [state, setState] = useState<WizardState>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orgId = profile?.org_id ?? null;

  function update<K extends keyof WizardState>(key: K, value: WizardState[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  function patch(partial: Partial<WizardState>) {
    setState((prev) => ({ ...prev, ...partial }));
  }

  function nextStep() {
    if (state.step === 1 && !state.trigger_type) {
      setError('Pick a trigger to continue.');
      return;
    }
    if (state.step === 3 && !state.action_type) {
      setError('Pick an action to continue.');
      return;
    }
    if (state.step === 4) return; // end
    setError(null);
    update('step', (state.step + 1) as WizardState['step']);
  }

  function prevStep() {
    if (state.step === 1) return;
    setError(null);
    update('step', (state.step - 1) as WizardState['step']);
  }

  async function handleSave() {
    if (!orgId) {
      setError('No organization selected.');
      return;
    }
    if (!state.name.trim()) {
      setError('Name is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await workerFetch('/api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: orgId,
          name: state.name.trim(),
          description: state.description.trim() || undefined,
          trigger_type: state.trigger_type,
          trigger_config: state.trigger_config,
          action_type: state.action_type,
          action_config: state.action_config,
          enabled: false, // ARK-110 rule: admin enables after review
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? `Save failed (${res.status})`);
      }
      navigate(ROUTES.COMPLIANCE_DASHBOARD);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell
      user={user ?? undefined}
      onSignOut={signOut}
      profile={profile ?? undefined}
      profileLoading={profileLoading}
    >
      <div className="mx-auto max-w-3xl p-6 space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Build a new rule</h1>
          <p className="text-sm text-muted-foreground">
            Describe what should happen and when. New rules always land disabled — flip them on
            after you've reviewed the summary.
          </p>
        </header>

        <StepIndicator step={state.step} />

        <Card>
          <CardHeader>
            <CardTitle>Step {state.step} of 4</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {state.step === 1 && <StepTrigger state={state} update={update} patch={patch} />}
            {state.step === 2 && <StepConfigure state={state} update={update} patch={patch} />}
            {state.step === 3 && <StepAction state={state} update={update} patch={patch} />}
            {state.step === 4 && <StepReview state={state} update={update} patch={patch} />}

            {error && (
              <p className="text-sm text-red-600" role="alert" data-testid="wizard-error">
                {error}
              </p>
            )}

            <div className="flex items-center justify-between pt-4 border-t">
              <Button variant="ghost" onClick={prevStep} disabled={state.step === 1}>
                <ArrowLeft className="h-4 w-4 mr-1" /> Back
              </Button>
              {state.step < 4 ? (
                <Button onClick={nextStep}>
                  Next <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
              ) : (
                <Button onClick={handleSave} disabled={submitting}>
                  <Save className="h-4 w-4 mr-1" /> {submitting ? 'Saving…' : 'Save as disabled'}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function StepIndicator({ step }: { step: 1 | 2 | 3 | 4 }) {
  const labels = ['Trigger', 'Configure', 'Action', 'Review'];
  return (
    <ol className="flex items-center gap-2 text-sm">
      {labels.map((label, idx) => {
        const s = (idx + 1) as 1 | 2 | 3 | 4;
        const active = s === step;
        const done = s < step;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={
                active
                  ? 'flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground font-semibold'
                  : done
                    ? 'flex h-6 w-6 items-center justify-center rounded-full bg-green-600 text-white'
                    : 'flex h-6 w-6 items-center justify-center rounded-full bg-muted text-muted-foreground'
              }
            >
              {done ? <CheckCircle className="h-4 w-4" /> : s}
            </span>
            <span className={active ? 'font-medium' : 'text-muted-foreground'}>{label}</span>
            {s < 4 && <span className="text-muted-foreground">→</span>}
          </li>
        );
      })}
    </ol>
  );
}

interface StepProps {
  state: WizardState;
  update: <K extends keyof WizardState>(key: K, value: WizardState[K]) => void;
  patch: (partial: Partial<WizardState>) => void;
}

function StepTrigger({ state, update, patch }: StepProps) {
  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="rule-name">Rule name</Label>
        <Input
          id="rule-name"
          placeholder="e.g. Auto-secure signed MSAs"
          value={state.name}
          onChange={(e) => update('name', e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="rule-description">Description (optional)</Label>
        <Textarea
          id="rule-description"
          placeholder="What does this rule do, in plain English?"
          value={state.description}
          onChange={(e) => update('description', e.target.value)}
          maxLength={1000}
        />
      </div>
      <div>
        <Label htmlFor="trigger-type">Trigger</Label>
        <Select
          value={state.trigger_type}
          onValueChange={(v) =>
            patch({ trigger_type: v as TriggerType, trigger_config: {} })
          }
        >
          <SelectTrigger id="trigger-type">
            <SelectValue placeholder="Pick what should start this rule" />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(TRIGGER_COPY) as TriggerType[]).map((t) => (
              <SelectItem key={t} value={t}>
                {TRIGGER_COPY[t].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {state.trigger_type && (
          <p className="text-sm text-muted-foreground mt-2">
            {TRIGGER_COPY[state.trigger_type].desc}
          </p>
        )}
      </div>
    </div>
  );
}

function StepConfigure({ state, update }: StepProps) {
  const t = state.trigger_type;

  function setCfg(key: string, value: unknown) {
    update('trigger_config', { ...state.trigger_config, [key]: value });
  }

  if (t === 'ESIGN_COMPLETED') {
    const cfg = state.trigger_config as {
      filename_contains?: string;
      sender_email_equals?: string;
      vendors?: string[];
    };
    return (
      <div className="space-y-4">
        <div>
          <Label>Filename contains (optional)</Label>
          <Input
            placeholder="e.g. MSA"
            value={cfg.filename_contains ?? ''}
            onChange={(e) => setCfg('filename_contains', e.target.value || undefined)}
          />
        </div>
        <div>
          <Label>Sender email equals (optional)</Label>
          <Input
            placeholder="hr@acme.com"
            value={cfg.sender_email_equals ?? ''}
            onChange={(e) => setCfg('sender_email_equals', e.target.value || undefined)}
          />
        </div>
      </div>
    );
  }

  if (t === 'WORKSPACE_FILE_MODIFIED') {
    const cfg = state.trigger_config as {
      folder_path_starts_with?: string;
      filename_contains?: string;
    };
    return (
      <div className="space-y-4">
        <div>
          <Label>Folder path starts with (optional)</Label>
          <Input
            placeholder="/HR/Contracts/"
            value={cfg.folder_path_starts_with ?? ''}
            onChange={(e) => setCfg('folder_path_starts_with', e.target.value || undefined)}
          />
        </div>
        <div>
          <Label>Filename contains (optional)</Label>
          <Input
            placeholder="e.g. SOW"
            value={cfg.filename_contains ?? ''}
            onChange={(e) => setCfg('filename_contains', e.target.value || undefined)}
          />
        </div>
      </div>
    );
  }

  if (t === 'CONNECTOR_DOCUMENT_RECEIVED') {
    const cfg = state.trigger_config as { connector_type?: string };
    return (
      <div className="space-y-4">
        <Label htmlFor="connector-type">Connector</Label>
        <Select
          value={cfg.connector_type ?? ''}
          onValueChange={(v) => setCfg('connector_type', v)}
        >
          <SelectTrigger id="connector-type">
            <SelectValue placeholder="Pick a connector" />
          </SelectTrigger>
          <SelectContent>
            {['veremark', 'checkr', 'hireright', 'goodhire', 'generic'].map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (t === 'SCHEDULED_CRON' || t === 'QUEUE_DIGEST') {
    const cfg = state.trigger_config as { cron?: string; timezone?: string };
    return (
      <div className="space-y-4">
        <div>
          <Label>Schedule (cron expression)</Label>
          <Input
            placeholder="0,30 9,16 * * *"
            value={cfg.cron ?? ''}
            onChange={(e) => setCfg('cron', e.target.value)}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Five fields: minute hour day-of-month month day-of-week. Example: <code>0 9 * * *</code>{' '}
            runs at 9 AM every day.
          </p>
        </div>
        <div>
          <Label>Timezone</Label>
          <Select
            value={cfg.timezone ?? 'UTC'}
            onValueChange={(v) => setCfg('timezone', v)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'].map(
                (tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </div>
      </div>
    );
  }

  return (
    <p className="text-sm text-muted-foreground">
      This trigger has no additional configuration. Move on to pick an action.
    </p>
  );
}

function StepAction({ state, update, patch }: StepProps) {
  function setCfg(key: string, value: unknown) {
    update('action_config', { ...state.action_config, [key]: value });
  }

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="action-type">Action</Label>
        <Select
          value={state.action_type}
          onValueChange={(v) =>
            patch({ action_type: v as ActionType, action_config: {} })
          }
        >
          <SelectTrigger id="action-type">
            <SelectValue placeholder="Pick what should happen" />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(ACTION_COPY) as ActionType[]).map((a) => (
              <SelectItem key={a} value={a}>
                {ACTION_COPY[a].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {state.action_type && (
          <p className="text-sm text-muted-foreground mt-2">
            {ACTION_COPY[state.action_type].desc}
          </p>
        )}
      </div>

      {state.action_type === 'NOTIFY' && (
        <div className="space-y-2">
          <Label>Email recipients (comma-separated)</Label>
          <Input
            placeholder="alice@acme.com, bob@acme.com"
            value={((state.action_config.recipient_emails as string[] | undefined) ?? []).join(', ')}
            onChange={(e) =>
              setCfg(
                'recipient_emails',
                e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
          />
          <Label>Channels</Label>
          <div className="flex items-center gap-4">
            {(['email', 'slack'] as const).map((ch) => {
              const channels = (state.action_config.channels as string[] | undefined) ?? [];
              return (
                <label key={ch} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={channels.includes(ch)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...channels, ch]
                        : channels.filter((c) => c !== ch);
                      setCfg('channels', next);
                    }}
                  />
                  {ch}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {state.action_type === 'FLAG_COLLISION' && (
        <div>
          <Label>Collision window (minutes)</Label>
          <Input
            type="number"
            min={1}
            max={1440}
            value={(state.action_config.window_minutes as number | undefined) ?? 5}
            onChange={(e) => setCfg('window_minutes', parseInt(e.target.value, 10) || 5)}
          />
        </div>
      )}

      {state.action_type === 'FORWARD_TO_URL' && (
        <div className="space-y-2">
          <Label>Target URL</Label>
          <Input
            placeholder="https://ops.example.com/hooks/arkova"
            value={(state.action_config.target_url as string | undefined) ?? ''}
            onChange={(e) => setCfg('target_url', e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Worker will refuse any URL not on your org's allowlist.
          </p>
        </div>
      )}
    </div>
  );
}

function StepReview({ state }: StepProps) {
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="text-muted-foreground">Name</dt>
          <dd className="font-medium">{state.name || '—'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Status on save</dt>
          <dd>
            <Badge variant="outline">Disabled</Badge>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Trigger</dt>
          <dd>{state.trigger_type ? TRIGGER_COPY[state.trigger_type].label : '—'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Action</dt>
          <dd>{state.action_type ? ACTION_COPY[state.action_type].label : '—'}</dd>
        </div>
      </dl>

      {(Object.keys(state.trigger_config).length > 0 ||
        Object.keys(state.action_config).length > 0) && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Show raw config</summary>
          <pre className="mt-2 p-2 bg-muted rounded text-[11px] overflow-auto">
            {JSON.stringify(
              { trigger_config: state.trigger_config, action_config: state.action_config },
              null,
              2,
            )}
          </pre>
        </details>
      )}

      <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900 flex items-start gap-2">
        <Switch checked={false} disabled aria-label="disabled-indicator" />
        <span>
          New rules ship disabled. Enable from the rules list after checking the summary.
        </span>
      </div>
    </div>
  );
}

export default RuleBuilderPage;
