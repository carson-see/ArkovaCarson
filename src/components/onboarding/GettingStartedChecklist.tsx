/**
 * Getting Started Checklist
 *
 * Role-specific onboarding checklist shown on the dashboard
 * when the user has not yet completed key setup steps.
 * Persisted to localStorage (simple, no migration needed).
 *
 * @see UF-10
 */

import { useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  Circle,
  FileText,
  CreditCard,
  Share2,
  Award,
  X,
  Sparkles,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/routes';
import { ONBOARDING_GUIDANCE_LABELS } from '@/lib/copy';

interface ChecklistItem {
  key: string;
  label: string;
  description: string;
  icon: React.ElementType;
  route: string;
  checkFn: (ctx: ChecklistContext) => boolean;
}

interface ChecklistContext {
  hasRecords: boolean;
  hasTemplates: boolean;
  hasBillingPlan: boolean;
}

interface GettingStartedChecklistProps {
  role: 'ORG_ADMIN' | 'INDIVIDUAL';
  context: ChecklistContext;
}

const STORAGE_KEY = 'arkova_checklist_dismissed';

const orgAdminItems: ChecklistItem[] = [
  {
    key: 'template',
    label: ONBOARDING_GUIDANCE_LABELS.STEP_TEMPLATE,
    description: ONBOARDING_GUIDANCE_LABELS.STEP_TEMPLATE_DESC,
    icon: Award,
    route: ROUTES.CREDENTIAL_TEMPLATES,
    checkFn: (ctx) => ctx.hasTemplates,
  },
  {
    key: 'issue',
    label: ONBOARDING_GUIDANCE_LABELS.STEP_ISSUE,
    description: ONBOARDING_GUIDANCE_LABELS.STEP_ISSUE_DESC,
    icon: FileText,
    route: ROUTES.ORGANIZATION,
    checkFn: (ctx) => ctx.hasRecords,
  },
  {
    key: 'billing',
    label: ONBOARDING_GUIDANCE_LABELS.STEP_BILLING,
    description: ONBOARDING_GUIDANCE_LABELS.STEP_BILLING_DESC,
    icon: CreditCard,
    // Its own description is "Choose a plan to unlock more records", and
    // `checkFn: hasBillingPlan` completes only once the user is ON a plan —
    // so this onboarding step must land on plan selection, not the /billing
    // status summary, which cannot start a purchase.
    route: ROUTES.PRICING,
    checkFn: (ctx) => ctx.hasBillingPlan,
  },
];

const individualItems: ChecklistItem[] = [
  {
    key: 'secure',
    label: ONBOARDING_GUIDANCE_LABELS.STEP_SECURE,
    description: ONBOARDING_GUIDANCE_LABELS.STEP_SECURE_DESC,
    icon: FileText,
    route: ROUTES.DASHBOARD,
    checkFn: (ctx) => ctx.hasRecords,
  },
  {
    key: 'share',
    label: ONBOARDING_GUIDANCE_LABELS.STEP_SHARE,
    description: ONBOARDING_GUIDANCE_LABELS.STEP_SHARE_DESC,
    icon: Share2,
    route: ROUTES.RECORDS,
    checkFn: (ctx) => ctx.hasRecords,
  },
];

export function GettingStartedChecklist({ role, context }: Readonly<GettingStartedChecklistProps>) {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const items = role === 'ORG_ADMIN' ? orgAdminItems : individualItems;

  const completedCount = useMemo(
    () => items.filter((item) => item.checkFn(context)).length,
    [items, context]
  );

  const allComplete = completedCount === items.length;

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
    } catch {
      // localStorage unavailable — dismiss in memory only
    }
  }, []);

  // Don't show if dismissed or all steps complete
  if (dismissed || allComplete) return null;

  return (
    <Card className="shadow-card-rest animate-in-view" data-testid="getting-started">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {ONBOARDING_GUIDANCE_LABELS.CHECKLIST_TITLE}
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={handleDismiss}
            aria-label="Dismiss checklist"
          >
            <X className="h-3 w-3 mr-1" />
            {ONBOARDING_GUIDANCE_LABELS.CHECKLIST_DISMISS}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {completedCount} of {items.length} steps complete
        </p>
        {/* Progress bar */}
        <div className="h-1.5 w-full rounded-full bg-muted mt-2" role="progressbar" aria-valuenow={completedCount} aria-valuemax={items.length}>
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${(completedCount / items.length) * 100}%` }}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-1 pt-0">
        {items.map((item) => {
          const isComplete = item.checkFn(context);
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              onClick={() => !isComplete && navigate(item.route)}
              disabled={isComplete}
              className="flex items-center gap-3 w-full rounded-lg px-3 py-2.5 text-left transition-colors cursor-pointer hover:bg-muted/50 active:bg-muted disabled:opacity-70 disabled:cursor-default disabled:hover:bg-transparent"
            >
              {isComplete ? (
                <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" data-testid="step-complete" />
              ) : (
                <Circle className="h-5 w-5 text-muted-foreground shrink-0" />
              )}
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <p className={`text-sm font-medium ${isComplete ? 'line-through text-muted-foreground' : ''}`}>
                    {item.label}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {item.description}
                  </p>
                </div>
              </div>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}
