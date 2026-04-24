/**
 * Plan Selector Component (BUG-1)
 *
 * Allows individual users to choose their free or verified tier during onboarding.
 * Updates profile.subscription_tier on selection via set_onboarding_plan RPC.
 */

import { useState } from 'react';
import { ArrowRight, Check, CheckCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  INDIVIDUAL_ONBOARDING_PLANS,
  type IndividualOnboardingPlanId,
} from '@/lib/onboardingPlans';

interface PlanSelectorProps {
  onSelect: (plan: IndividualOnboardingPlanId) => void;
  loading?: boolean;
}

export function PlanSelector({ onSelect, loading = false }: Readonly<PlanSelectorProps>) {
  const [selected, setSelected] = useState<IndividualOnboardingPlanId>('free');

  const handleContinue = () => {
    onSelect(selected);
  };

  const handleCardSelect = (planId: IndividualOnboardingPlanId) => {
    if (!loading) setSelected(planId);
  };

  const handleCardKeyDown = (e: React.KeyboardEvent, planId: IndividualOnboardingPlanId) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      handleCardSelect(planId);
    }
  };

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-bold">Choose your individual plan</h1>
        <p className="text-muted-foreground">
          Pick the monthly anchor limit and trust badge that fit how you use Arkova.
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3" role="radiogroup" aria-label="Choose your individual plan">
        {INDIVIDUAL_ONBOARDING_PLANS.map((plan) => (
          <Card
            key={plan.id}
            role="radio"
            aria-checked={selected === plan.id}
            tabIndex={0}
            className={cn(
              'cursor-pointer transition-all hover:border-primary/50 relative',
              selected === plan.id && 'border-primary ring-2 ring-primary/20'
            )}
            onClick={() => handleCardSelect(plan.id)}
            onKeyDown={(e) => handleCardKeyDown(e, plan.id)}
          >
            {plan.recommended && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                <span className="bg-primary text-primary-foreground text-xs font-medium px-3 py-1 rounded-full">
                  Recommended
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
              <CardDescription>{plan.description}</CardDescription>
              <p className="text-2xl font-bold mt-2">
                {plan.priceLabel}
                {plan.cadenceLabel && (
                  <span className="text-sm font-normal text-muted-foreground ml-1">{plan.cadenceLabel}</span>
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
            Continue
            <ArrowRight className="ml-2 h-4 w-4" />
          </>
        )}
      </Button>
    </div>
  );
}
