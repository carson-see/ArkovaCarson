/**
 * Billing Overview Component
 *
 * Shows current subscription status and usage.
 * Uses approved terminology per Constitution (Fee Account, not Wallet).
 */

import { CreditCard, FileText, TrendingUp, Calendar, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';

interface BillingInfo {
  plan: {
    name: string;
    price: number;
    period: 'month' | 'year';
    recordsIncluded: number | 'unlimited';
  };
  usage: {
    recordsUsed: number;
    recordsLimit: number | null;
    percentUsed: number;
  };
  billing: {
    nextBillingDate: string;
    paymentMethod: string;
    lastFourDigits: string;
  };
  status: 'active' | 'past_due' | 'canceled';
}

interface BillingOverviewProps {
  billingInfo: BillingInfo | null;
  loading?: boolean;
  onManageBilling?: () => void;
  onUpgrade?: () => void;
}

export function BillingOverview({
  billingInfo,
  loading,
  onManageBilling,
  onUpgrade,
}: Readonly<BillingOverviewProps>) {
  if (loading) {
    return <BillingOverviewSkeleton />;
  }

  if (!billingInfo) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-muted-foreground">No billing information available.</p>
        </CardContent>
      </Card>
    );
  }

  const usagePercent = billingInfo.usage.percentUsed;
  const isNearLimit = usagePercent >= 80;
  const isAtLimit = usagePercent >= 100;

  return (
    <div className="space-y-6">
      {/* Current plan */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-lg">Current Plan</CardTitle>
            <CardDescription>Your subscription details</CardDescription>
          </div>
          <Badge
            variant={
              ({ active: 'success', past_due: 'warning' } as Record<string, 'success' | 'warning'>)[billingInfo.status] ?? 'secondary'
            }
          >
            {({ active: 'Active', past_due: 'Past Due' } as Record<string, string>)[billingInfo.status] ?? 'Canceled'}
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline gap-2 mb-4">
            <span className="text-2xl font-bold">{billingInfo.plan.name}</span>
            <span className="text-muted-foreground">
              ${billingInfo.plan.price}/{billingInfo.plan.period === 'month' ? 'mo' : 'yr'}
            </span>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onManageBilling}>
              Manage Billing
              <ExternalLink className="ml-2 h-3 w-3" />
            </Button>
            <Button size="sm" onClick={onUpgrade}>
              Upgrade Plan
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Usage */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Monthly Usage
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              Records secured
            </span>
            <span className="font-medium">
              {billingInfo.usage.recordsUsed}
              {billingInfo.usage.recordsLimit && ` / ${billingInfo.usage.recordsLimit}`}
            </span>
          </div>

          {billingInfo.usage.recordsLimit && (
            <>
              <Progress
                value={usagePercent}
                className={isAtLimit ? '[&>div]:bg-destructive' : (isNearLimit ? '[&>div]:bg-warning' : '')}
              />
              {isNearLimit && !isAtLimit && (
                <p className="text-xs text-warning">
                  You're approaching your monthly limit. Consider upgrading for more records.
                </p>
              )}
              {isAtLimit && (
                <p className="text-xs text-destructive">
                  You've reached your monthly limit. Upgrade to continue securing documents.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Payment method */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <CreditCard className="h-4 w-4" />
            Fee Account
          </CardTitle>
          <CardDescription>
            Payment method for subscription billing
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-14 items-center justify-center rounded border bg-muted">
                <span className="text-xs font-medium">
                  {billingInfo.billing.paymentMethod.toUpperCase()}
                </span>
              </div>
              <div>
                <p className="text-sm font-medium">
                  **** **** **** {billingInfo.billing.lastFourDigits}
                </p>
                <p className="text-xs text-muted-foreground">
                  Next billing: {formatDate(billingInfo.billing.nextBillingDate)}
                </p>
              </div>
            </div>
            <Button variant="ghost" size="sm">
              Update
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Billing history link */}
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div className="flex items-center gap-3">
          <Calendar className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Billing History</p>
            <p className="text-xs text-muted-foreground">
              View and download past receipts
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm">
          View History
          <ExternalLink className="ml-2 h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

function BillingOverviewSkeleton() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-48" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-8 w-40" />
          <div className="flex gap-2">
            <Skeleton className="h-9 w-28" />
            <Skeleton className="h-9 w-28" />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-28" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-2 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
