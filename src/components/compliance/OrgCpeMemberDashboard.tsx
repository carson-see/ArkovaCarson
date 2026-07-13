/**
 * OrgCpeMemberDashboard — CPE-02 (SCRUM-2380) org CPE dashboard MVP.
 *
 * Per-member CPE tiles over EXISTING tables (anchors + profiles) via the live
 * `useOrgCpeMemberSummary` hook — no new table, no migration; the anchors read
 * rides the 0342 partial index. Org admins see every member of their org
 * (RLS org read + query scope); a plain member's query is pinned to their own
 * rows and the card says so.
 *
 * All user-visible strings come from ORG_CPE_DASHBOARD_LABELS in copy.ts.
 */
import { useMemo, useState } from 'react';
import { Users, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { ORG_CPE_DASHBOARD_LABELS } from '@/lib/copy';
import { useOrgCpeMemberSummary } from '@/hooks/useOrgCpeMemberSummary';

const LABELS = ORG_CPE_DASHBOARD_LABELS;

type ReportingPeriod = 'year-to-date' | 'last-90-days' | 'last-12-months' | 'all-time';

function periodStartIso(period: ReportingPeriod): string | null {
  const now = new Date();
  if (period === 'year-to-date') return new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString();
  if (period === 'last-90-days') return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  if (period === 'last-12-months') return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
  return null;
}

function formatActivity(iso: string | null): string {
  if (!iso) return LABELS.NO_ACTIVITY;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return LABELS.NO_ACTIVITY;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export interface OrgCpeMemberDashboardProps {
  orgId: string;
  userId: string;
  isOrgAdmin: boolean;
}

interface TileProps {
  label: string;
  value: number;
  testId: string;
}

function Tile({ label, value, testId }: Readonly<TileProps>) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold text-foreground mt-1" data-testid={testId}>{value}</p>
    </div>
  );
}

export function OrgCpeMemberDashboard({ orgId, userId, isOrgAdmin }: Readonly<OrgCpeMemberDashboardProps>) {
  const [period, setPeriod] = useState<ReportingPeriod>('year-to-date');
  const periodStart = useMemo(() => periodStartIso(period), [period]);
  const { summary, loading, error } = useOrgCpeMemberSummary(orgId, userId, isOrgAdmin, periodStart);

  return (
    <Card className="bg-card border-border" data-testid="org-cpe-member-dashboard">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <CardTitle className="text-lg font-semibold flex items-center gap-2">
              <Users className="h-5 w-5 text-[#00d4ff]" />
              {LABELS.TITLE}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">{LABELS.DESCRIPTION}</p>
            {summary?.scopedToSelf && (
              <p className="text-xs text-muted-foreground mt-1" data-testid="org-cpe-member-scope-note">
                {LABELS.MEMBER_SCOPE_NOTE}
              </p>
            )}
          </div>
          <label
            className="flex flex-col gap-1 text-xs font-medium text-muted-foreground md:min-w-[180px]"
            htmlFor="org-cpe-member-period"
          >
            {LABELS.PERIOD_LABEL}
            <select
              id="org-cpe-member-period"
              value={period}
              onChange={(event) => setPeriod(event.target.value as ReportingPeriod)}
              className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
            >
              <option value="year-to-date">{LABELS.PERIOD_YTD}</option>
              <option value="last-90-days">{LABELS.PERIOD_90_DAYS}</option>
              <option value="last-12-months">{LABELS.PERIOD_12_MONTHS}</option>
              <option value="all-time">{LABELS.PERIOD_ALL_TIME}</option>
            </select>
          </label>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3" role="status" aria-live="polite">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : error ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
          >
            <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
            {LABELS.ERROR}
          </div>
        ) : !summary || summary.rows.length === 0 ? (
          <div className="text-center py-8">
            <Users className="h-10 w-10 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm font-medium text-foreground">{LABELS.EMPTY}</p>
            <p className="text-xs text-muted-foreground mt-1">{LABELS.EMPTY_DESC}</p>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Tile label={LABELS.TILE_MEMBERS} value={summary.totals.members} testId="org-cpe-tile-members" />
              <Tile label={LABELS.TILE_SECURED} value={summary.totals.secured} testId="org-cpe-tile-secured" />
              <Tile label={LABELS.TILE_PENDING} value={summary.totals.pending} testId="org-cpe-tile-pending" />
            </div>

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{LABELS.COL_MEMBER}</TableHead>
                    <TableHead className="text-right">{LABELS.COL_SECURED}</TableHead>
                    <TableHead className="text-right">{LABELS.COL_PENDING}</TableHead>
                    <TableHead className="text-right">{LABELS.COL_LAST_ACTIVITY}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.rows.map((row) => (
                    <TableRow key={row.userId}>
                      <TableCell className="max-w-[240px]">
                        <span className="block truncate font-medium text-foreground">
                          {row.displayName || LABELS.UNKNOWN_MEMBER}
                        </span>
                        {row.identifier && row.identifier !== row.displayName && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {row.identifier}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">{row.securedCount}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{row.pendingCount}</TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground whitespace-nowrap">
                        {formatActivity(row.lastActivity)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Terminal records (revoked/expired/superseded) are counted in
                neither tile — surface them explicitly (round-1 review
                finding 1: no silent omission). Taxonomy matches the
                SECURED-only export gate and the FE-PROOF-GATE contract
                (docs/reference/FE_PROOF_GATE_CONTRACT.md). */}
            {summary.totals.terminal > 0 && (
              <p
                data-testid="org-cpe-terminal-footnote"
                className="text-xs text-muted-foreground border-t border-border pt-3"
              >
                {LABELS.TERMINAL_FOOTNOTE(summary.totals.terminal)}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
