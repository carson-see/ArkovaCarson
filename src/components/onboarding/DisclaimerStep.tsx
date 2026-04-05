/**
 * Disclaimer Step Component (SCRUM-362)
 *
 * Shows the platform disclaimer during onboarding.
 * Users must accept the disclaimer before proceeding.
 *
 * @see IDT-01 — Platform disclaimer
 */

import { FileWarning, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { DISCLAIMER_LABELS } from '@/lib/copy';

interface DisclaimerStepProps {
  onAccept: () => void;
  loading: boolean;
}

export function DisclaimerStep({ onAccept, loading }: DisclaimerStepProps) {
  return (
    <Card className="max-w-lg mx-auto">
      <CardHeader>
        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-950/40 mb-4">
          <FileWarning className="h-6 w-6 text-amber-600 dark:text-amber-400" />
        </div>
        <CardTitle>{DISCLAIMER_LABELS.heading}</CardTitle>
        <CardDescription>
          {DISCLAIMER_LABELS.cardDescription}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 p-4">
          <p className="text-sm text-muted-foreground whitespace-pre-line">
            {DISCLAIMER_LABELS.body}
          </p>
        </div>
        <Button
          className="w-full"
          size="lg"
          onClick={onAccept}
          disabled={loading}
        >
          {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {DISCLAIMER_LABELS.acceptButton}
        </Button>
      </CardContent>
    </Card>
  );
}
