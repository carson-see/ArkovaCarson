/**
 * Upgrade Prompt Component
 *
 * Shown when a user hits their plan's monthly record limit.
 * Directs them to upgrade via the pricing page.
 *
 * @see CRIT-3 — Entitlement enforcement
 */

import { AlertTriangle, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { ENTITLEMENT_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';

interface UpgradePromptProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recordsUsed: number;
  recordsLimit: number | null;
  planName: string;
}

export function UpgradePrompt({
  open,
  onOpenChange,
  recordsUsed,
  recordsLimit,
  planName,
}: Readonly<UpgradePromptProps>) {
  const navigate = useNavigate();

  const handleUpgrade = () => {
    onOpenChange(false);
    // ROUTES.PRICING, not ROUTES.BILLING: this modal fires at the moment the
    // user is blocked by their quota, so it must land on the page that can
    // actually take payment. /billing is a status summary.
    navigate(ROUTES.PRICING);
  };

  const percentUsed = recordsLimit
    ? Math.min(100, (recordsUsed / recordsLimit) * 100)
    : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            {ENTITLEMENT_LABELS.QUOTA_REACHED_TITLE}
          </DialogTitle>
          <DialogDescription>
            {ENTITLEMENT_LABELS.QUOTA_REACHED_DESCRIPTION}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {planName} Plan
            </span>
            <span className="font-medium">
              {recordsUsed} / {recordsLimit ?? ENTITLEMENT_LABELS.UNLIMITED} {ENTITLEMENT_LABELS.RECORDS_USED}
            </span>
          </div>

          <Progress
            value={percentUsed}
            className="[&>div]:bg-destructive"
          />

          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {ENTITLEMENT_LABELS.QUOTA_REACHED_DESCRIPTION}
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter className="flex gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleUpgrade}>
            {ENTITLEMENT_LABELS.UPGRADE_CTA}
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
