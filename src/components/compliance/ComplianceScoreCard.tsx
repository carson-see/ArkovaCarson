/**
 * Compliance Score Card — dashboard widget.
 *
 * SCRUM-948: rewired to read from `compliance_audits` (NCA-03) so the
 * widget reflects audit runs done via the "Audit My Organization"
 * button. The legacy `useComplianceScore` path read from the empty
 * `compliance_scores` table and left the widget stuck on the empty
 * state after a Grade A audit completed.
 */

import { Link } from 'react-router-dom';
import { Shield, ArrowRight, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ROUTES } from '@/lib/routes';
import { ComplianceScoreGauge } from './ComplianceScoreGauge';
import { GradeBadge } from './GradeBadge';
import { useLatestComplianceAudit } from '@/hooks/useLatestComplianceAudit';

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function ComplianceScoreCard() {
  const { audit, loading } = useLatestComplianceAudit();

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4 text-[#00d4ff]" />
            Compliance Score
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-16 w-16 rounded-full mx-auto" />
          <Skeleton className="h-4 w-3/4 mx-auto" />
        </CardContent>
      </Card>
    );
  }

  if (!audit) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4 text-[#00d4ff]" />
            Compliance Score
          </CardTitle>
        </CardHeader>
        <CardContent className="text-center space-y-3">
          <p className="text-sm text-muted-foreground">
            No compliance audit yet. Run an audit to see your score.
          </p>
          <Link to={ROUTES.COMPLIANCE_SCORECARD}>
            <Button size="sm" variant="outline" className="gap-1">
              Run Audit <ArrowRight className="h-3 w-3" />
            </Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Shield className="h-4 w-4 text-[#00d4ff]" />
          Compliance Score
          <GradeBadge grade={audit.overall_grade} className="ml-auto" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex justify-center">
          <ComplianceScoreGauge score={audit.overall_score} grade={audit.overall_grade} size="sm" />
        </div>

        {audit.completed_at && (
          <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            Last audited {formatRelative(audit.completed_at)}
          </div>
        )}

        <Link to={ROUTES.COMPLIANCE_SCORECARD} className="block">
          <Button size="sm" variant="ghost" className="w-full gap-1 text-xs">
            View Details <ArrowRight className="h-3 w-3" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}
