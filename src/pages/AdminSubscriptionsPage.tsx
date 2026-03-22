/**
 * Admin Subscriptions List Page (SN1)
 *
 * Platform admin page showing all subscriptions with filter and pagination.
 * Click-through from Platform Overview stat cards.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  CreditCard,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  ArrowLeft,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useAdminList } from '@/hooks/useAdminList';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ROUTES } from '@/lib/routes';
import { isPlatformAdmin } from '@/lib/platform';

interface AdminSubscription {
  id: string;
  user_id: string;
  user_email: string | null;
  user_name: string | null;
  plan_id: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  created_at: string;
  plans: { name: string; price_cents: number } | null;
}

export function AdminSubscriptionsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { items, total, page, limit, loading, error, fetchList } = useAdminList<AdminSubscription>('/api/admin/subscriptions');

  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || 'ALL');

  const isAdmin = isPlatformAdmin(user?.email);

  const doFetch = useCallback((p = 1) => {
    fetchList({ page: p, filters: { status: statusFilter === 'ALL' ? '' : statusFilter } });
  }, [fetchList, statusFilter]);

  useEffect(() => {
    if (isAdmin) doFetch(parseInt(searchParams.get('page') ?? '1', 10));
  }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFilterChange = (newStatus: string) => {
    setStatusFilter(newStatus);
    const filterValue = newStatus === 'ALL' ? '' : newStatus;
    setSearchParams({ status: filterValue, page: '1' });
    fetchList({ page: 1, filters: { status: filterValue } });
  };

  const handlePageChange = (newPage: number) => {
    setSearchParams({ status: statusFilter === 'ALL' ? '' : statusFilter, page: String(newPage) });
    doFetch(newPage);
  };

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  if (!profileLoading && !isAdmin) {
    return (
      <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut}>
        <div className="flex flex-col items-center justify-center py-20">
          <AlertTriangle className="h-8 w-8 text-destructive mb-4" />
          <h2 className="text-xl font-semibold mb-2">Unauthorized</h2>
          <Button variant="outline" onClick={() => navigate(ROUTES.DASHBOARD)}>Back to Dashboard</Button>
        </div>
      </AppShell>
    );
  }

  const totalPages = Math.ceil(total / limit);

  return (
    <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut}>
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate(ROUTES.ADMIN_OVERVIEW)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">All Subscriptions</h1>
          <p className="text-muted-foreground text-sm">{total.toLocaleString()} total subscriptions</p>
        </div>
      </div>

      {/* Filter */}
      <div className="flex gap-3 mb-6">
        <Select value={statusFilter} onValueChange={handleFilterChange}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All Statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="trialing">Trialing</SelectItem>
            <SelectItem value="past_due">Past Due</SelectItem>
            <SelectItem value="canceled">Canceled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700">
          <AlertTriangle className="inline h-4 w-4 mr-2" />
          {error}
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <CreditCard className="h-4 w-4" />
            Subscriptions
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={`skel-${i}`} className="h-12 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No subscriptions found.</p>
          ) : (
            <>
              {/* Mobile card layout */}
              <div className="space-y-3 md:hidden">
                {items.map((s) => (
                  <div key={s.id} className="rounded-lg border p-4">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium">{s.user_name ?? '—'}</span>
                      <SubscriptionStatusBadge status={s.status} />
                    </div>
                    <div className="text-xs text-muted-foreground font-mono mb-2">{s.user_email ?? '—'}</div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <Badge variant="secondary" className="capitalize text-[10px]">
                        {s.plans?.name ?? 'Unknown'}
                      </Badge>
                      <span>
                        {s.current_period_end
                          ? `Ends ${new Date(s.current_period_end).toLocaleDateString()}`
                          : new Date(s.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop table */}
              <div className="overflow-x-auto hidden md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2 pr-4">User</th>
                      <th className="pb-2 pr-4">Plan</th>
                      <th className="pb-2 pr-4">Status</th>
                      <th className="pb-2 pr-4">Period End</th>
                      <th className="pb-2">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((s) => (
                      <tr key={s.id} className="border-b last:border-0 hover:bg-muted/50">
                        <td className="py-3 pr-4">
                          <div className="font-medium text-xs">{s.user_name ?? '—'}</div>
                          <div className="text-xs text-muted-foreground font-mono">{s.user_email ?? '—'}</div>
                        </td>
                        <td className="py-3 pr-4">
                          <Badge variant="secondary" className="capitalize">
                            {s.plans?.name ?? 'Unknown'}
                          </Badge>
                        </td>
                        <td className="py-3 pr-4">
                          <SubscriptionStatusBadge status={s.status} />
                        </td>
                        <td className="py-3 pr-4 text-muted-foreground text-xs">
                          {s.current_period_end
                            ? new Date(s.current_period_end).toLocaleDateString()
                            : '—'}
                        </td>
                        <td className="py-3 text-muted-foreground text-xs">
                          {new Date(s.created_at).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t">
              <p className="text-xs text-muted-foreground">Page {page} of {totalPages}</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => handlePageChange(page - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => handlePageChange(page + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}

function SubscriptionStatusBadge({ status }: Readonly<{ status: string }>) {
  switch (status) {
    case 'active':
      return <Badge className="bg-green-500/10 text-green-700 border-green-500/30">Active</Badge>;
    case 'trialing':
      return <Badge className="bg-blue-500/10 text-blue-700 border-blue-500/30">Trialing</Badge>;
    case 'past_due':
      return <Badge className="bg-amber-500/10 text-amber-700 border-amber-500/30">Past Due</Badge>;
    case 'canceled':
      return <Badge variant="secondary">Canceled</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}
