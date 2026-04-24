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
import {
  RULE_ACTION_COPY,
  RULE_TRIGGER_COPY,
  RULE_WIZARD_LABELS as W,
} from '@/lib/copy';
import {
  validateWizardConfigs,
  type ActionType,
  type TriggerType,
} from '@/lib/ruleSchemas';

const TRIGGER_COPY = RULE_TRIGGER_COPY;
const ACTION_COPY = RULE_ACTION_COPY;

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
      setError(W.ERR_PICK_TRIGGER);
      return;
    }
    if (state.step === 3 && !state.action_type) {
      setError(W.ERR_PICK_ACTION);
      return;
    }
    if (state.step === 4) return; // end
    // CIBA-HARDEN-04: fail client-side on invalid trigger/action configs
    // instead of letting the POST round-trip render a 400 in the wizard.
    // The worker stays authoritative (duplicate parse on POST), but users
    // shouldn't reach step 4 with a missing cron, unresolved HMAC handle,
    // or unselected connector.
    const issues = validateWizardConfigs({
      trigger_type: state.trigger_type,
      trigger_config: state.trigger_config,
      action_type: state.action_type,
      action_config: state.action_config,
    });
    if (issues.length > 0) {
      setError(W.ERR_INVALID_CONFIG_PREFIX + issues.join('; '));
      return;
    }
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
      setError(W.ERR_NO_ORG);
      return;
    }
    if (!state.name.trim()) {
      setError(W.ERR_NAME_REQUIRED);
      return;
    }
    // CIBA-HARDEN-04: belt-and-braces — repeat the config validation on Save
    // in case a user skipped the wizard flow (e.g. browser autocomplete +
    // synthetic form submit) and landed at step 4 with invalid values.
    const issues = validateWizardConfigs({
      trigger_type: state.trigger_type,
      trigger_config: state.trigger_config,
      action_type: state.action_type,
      action_config: state.action_config,
    });
    if (issues.length > 0) {
      setError(W.ERR_INVALID_CONFIG_PREFIX + issues.join('; '));
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
          <h1 className="text-2xl font-semibold tracking-tight">{W.PAGE_TITLE}</h1>
          <p className="text-sm text-muted-foreground">{W.PAGE_SUBTITLE}</p>
        </header>

        <StepIndicator step={state.step} />

        <Card>
          <CardHeader>
            <CardTitle>{W.STEP_HEADING(state.step)}</CardTitle>
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
                <ArrowLeft className="h-4 w-4 mr-1" /> {W.BACK}
              </Button>
              {state.step < 4 ? (
                <Button onClick={nextStep}>
                  {W.NEXT} <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
              ) : (
                <Button onClick={handleSave} disabled={submitting}>
                  <Save className="h-4 w-4 mr-1" /> {submitting ? W.SAVING : W.SAVE}
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
  const labels = W.STEP_INDICATOR;
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
        <Label htmlFor="rule-name">{W.FIELD_RULE_NAME}</Label>
        <Input
          id="rule-name"
          placeholder={W.FIELD_RULE_NAME_PLACEHOLDER}
          value={state.name}
          onChange={(e) => update('name', e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="rule-description">{W.FIELD_DESCRIPTION}</Label>
        <Textarea
          id="rule-description"
          placeholder={W.FIELD_DESCRIPTION_PLACEHOLDER}
          value={state.description}
          onChange={(e) => update('description', e.target.value)}
          maxLength={1000}
        />
      </div>
      <div>
        <Label htmlFor="trigger-type">{W.FIELD_TRIGGER}</Label>
        <Select
          value={state.trigger_type}
          onValueChange={(v) =>
            patch({ trigger_type: v as TriggerType, trigger_config: {} })
          }
        >
          <SelectTrigger id="trigger-type">
            <SelectValue placeholder={W.FIELD_TRIGGER_PLACEHOLDER} />
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
          <Label>{W.FIELD_FILENAME_CONTAINS}</Label>
          <Input
            placeholder={W.FIELD_FILENAME_CONTAINS_PLACEHOLDER_MSA}
            value={cfg.filename_contains ?? ''}
            onChange={(e) => setCfg('filename_contains', e.target.value || undefined)}
          />
        </div>
        <div>
          <Label>{W.FIELD_SENDER_EMAIL}</Label>
          <Input
            placeholder={W.FIELD_SENDER_EMAIL_PLACEHOLDER}
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
          <Label>{W.FIELD_FOLDER_PATH}</Label>
          <Input
            placeholder={W.FIELD_FOLDER_PATH_PLACEHOLDER}
            value={cfg.folder_path_starts_with ?? ''}
            onChange={(e) => setCfg('folder_path_starts_with', e.target.value || undefined)}
          />
        </div>
        <div>
          <Label>{W.FIELD_FILENAME_CONTAINS}</Label>
          <Input
            placeholder={W.FIELD_FILENAME_CONTAINS_PLACEHOLDER_SOW}
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
        <Label htmlFor="connector-type">{W.FIELD_CONNECTOR}</Label>
        <Select
          value={cfg.connector_type ?? ''}
          onValueChange={(v) => setCfg('connector_type', v)}
        >
          <SelectTrigger id="connector-type">
            <SelectValue placeholder={W.FIELD_CONNECTOR_PLACEHOLDER} />
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
          <Label>{W.FIELD_CRON}</Label>
          <Input
            placeholder={W.FIELD_CRON_PLACEHOLDER}
            value={cfg.cron ?? ''}
            onChange={(e) => setCfg('cron', e.target.value)}
          />
          <p className="text-xs text-muted-foreground mt-1">
            {W.FIELD_CRON_HINT_PREFIX}
            <code>{W.FIELD_CRON_HINT_EXAMPLE}</code>
            {W.FIELD_CRON_HINT_SUFFIX}
          </p>
        </div>
        <div>
          <Label>{W.FIELD_TIMEZONE}</Label>
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

  return <p className="text-sm text-muted-foreground">{W.NO_CONFIG_MESSAGE}</p>;
}

function StepAction({ state, update, patch }: StepProps) {
  function setCfg(key: string, value: unknown) {
    update('action_config', { ...state.action_config, [key]: value });
  }

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="action-type">{W.FIELD_ACTION}</Label>
        <Select
          value={state.action_type}
          onValueChange={(v) =>
            patch({ action_type: v as ActionType, action_config: {} })
          }
        >
          <SelectTrigger id="action-type">
            <SelectValue placeholder={W.FIELD_ACTION_PLACEHOLDER} />
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
          <Label>{W.FIELD_NOTIFY_EMAILS}</Label>
          <Input
            placeholder={W.FIELD_NOTIFY_EMAILS_PLACEHOLDER}
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
          <Label>{W.FIELD_NOTIFY_CHANNELS}</Label>
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
          <Label>{W.FIELD_COLLISION_WINDOW}</Label>
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
          <Label htmlFor="forward-url">{W.FIELD_FORWARD_URL}</Label>
          <Input
            id="forward-url"
            placeholder={W.FIELD_FORWARD_URL_PLACEHOLDER}
            value={(state.action_config.target_url as string | undefined) ?? ''}
            onChange={(e) => setCfg('target_url', e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{W.FIELD_FORWARD_URL_HINT}</p>
          {/* CIBA-HARDEN-04: worker schema requires hmac_secret_handle for
              FORWARD_TO_URL. Collecting the handle (sm:name) here so the user
              doesn't hit a 400 on save, and so the raw secret never touches
              this UI. */}
          <Label htmlFor="forward-hmac-handle">{W.FIELD_HMAC_HANDLE}</Label>
          <Input
            id="forward-hmac-handle"
            placeholder={W.FIELD_HMAC_HANDLE_PLACEHOLDER}
            value={(state.action_config.hmac_secret_handle as string | undefined) ?? ''}
            onChange={(e) =>
              setCfg('hmac_secret_handle', e.target.value.trim() || undefined)
            }
            data-testid="hmac-handle-input"
          />
          <p className="text-xs text-muted-foreground">{W.FIELD_HMAC_HANDLE_HINT}</p>
        </div>
      )}
    </div>
  );
}

function StepReview({ state }: StepProps) {
  const triggerCount = Object.keys(state.trigger_config).length;
  const actionCount = Object.keys(state.action_config).length;
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="text-muted-foreground">{W.REVIEW_NAME}</dt>
          <dd className="font-medium">{state.name || '—'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{W.REVIEW_STATUS_ON_SAVE}</dt>
          <dd>
            <Badge variant="outline">{W.REVIEW_STATUS_DISABLED}</Badge>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{W.REVIEW_TRIGGER}</dt>
          <dd>{state.trigger_type ? TRIGGER_COPY[state.trigger_type].label : '—'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{W.REVIEW_ACTION}</dt>
          <dd>{state.action_type ? ACTION_COPY[state.action_type].label : '—'}</dd>
        </div>
      </dl>

      {(triggerCount > 0 || actionCount > 0) && (
        <div className="text-xs text-muted-foreground">
          {W.REVIEW_CONFIGURED_PREFIX}
          {triggerCount} trigger{triggerCount === 1 ? '' : 's'} / {actionCount} action{actionCount === 1 ? '' : 's'} field{actionCount === 1 ? '' : 's'}
          {W.REVIEW_TRIGGER_RAW_HIDDEN}
        </div>
      )}

      <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900 flex items-start gap-2">
        <Switch checked={false} disabled aria-label="disabled-indicator" />
        <span>{W.REVIEW_DISABLED_BANNER}</span>
      </div>
    </div>
  );
}

export default RuleBuilderPage;
