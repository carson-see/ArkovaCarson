/**
 * Admin Onboarding Wizard (UX-01 — SCRUM-1027)
 *
 * Five-step guided path for a first-time organization admin:
 *   1. Welcome
 *   2. Connect one integration (stubbed — deep links to settings; skip OK)
 *   3. Pick a rule template from the gallery
 *   4. Enable the rule (pre-filled, ships disabled per SEC-02)
 *   5. Done
 *
 * POSTs to /api/rules (ARK-105/108). Rules always land disabled; the wizard
 * transitions the admin to the rules list so they consciously flip it on.
 * Each step analytics event fires `onboarding_wizard_step_<n>` so Product
 * can measure the funnel.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  ClipboardCheck,
  FileSignature,
  PartyPopper,
  Plug,
  Users,
} from 'lucide-react';
import { AppShell } from '@/components/layout';
import { OrgRequiredGate } from '@/components/auth/OrgRequiredGate';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { workerFetch } from '@/lib/workerClient';
import { ROUTES } from '@/lib/routes';
import { RULE_TEMPLATES, type RuleTemplate, type TemplateIconName } from '@/lib/ruleTemplates';

const ICONS = {
  FileSignature,
  Users,
  ClipboardCheck,
} as const satisfies Record<TemplateIconName, typeof FileSignature>;

type Step = 1 | 2 | 3 | 4 | 5;

const STEP_LABELS: Record<Step, string> = {
  1: 'Welcome',
  2: 'Connect',
  3: 'Pick a template',
  4: 'Enable',
  5: 'Done',
};

/**
 * Funnel analytics. Replace with the real client later; kept tiny + optional
 * so local dev doesn't need an analytics stub. Uses window.dataLayer if the
 * host page has GTM; otherwise no-op.
 */
function trackStep(step: Step, extra: Record<string, unknown> = {}): void {
  try {
    const w = globalThis as unknown as { dataLayer?: unknown[] };
    w.dataLayer?.push({
      event: `onboarding_wizard_step_${step}`,
      step_label: STEP_LABELS[step],
      ...extra,
    });
  } catch {
    // analytics must never break the flow
  }
}

