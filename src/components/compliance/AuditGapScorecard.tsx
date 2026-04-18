/**
 * Displays compliance audit gaps with filter dropdowns for jurisdiction
 * and gap category. Filters are persisted in the URL via useSearchParams.
 *
 * Jira: SCRUM-893
 */

import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, XCircle, Clock, ShieldAlert, CheckCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export type GapCategory = 'MISSING' | 'EXPIRED' | 'EXPIRING_SOON' | 'INSUFFICIENT';

export interface AuditGap {
  type: string;
  category: GapCategory;
  requirement: string;
  jurisdiction_code: string;
  industry_code: string;
  regulatory_reference: string | null;
  severity: 'critical' | 'high' | 'medium' | 'low';
  remediation_hint: string;
  days_remaining?: number;
  anchor_id?: string;
}

const GAP_CATEGORIES: GapCategory[] = ['MISSING', 'EXPIRED', 'EXPIRING_SOON', 'INSUFFICIENT'];

const CATEGORY_LABELS: Record<GapCategory, string> = {
  MISSING: 'Missing',
  EXPIRED: 'Expired',
  EXPIRING_SOON: 'Expiring Soon',
  INSUFFICIENT: 'Insufficient',
};

const SEVERITY_COLORS: Record<AuditGap['severity'], string> = {
  critical: 'text-red-500 bg-red-500/10 border-red-500/20',
  high: 'text-orange-500 bg-orange-500/10 border-orange-500/20',
  medium: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/20',
  low: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
};

function categoryIcon(category: GapCategory) {
  switch (category) {
    case 'MISSING': return <ShieldAlert className="h-4 w-4 text-red-400" />;
    case 'EXPIRED': return <XCircle className="h-4 w-4 text-orange-400" />;
    case 'EXPIRING_SOON': return <Clock className="h-4 w-4 text-yellow-400" />;
    case 'INSUFFICIENT': return <AlertTriangle className="h-4 w-4 text-red-400" />;
  }
}

interface AuditGapScorecardProps {
  gaps: AuditGap[];
}

export function AuditGapScorecard({ gaps }: AuditGapScorecardProps) {
  const [searchParams, setSearchParams] = useSearchParams();

  const jurisdictionFilter = searchParams.get('jurisdiction') ?? '';
  const gapTypeFilter = searchParams.get('gapType') ?? '';

  const jurisdictions = useMemo(
    () => [...new Set(gaps.map((g) => g.jurisdiction_code))].sort(),
    [gaps],
  );

  const filteredGaps = useMemo(() => {
    let result = gaps;
    if (jurisdictionFilter) {
      result = result.filter((g) => g.jurisdiction_code === jurisdictionFilter);
    }
    if (gapTypeFilter) {
      result = result.filter((g) => g.category === gapTypeFilter);
    }
    return result;
  }, [gaps, jurisdictionFilter, gapTypeFilter]);

  function updateFilter(key: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) {
        next.set(key, value);
      } else {
        next.delete(key);
      }
      return next;
    });
  }

  if (gaps.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6 text-center">
          <CheckCircle className="h-10 w-10 text-green-400 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No compliance gaps detected.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-[#00d4ff]" />
          Compliance Gap Scorecard
          <Badge variant="outline" className="ml-auto text-xs">
            {filteredGaps.length} gap{filteredGaps.length !== 1 ? 's' : ''}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="gap-jurisdiction-filter" className="text-xs font-medium text-muted-foreground">
              Jurisdiction
            </label>
            <select
              id="gap-jurisdiction-filter"
              aria-label="Jurisdiction"
              value={jurisdictionFilter}
              onChange={(e) => updateFilter('jurisdiction', e.target.value)}
              className="text-sm border rounded-md px-2 py-1 bg-background"
            >
              <option value="">All</option>
              {jurisdictions.map((j) => (
                <option key={j} value={j}>{j}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="gap-type-filter" className="text-xs font-medium text-muted-foreground">
              Gap type
            </label>
            <select
              id="gap-type-filter"
              aria-label="Gap type"
              value={gapTypeFilter}
              onChange={(e) => updateFilter('gapType', e.target.value)}
              className="text-sm border rounded-md px-2 py-1 bg-background"
            >
              <option value="">All</option>
              {GAP_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>{CATEGORY_LABELS[cat]}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Gap list */}
        {filteredGaps.length === 0 ? (
          <div className="text-center py-6">
            <p className="text-sm text-muted-foreground">No gaps match the selected filters.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredGaps.map((gap, idx) => (
              <div
                key={`${gap.jurisdiction_code}-${gap.type}-${gap.category}-${idx}`}
                className={cn(
                  'flex items-start gap-3 p-3 rounded-lg border',
                  SEVERITY_COLORS[gap.severity],
                )}
              >
                <div className="shrink-0 mt-0.5">{categoryIcon(gap.category)}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{gap.requirement}</span>
                    <Badge variant="outline" className="text-xs">
                      {gap.jurisdiction_code}
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      {CATEGORY_LABELS[gap.category]}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {gap.remediation_hint}
                  </p>
                  {gap.regulatory_reference && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Ref: {gap.regulatory_reference}
                    </p>
                  )}
                  {gap.days_remaining !== undefined && gap.days_remaining !== null && (
                    <p className="text-xs font-mono mt-0.5">
                      {gap.days_remaining > 0 ? `${gap.days_remaining}d remaining` : `${Math.abs(gap.days_remaining)}d overdue`}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
