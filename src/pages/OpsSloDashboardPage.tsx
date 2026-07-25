/**
 * Platform SLO Dashboard (SCRUM-2401 / OPS-03)
 *
 * Internal-only, platform-admin-gated. Read-only rollup of four operational
 * SLO surfaces, all sourced from data that already exists (no new schema/
 * migration): anchor secure rate (`get_anchor_status_counts_fast` RPC),
 * connector queue depth (`connector_artifact`), credit-ledger conservation
 * (`org_credit_ledger_divergence` RPC — the SAME query
 * `credit-conservation-reconciler.ts` runs), and webhook delivery success
 * rate (`webhook_delivery_logs`, rolling 24h window).
 *
 * A Sentry alert already fires server-side (credit-conservation-reconciler.ts
 * + the reconciler's Sentry integration) on a credit-ledger divergence; this
 * page's per-surface `breach` badges are a VISUAL surface for the same
 * underlying signals, not a second alerting pipeline.
 *
 * This is a Sprint-4 (OPS-02, the 48h integration soak) entry criterion per
 * the RTE's Sprint-3 disposition (HANDOFF.md 2026-07-06).
 */

import { useCallback, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, RefreshCw, Anchor, ListChecks, Coins, Webhook, Activity } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useOpsSloStats } from '@/hooks/useOpsSloStats';
import { useVisibilityPolling } from '@/hooks/useVisibilityPolling';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ROUTES } from '@/lib/routes';
import { OPS_SLO_LABELS } from '@/lib/copy';
import { isPlatformAdmin } from '@/lib/platform';
import { DataErrorBanner } from '@/components/DataErrorBanner';

const POLL_INTERVAL_MS = 30_000;

function formatCount(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toLocaleString() : '—';
}

function formatPct(value: number | null | undefined): string {
  return typeof value === 'number' ? `${value.toFixed(1)}%` : '—';
}

function SurfaceBadge({ available, breach }: Readonly<{ available: boolean; breach: boolean }>) {
  if (!available) {
    return (
      <Badge variant="outline" className="text-muted-foreground border-border/50 text-[10px]">
        {OPS_SLO_LABELS.UNAVAILABLE}
      </Badge>
    );
  }
  if (breach) {
    return (
      <Badge className="bg-red-500/10 text-red-400 border-red-500/20 text-[10px]" data-testid="slo-breach-badge">
        <AlertTriangle className="h-3 w-3 mr-1" />
        {OPS_SLO_LABELS.BREACH_BADGE}
      </Badge>
    );
  }
  return (
    <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px]">
      <CheckCircle2 className="h-3 w-3 mr-1" />
      {OPS_SLO_LABELS.ALL_CLEAR_BADGE.split(' ')[0]}
    </Badge>
  );
}

/**
 * One SLO surface card. Every surface renders the same scaffold (title + icon,
 * a big value, a health badge, a subtitle) — only the data differs — so the
 * five cards share this single component rather than repeating the markup.
 */
function SloCard({
  testId,
  title,
  icon,
  value,
  available,
  breach,
  subtitle,
}: Readonly<{
  testId: string;
  title: string;
  icon: ReactNode;
  value: string;
  available: boolean;
  breach: boolean;
  subtitle: string;
}>) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between mb-1">
          <span className="text-2xl font-bold font-mono">{value}</span>
          <SurfaceBadge available={available} breach={breach} />
        </div>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </CardContent>
    </Card>
  );
}