function WizardInner() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const [step, setStep] = useState<Step>(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected: RuleTemplate | null =
    RULE_TEMPLATES.find((t) => t.id === selectedId) ?? null;

  function goNext(): void {
    trackStep(step, { via: 'next' });
    setStep((s) => (Math.min(s + 1, 5) as Step));
  }
  function goBack(): void {
    setStep((s) => (Math.max(s - 1, 1) as Step));
  }
  function skip(): void {
    trackStep(step, { via: 'skip' });
    setStep((s) => (Math.min(s + 1, 5) as Step));
  }

  async function createRuleFromTemplate(): Promise<void> {
    if (!selected || !profile?.org_id) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await workerFetch('/api/rules', {
        method: 'POST',
        body: JSON.stringify({
          org_id: profile.org_id,
          ...selected.rule,
          // Always ships disabled — the CRUD API forces this server-side too
          // (SEC-02), but we mirror it here so the UI state is honest.
          enabled: false,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(body.error?.message ?? `Request failed (${res.status})`);
      }
      trackStep(4, { template_id: selected.id });
      setStep(5);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create rule');
    } finally {
      setSubmitting(false);
    }
  }

  const progressPct = (step / 5) * 100;

  return (
    <AppShell
      user={user ?? undefined}
      onSignOut={signOut}
      profile={profile ?? undefined}
      profileLoading={profileLoading}
    >
      <div className="mx-auto max-w-3xl p-4 md:p-6 space-y-4 md:space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Welcome to Arkova</h1>
          <p className="text-sm text-muted-foreground">
            Five steps from here to your first live automation. You can skip any step.
          </p>
        </header>

        <div aria-label="Onboarding progress" className="space-y-1">
          <Progress value={progressPct} aria-valuenow={step} aria-valuemin={1} aria-valuemax={5} />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Step {step} of 5 — {STEP_LABELS[step]}</span>
            <span>{Math.round(progressPct)}%</span>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{STEP_LABELS[step]}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {step === 1 && <StepWelcome />}
            {step === 2 && <StepConnect />}
            {step === 3 && (
              <StepTemplates selectedId={selectedId} onSelect={setSelectedId} />
            )}
            {step === 4 && <StepEnable selected={selected} />}
            {step === 5 && <StepDone />}

            {error && (
              <Alert variant="destructive" data-testid="onboarding-error">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pt-4 border-t">
              {step > 1 && step < 5 ? (
                <Button variant="ghost" onClick={goBack}>
                  <ArrowLeft className="h-4 w-4 mr-1" /> Back
                </Button>
              ) : (
                <span />
              )}
              <div className="flex flex-col sm:flex-row gap-2">
                {step < 4 && step > 1 && (
                  <Button variant="outline" onClick={skip}>
                    Skip
                  </Button>
                )}
                {step < 4 && (
                  <Button
                    onClick={goNext}
                    disabled={step === 3 && !selectedId}
                    data-testid="onboarding-next"
                  >
                    Next <ArrowRight className="h-4 w-4 ml-1" />
                  </Button>
                )}
                {step === 4 && (
                  <Button
                    onClick={createRuleFromTemplate}
                    disabled={!selected || submitting}
                    data-testid="onboarding-enable"
                  >
                    {submitting ? 'Creating…' : 'Create rule (disabled)'}
                  </Button>
                )}
                {step === 5 && (
                  <Button onClick={() => navigate(ROUTES.DASHBOARD)}>
                    Go to dashboard <ArrowRight className="h-4 w-4 ml-1" />
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function StepWelcome() {
  return (
    <div className="space-y-3 text-sm">
      <p>
        You have a few minutes. By the end of this wizard, you'll have one rule
        ready to flip on — which is all it takes for Arkova to start anchoring
        your documents automatically.
      </p>
      <p className="text-muted-foreground">
        Nothing you pick here will run until you explicitly enable it. Safe to
        click around.
      </p>
    </div>
  );
}

function StepConnect() {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 text-sm">
        <Plug className="h-5 w-5 text-primary shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <p className="font-medium">Connect your document source</p>
          <p className="text-muted-foreground">
            Rules trigger off events from Google Drive, Microsoft 365, DocuSign,
            or an email intake address. You can connect later from Settings —
            the template in the next step picks the right one for you.
          </p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Integration wiring lives under Settings → Integrations. Skip this step
        if you haven't decided yet.
      </p>
    </div>
  );
}

function StepTemplates({
  selectedId,
  onSelect,
}: Readonly<{
  selectedId: string | null;
  onSelect: (id: string) => void;
}>) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Pick a starter pack. You can customize any rule afterwards.
      </p>
      <div className="grid gap-3 grid-cols-1 md:grid-cols-3">
        {RULE_TEMPLATES.map((t) => {
          const Icon = ICONS[t.icon] ?? FileSignature;
          const active = t.id === selectedId;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelect(t.id)}
              aria-pressed={active}
              className={`text-left rounded-lg border p-4 transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ${
                active
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/60'
              }`}
              data-testid={`template-${t.id}`}
            >
              <div className="flex items-center gap-2 mb-2">
                <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
                <span className="font-medium">{t.title}</span>
              </div>
              <p className="text-xs text-muted-foreground">{t.pitch}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StepEnable({ selected }: Readonly<{ selected: RuleTemplate | null }>) {
  if (!selected) {
    return (
      <p className="text-sm text-muted-foreground">
        Go back and pick a template to continue.
      </p>
    );
  }
  return (
    <div className="space-y-4 text-sm">
      <p>
        We'll create the rule below, but leave it disabled — you'll find it in{' '}
        <strong>Rules</strong> and can toggle it on after one last look.
      </p>
      <div className="rounded-md border p-3 space-y-2">
        <div className="font-medium">{selected.rule.name}</div>
        <p className="text-xs text-muted-foreground">{selected.rule.description}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Badge variant="outline">Trigger: {selected.rule.trigger_type}</Badge>
          <Badge variant="outline">Action: {selected.rule.action_type}</Badge>
          <Badge variant="outline">Disabled on save</Badge>
        </div>
      </div>
    </div>
  );
}

function StepDone() {
  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center gap-2 text-green-700">
        <PartyPopper className="h-5 w-5" aria-hidden="true" />
        <span className="font-medium">Your first rule is in place.</span>
      </div>
      <ul className="space-y-2 list-inside">
        <li className="flex items-start gap-2">
          <CheckCircle className="h-4 w-4 text-green-600 mt-0.5" aria-hidden="true" />
          Open the <strong>Rules</strong> page and flip the toggle on.
        </li>
        <li className="flex items-start gap-2">
          <CheckCircle className="h-4 w-4 text-green-600 mt-0.5" aria-hidden="true" />
          Connect the matching integration under <strong>Settings → Integrations</strong>.
        </li>
        <li className="flex items-start gap-2">
          <CheckCircle className="h-4 w-4 text-green-600 mt-0.5" aria-hidden="true" />
          Invite the teammates who'll review queued docs.
        </li>
      </ul>
    </div>
  );
}

export function AdminOnboardingPage() {
  return (
    <OrgRequiredGate
      title="Onboarding needs an organization"
      explanation="Create or join an organization to start the admin onboarding wizard."
    >
      <WizardInner />
    </OrgRequiredGate>
  );
}

export default AdminOnboardingPage;
