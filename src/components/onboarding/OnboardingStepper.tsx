/**
 * Onboarding Stepper Component
 *
 * Visual progress indicator for the onboarding flow.
 * Shows numbered steps with active/completed/upcoming states.
 *
 * @see MVP-08
 */

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ONBOARDING_LABELS } from '@/lib/copy';

export interface OnboardingStep {
  readonly label: string;
  readonly description?: string;
}

interface OnboardingStepperProps {
  steps: readonly OnboardingStep[];
  currentStep: number; // 0-indexed
}

export function OnboardingStepper({ steps, currentStep }: Readonly<OnboardingStepperProps>) {
  return (
    <nav aria-label={ONBOARDING_LABELS.STEPPER_ARIA_LABEL} className="w-full">
      <ol className="flex items-center justify-center gap-0">
        {steps.map((step, index) => {
          const isCompleted = index < currentStep;
          const isCurrent = index === currentStep;
          const isLast = index === steps.length - 1;

          return (
            <li
              key={step.label}
              className={cn('flex items-center', !isLast && 'flex-1')}
              {...(isCurrent ? { 'aria-current': 'step' as const } : {})}
            >
              {/* Step indicator */}
              <div className="flex flex-col items-center">
                <div
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors',
                    isCompleted && 'bg-primary text-primary-foreground',
                    isCurrent && 'bg-primary text-primary-foreground ring-4 ring-primary/20',
                    !isCompleted && !isCurrent && 'bg-muted text-muted-foreground'
                  )}
                >
                  {isCompleted ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    index + 1
                  )}
                </div>
                <div className="mt-2 text-center">
                  <p
                    className={cn(
                      'text-xs font-medium',
                      (isCompleted || isCurrent) ? 'text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {step.label}
                  </p>
                  {step.description && (
                    <p className="text-[10px] text-muted-foreground mt-0.5 hidden sm:block">
                      {step.description}
                    </p>
                  )}
                </div>
              </div>

              {/* Connector line */}
              {!isLast && (
                <div
                  className={cn(
                    'mx-2 h-0.5 flex-1 transition-colors',
                    isCompleted ? 'bg-primary' : 'bg-muted'
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
