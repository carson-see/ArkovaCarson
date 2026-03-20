/**
 * Verification Walkthrough (DEMO-02)
 *
 * Explains Arkova's 3-step verification process:
 * 1. Hash document → fingerprint
 * 2. Find fingerprint + metadata hash on the network (OP_RETURN)
 * 3. Match = verified, no Arkova needed
 *
 * Displayed on the record detail page below the Network Receipt section.
 */

import { Hash, Search, CheckCircle, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { WALKTHROUGH_LABELS } from '@/lib/copy';

interface VerificationWalkthroughProps {
  /** Whether the anchor has metadata anchored alongside the fingerprint */
  hasMetadata?: boolean;
}

const steps = [
  {
    icon: Hash,
    title: WALKTHROUGH_LABELS.STEP_1_TITLE,
    description: WALKTHROUGH_LABELS.STEP_1_DESC,
    color: 'text-blue-600 dark:text-blue-400',
    bg: 'bg-blue-100 dark:bg-blue-900/30',
  },
  {
    icon: Search,
    title: WALKTHROUGH_LABELS.STEP_2_TITLE,
    description: WALKTHROUGH_LABELS.STEP_2_DESC,
    color: 'text-purple-600 dark:text-purple-400',
    bg: 'bg-purple-100 dark:bg-purple-900/30',
  },
  {
    icon: CheckCircle,
    title: WALKTHROUGH_LABELS.STEP_3_TITLE,
    description: WALKTHROUGH_LABELS.STEP_3_DESC,
    color: 'text-green-600 dark:text-green-400',
    bg: 'bg-green-100 dark:bg-green-900/30',
  },
] as const;

export function VerificationWalkthrough({ hasMetadata }: Readonly<VerificationWalkthroughProps>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Info className="h-4 w-4" />
          {WALKTHROUGH_LABELS.TITLE}
        </CardTitle>
        <CardDescription>
          {WALKTHROUGH_LABELS.SUBTITLE}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          {steps.map((step, i) => {
            const StepIcon = step.icon;
            return (
              <div key={step.title} className="flex flex-col items-center text-center space-y-2 p-4 rounded-lg border bg-card">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-bold">
                    {i + 1}
                  </span>
                  <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${step.bg}`}>
                    <StepIcon className={`h-4 w-4 ${step.color}`} />
                  </div>
                </div>
                <p className="text-sm font-semibold">{step.title}</p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {step.description}
                </p>
              </div>
            );
          })}
        </div>
        {hasMetadata && (
          <p className="text-xs text-muted-foreground border-t pt-3">
            {WALKTHROUGH_LABELS.METADATA_NOTE}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