export function OpsSloDashboardPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const isAdmin = isPlatformAdmin(profile);
  const { stats, loading, error, refetch } = useOpsSloStats();

  const pollFetch = useCallback(async () => {
    if (!isAdmin) return;
    await refetch();
  }, [isAdmin, refetch]);
  useVisibilityPolling(pollFetch, POLL_INTERVAL_MS);

  const handleRefresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  if (!isAdmin) {
    return (
      <AppShell user={user ?? undefined} onSignOut={signOut} profile={profile ?? undefined} profileLoading={profileLoading}>
        <div className="flex items-center justify-center min-h-[60vh]">
          <Card className="border-[#00d4ff]/10 bg-transparent max-w-md">
            <CardContent className="pt-6 text-center">
              <AlertTriangle className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
              <h2 className="text-lg font-semibold mb-2">{OPS_SLO_LABELS.ACCESS_RESTRICTED_TITLE}</h2>
              <p className="text-sm text-muted-foreground mb-4">{OPS_SLO_LABELS.ACCESS_RESTRICTED_DESC}</p>
              <Button variant="outline" onClick={() => navigate(ROUTES.DASHBOARD)}>
                {OPS_SLO_LABELS.RETURN_TO_DASHBOARD}
              </Button>
            </CardContent>
          </Card>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell user={user ?? undefined} onSignOut={signOut} profile={profile ?? undefined} profileLoading={profileLoading}>
      <div className="space-y-6 p-4 md:p-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold font-display tracking-tight">{OPS_SLO_LABELS.PAGE_TITLE}</h1>
            <p className="text-sm text-muted-foreground mt-1">{OPS_SLO_LABELS.PAGE_DESCRIPTION}</p>
          </div>
          <div className="flex items-center gap-3">
            {stats && (
              stats.overallBreach ? (
                <Badge className="bg-red-500/10 text-red-400 border-red-500/20" data-testid="overall-breach-badge">
                  <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                  {OPS_SLO_LABELS.BREACH_BADGE}
                </Badge>
              ) : (
                <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20" data-testid="overall-healthy-badge">
                  <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                  {OPS_SLO_LABELS.ALL_CLEAR_BADGE}
                </Badge>
              )
            )}
            <Button variant="outline" size="sm" onClick={handleRefresh} disabled={loading} className="border-[#00d4ff]/20">
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              {OPS_SLO_LABELS.REFRESH}
            </Button>
          </div>
        </div>

        {error && (
          <DataErrorBanner
            data-testid="ops-slo-error"
            title={OPS_SLO_LABELS.FETCH_ERROR_TITLE}
            message={error}
            onRetry={handleRefresh}
            retrying={loading}
          />
        )}

        {!stats && loading && (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4" data-testid="ops-slo-loading">
            {[1, 2, 3, 4, 5].map((i) => (
              <Card key={i}>
                <CardHeader className="pb-2">
                  <Skeleton className="h-4 w-24" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-8 w-16 mb-2" />
                  <Skeleton className="h-3 w-32" />
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {!stats && !loading && !error && (
          <div className="flex items-center justify-center py-16 text-sm text-muted-foreground" data-testid="ops-slo-empty">
            {OPS_SLO_LABELS.NO_DATA_YET}
          </div>
        )}

        {stats && (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4" data-testid="ops-slo-cards">
            <SloCard
              testId="slo-card-anchor-secured-rate"
              title={OPS_SLO_LABELS.ANCHOR_SECURED_RATE_TITLE}
              icon={<Anchor className="h-4 w-4 text-muted-foreground" />}
              value={stats.anchorSecuredRate.available ? formatPct(stats.anchorSecuredRate.ratePct) : '—'}
              available={stats.anchorSecuredRate.available}
              breach={stats.anchorSecuredRate.breach}
              subtitle={stats.anchorSecuredRate.available
                ? OPS_SLO_LABELS.ANCHOR_SECURED_RATE_SUBTITLE(
                  formatCount(stats.anchorSecuredRate.securedCount),
                  formatCount(stats.anchorSecuredRate.totalCount),
                )
                : OPS_SLO_LABELS.ANCHOR_SECURED_RATE_UNAVAILABLE}
            />

            <SloCard
              testId="slo-card-connector-queue"
              title={OPS_SLO_LABELS.CONNECTOR_QUEUE_TITLE}
              icon={<ListChecks className="h-4 w-4 text-muted-foreground" />}
              value={stats.connectorQueue.available ? formatCount(stats.connectorQueue.depth) : '—'}
              available={stats.connectorQueue.available}
              breach={stats.connectorQueue.breach}
              subtitle={stats.connectorQueue.available
                ? OPS_SLO_LABELS.CONNECTOR_QUEUE_SUBTITLE(
                  formatCount(stats.connectorQueue.anchored),
                  formatCount(stats.connectorQueue.failed),
                )
                : OPS_SLO_LABELS.CONNECTOR_QUEUE_UNAVAILABLE}
            />

            <SloCard
              testId="slo-card-credit-conservation"
              title={OPS_SLO_LABELS.CREDIT_CONSERVATION_TITLE}
              icon={<Coins className="h-4 w-4 text-muted-foreground" />}
              value={stats.creditConservation.available
                ? (stats.creditConservation.breach
                  ? OPS_SLO_LABELS.CREDIT_CONSERVATION_BREACH(stats.creditConservation.divergedCount ?? 0)
                  : OPS_SLO_LABELS.CREDIT_CONSERVATION_HEALTHY)
                : '—'}
              available={stats.creditConservation.available}
              breach={stats.creditConservation.breach}
              subtitle={stats.creditConservation.available
                ? OPS_SLO_LABELS.CREDIT_CONSERVATION_SUBTITLE(formatCount(stats.creditConservation.orgsChecked))
                : OPS_SLO_LABELS.CREDIT_CONSERVATION_UNAVAILABLE}
            />

            <SloCard
              testId="slo-card-webhook-delivery"
              title={OPS_SLO_LABELS.WEBHOOK_DELIVERY_TITLE}
              icon={<Webhook className="h-4 w-4 text-muted-foreground" />}
              value={stats.webhookDelivery.available ? formatPct(stats.webhookDelivery.ratePct) : '—'}
              available={stats.webhookDelivery.available}
              breach={stats.webhookDelivery.breach}
              subtitle={stats.webhookDelivery.available
                ? OPS_SLO_LABELS.WEBHOOK_DELIVERY_SUBTITLE(
                  formatCount(stats.webhookDelivery.successCount),
                  formatCount(stats.webhookDelivery.totalCount),
                  stats.webhookDelivery.windowHours,
                )
                : OPS_SLO_LABELS.WEBHOOK_DELIVERY_UNAVAILABLE}
            />

            <SloCard
              testId="slo-card-api-errors"
              title={OPS_SLO_LABELS.API_ERRORS_TITLE}
              icon={<Activity className="h-4 w-4 text-muted-foreground" />}
              value={stats.apiErrors.available ? formatPct(stats.apiErrors.errorRatePct) : '—'}
              available={stats.apiErrors.available}
              breach={stats.apiErrors.breach}
              subtitle={stats.apiErrors.available
                ? OPS_SLO_LABELS.API_ERRORS_SUBTITLE(
                  formatCount(stats.apiErrors.errorCount),
                  formatCount(stats.apiErrors.totalCount),
                  stats.apiErrors.windowHours,
                )
                : OPS_SLO_LABELS.API_ERRORS_UNAVAILABLE}
            />
          </div>
        )}

        {stats && (
          <p className="text-xs text-muted-foreground" data-testid="ops-slo-checked-at">
            {OPS_SLO_LABELS.LAST_CHECKED}: {new Date(stats.checkedAt).toLocaleString()}
          </p>
        )}
      </div>
    </AppShell>
  );
}
