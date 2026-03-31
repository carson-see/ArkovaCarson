/**
 * Credit Usage Widget
 *
 * Dashboard widget showing credit balance, usage, and cycle info.
 *
 * @see MVP-25
 */

import { Coins } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Coins className="h-4 w-4 text-primary" />
            Credits
          </span>
          <Badge variant="outline" className="text-xs font-normal">
            Beta
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold">Unlimited</span>
        </div>
        <p className="text-xs text-muted-foreground">
          No credit limits during beta
        </p>
      </CardContent>
    </Card>
  );
}
