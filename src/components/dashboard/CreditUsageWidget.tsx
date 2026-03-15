/**
 * Credit Usage Widget
 *
 * Dashboard widget showing credit balance, usage, and cycle info.
 *
 * @see MVP-25
 */

import { Coins, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useCredits } from '@/hooks/useCredits';

export function CreditUsageWidget() {
  const { credits, loading, error } = useCredits();

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-20 mb-2" />
          <Skeleton className="h-2 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (error || !credits) {
    return null;
  }

  const totalAllocation = credits.monthly_allocation + credits.purchased;
  const used = totalAllocation - credits.balance;
  const percentUsed = totalAllocation > 0 ? Math.round((used / totalAllocation) * 100) : 0;

  const daysRemaining = credits.cycle_end
    ? Math.max(0, Math.ceil((new Date(credits.cycle_end).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Coins className="h-4 w-4 text-primary" />
            Credits
          </span>
          <Badge variant="outline" className="text-xs font-normal">
            {credits.plan_name}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold">{credits.balance}</span>
          <span className="text-sm text-muted-foreground">
            / {totalAllocation} remaining
          </span>
        </div>

        <Progress value={percentUsed} className="h-2" />

        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{used} used this period</span>
          {daysRemaining !== null && (
            <span>{daysRemaining} days until reset</span>
          )}
        </div>

        {credits.is_low && (
          <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 rounded px-2 py-1.5">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span>Low credits — consider upgrading your plan</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
