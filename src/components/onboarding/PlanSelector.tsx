/**
 * Plan Selector Component (BUG-1)
 *
 * Allows users to choose their subscription tier during onboarding.
 * During beta, all plans are free (banner shown).
 * Updates profile.subscription_tier on selection.
 */

import { useState } from 'react';
import { ArrowRight, Check, CheckCircle, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { PLAN_SELECTOR_LABELS } from '@/lib/copy';

type PlanOption = 'free' | 'individual' | 'professional';

interface PlanSelectorProps {
  onSelect: (plan: PlanOption) => void;
  loading?: boolean;
}

const PLANS: {
  id: PlanOption;
  name: string;
  desc: string;
  price: string;
  features: string[];
  recommended?: boolean;
}[] = [
  {
    id: 'free',
    name: PLAN_SELECTOR_LABELS.FREE_NAME,
    desc: PLAN_SELECTOR_LABELS.FREE_DESC,
    price: '$0',
    features: [
      PLAN_SELECTOR_LABELS.FREE_RECORDS,
      PLAN_SELECTOR_LABELS.FREE_VERIFICATION,
      PLAN_SELECTOR_LABELS.FREE_PROOF,
    ],
  },
  {
    id: 'individual',
    name: PLAN_SELECTOR_LABELS.INDIVIDUAL_NAME,
    desc: PLAN_SELECTOR_LABELS.INDIVIDUAL_DESC,
    price: PLAN_SELECTOR_LABELS.INDIVIDUAL_PRICE,
    features: [
      PLAN_SELECTOR_LABELS.INDIVIDUAL_RECORDS,
      PLAN_SELECTOR_LABELS.INDIVIDUAL_SUPPORT,
      PLAN_SELECTOR_LABELS.INDIVIDUAL_DOWNLOADS,
    ],
    recommended: true,
  },
  {
    id: 'professional',
    name: PLAN_SELECTOR_LABELS.PROFESSIONAL_NAME,
    desc: PLAN_SELECTOR_LABELS.PROFESSIONAL_DESC,
    price: PLAN_SELECTOR_LABELS.PROFESSIONAL_PRICE,
    features: [
      PLAN_SELECTOR_LABELS.PROFESSIONAL_RECORDS,
      PLAN_SELECTOR_LABELS.PROFESSIONAL_SUPPORT,
      PLAN_SELECTOR_LABELS.PROFESSIONAL_API,
      PLAN_SELECTOR_LABELS.PROFESSIONAL_BULK,
    ],
  },
];

export function PlanSelector({ onSelect, loading = false }: Readonly<PlanSelectorProps>) {
  const [selected, setSelected] = useState<PlanOption>('free');

  const handleContinue = () => {
    onSelect(selected);
  };

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-bold">{PLAN_SELECTOR_LABELS.TITLE}</h1>
        <p className="text-muted-foreground">
          {PLAN_SELECTOR_LABELS.SUBTITLE}
        </p>
      </div>

      {/* Beta banner */}
      <div className="flex items-center justify-center gap-2 rounded-lg bg-primary/5 border border-primary/20 px-4 py-2.5">
        <Sparkles className="h-4 w-4 text-primary shrink-0" />
        <p className="text-sm font-medium text-primary">
          {PLAN_SELECTOR_LABELS.BETA_BANNER}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {PLANS.map((plan) => (
          <Card
            key={plan.id}
            className={cn(
              'cursor-pointer transition-all hover:border-primary/50 relative',
              selected === plan.id && 'border-primary ring-2 ring-primary/20'
            )}
            onClick={() => !loading && setSelected(plan.id)}
          >
            {plan.recommended && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                <span className="bg-primary text-primary-foreground text-xs font-medium px-3 py-1 rounded-full">
                  {PLAN_SELECTOR_LABELS.RECOMMENDED}
                </span>
              </div>
            )}
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">{plan.name}</CardTitle>
                {selected === plan.id && (
                  <CheckCircle className="h-5 w-5 text-primary" />
                )}
              </div>
              <CardDescription>{plan.desc}</CardDescription>
              <p className="text-2xl font-bold mt-2">
                {plan.price === '$0' ? (
                  '$0'
                ) : (
                  <>
                    <span className="text-muted-foreground line-through">{plan.price}</span>
                    <span className="text-primary ml-2">$0</span>
                    <span className="text-sm font-normal text-muted-foreground ml-1">beta</span>
                  </>
                )}
              </p>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm text-muted-foreground">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-primary shrink-0" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>

      <Button
        className="w-full"
        size="lg"
        onClick={handleContinue}
        disabled={loading}
      >
        {loading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Setting up...
          </>
        ) : (
          <>
            {PLAN_SELECTOR_LABELS.CONTINUE}
            <ArrowRight className="ml-2 h-4 w-4" />
          </>
        )}
      </Button>
    </div>
  );
}
