/**
 * Compliance Score Card (NCE-12)
 *
 * Summary card for the org dashboard showing compliance score,
 * grade, progress, and expiring documents warning.
 *
 * Jira: SCRUM-603
 */

import { Link } from 'react-router-dom';
import { Shield, ArrowRight, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ROUTES } from '@/lib/routes';
import { ComplianceScoreGauge } from './ComplianceScoreGauge';
import { GradeBadge } from './GradeBadge';
import { useComplianceScore } from '@/hooks/useComplianceScore';

interface ComplianceScoreCardProps {
  jurisdiction?: string;
  industry?: string;
}

export function ComplianceScoreCard({ jurisdiction = 'US-CA', industry = 'accounting' }: ComplianceScoreCardProps) {
  const { scoreData, loading } = useComplianceScore(jurisdiction, industry);

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

  if (!scoreData) {
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
            No compliance data yet. Upload documents to get started.
          </p>
          <Link to={ROUTES.COMPLIANCE_DASHBOARD}>
            <Button size="sm" variant="outline" className="gap-1">
              Set Up <ArrowRight className="h-3 w-3" />
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
          <GradeBadge grade={scoreData.grade} className="ml-auto" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex justify-center">
          <ComplianceScoreGauge score={scoreData.score} grade={scoreData.grade} size="sm" />
        </div>

        {/* Progress bar */}
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{scoreData.total_present} of {scoreData.total_required} documents</span>
            <span>{scoreData.jurisdiction}</span>
          </div>
          <div className="w-full bg-muted rounded-full h-1.5">
            <div
              className="bg-[#00d4ff] h-1.5 rounded-full transition-all"
              style={{ width: `${scoreData.total_required > 0 ? (scoreData.total_present / scoreData.total_required) * 100 : 0}%` }}
            />
          </div>
        </div>

        {/* Expiring warning */}
        {scoreData.expiring_documents.length > 0 && (
          <div className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3 w-3" />
            {scoreData.expiring_documents.length} document{scoreData.expiring_documents.length > 1 ? 's' : ''} expiring soon
          </div>
        )}

        <Link to={ROUTES.COMPLIANCE_DASHBOARD} className="block">
          <Button size="sm" variant="ghost" className="w-full gap-1 text-xs">
            View Details <ArrowRight className="h-3 w-3" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}
