/**
 * CLE Credit Summary Widget
 *
 * Shows CLE credit totals by category for attorneys.
 * Displays compliance status against jurisdiction requirements.
 * Only visible when user has CLE-type anchors.
 */

import { useState, useEffect } from 'react';
import { Scale, CheckCircle, AlertTriangle, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { ROUTES } from '@/lib/routes';

interface CleCredit {
  category: string;
  hours: number;
}

interface CleRequirement {
  total_hours: number;
  ethics_hours: number;
  period_years: number;
}

// Major state CLE requirements (subset — full list on API)
const STATE_REQUIREMENTS: Record<string, CleRequirement> = {
  'California': { total_hours: 25, ethics_hours: 4, period_years: 3 },
  'New York': { total_hours: 24, ethics_hours: 4, period_years: 2 },
  'Texas': { total_hours: 15, ethics_hours: 3, period_years: 1 },
  'Florida': { total_hours: 33, ethics_hours: 5, period_years: 3 },
  'Illinois': { total_hours: 30, ethics_hours: 6, period_years: 2 },
};

export function CleCreditWidget() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [credits, setCredits] = useState<CleCredit[]>([]);
  const [totalHours, setTotalHours] = useState(0);
  const [ethicsHours, setEthicsHours] = useState(0);
  const [loading, setLoading] = useState(true);
  const [hasCle, setHasCle] = useState(false);
  const [jurisdiction, setJurisdiction] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;

    async function fetchCleData() {
      // Check for CLE-type anchors
      // H2: Limit to 500 CLE records — no user needs 500+ displayed
      const { data: anchors } = await supabase
        .from('anchors')
        .select('metadata, credential_type')
        .eq('user_id', user!.id)
        // CLE added in migration 0088 — cast until types regenerated
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .eq('credential_type', 'CLE' as any)
        .is('deleted_at', null)
        .limit(500);

      if (!anchors || anchors.length === 0) {
        setHasCle(false);
        setLoading(false);
        return;
      }

      setHasCle(true);

      // Aggregate credits by category
      const categoryMap: Record<string, number> = {};
      let total = 0;
      let ethics = 0;
      let detectedJurisdiction: string | null = null;

      for (const anchor of anchors) {
        const meta = anchor.metadata as Record<string, unknown> | null;
        if (!meta) continue;

        const hours = Number(meta.credit_hours ?? 0);
        const category = String(meta.credit_category ?? 'General');

        categoryMap[category] = (categoryMap[category] ?? 0) + hours;
        total += hours;

        if (['Ethics', 'Professional Responsibility'].includes(category)) {
          ethics += hours;
        }

        if (meta.jurisdiction && !detectedJurisdiction) {
          detectedJurisdiction = String(meta.jurisdiction);
        }
      }

      setCredits(
        Object.entries(categoryMap)
          .map(([category, hours]) => ({ category, hours }))
          .sort((a, b) => b.hours - a.hours)
      );
      setTotalHours(total);
      setEthicsHours(ethics);
      setJurisdiction(detectedJurisdiction);
      setLoading(false);
    }

    fetchCleData();
  }, [user]);

  // Don't render if user has no CLE records
  if (!loading && !hasCle) return null;

  if (loading) {
    return <Skeleton className="h-[200px] w-full" />;
  }

  // Check compliance
  const req = jurisdiction ? STATE_REQUIREMENTS[jurisdiction] : null;
  const totalProgress = req ? Math.min(100, (totalHours / req.total_hours) * 100) : null;
  const ethicsProgress = req ? Math.min(100, (ethicsHours / req.ethics_hours) * 100) : null;
  const isCompliant = req
    ? totalHours >= req.total_hours && ethicsHours >= req.ethics_hours
    : null;

  return (
    <Card
      className="cursor-pointer hover:bg-muted/50 transition-colors"
      onClick={() => navigate(ROUTES.RECORDS)}
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Scale className="h-4 w-4" />
            CLE Credits
          </span>
          <div className="flex items-center gap-2">
            {isCompliant !== null && (
              <Badge variant={isCompliant ? 'default' : 'destructive'} className="text-[10px]">
                {isCompliant ? (
                  <><CheckCircle className="mr-1 h-3 w-3" />Compliant</>
                ) : (
                  <><AlertTriangle className="mr-1 h-3 w-3" />Deficient</>
                )}
              </Badge>
            )}
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Total hours */}
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span className="text-muted-foreground">Total Hours</span>
            <span className="font-semibold">
              {totalHours}
              {req && <span className="text-muted-foreground font-normal"> / {req.total_hours}</span>}
            </span>
          </div>
          {totalProgress !== null && (
            <Progress value={totalProgress} className="h-2" />
          )}
        </div>

        {/* Ethics hours */}
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span className="text-muted-foreground">Ethics Hours</span>
            <span className="font-semibold">
              {ethicsHours}
              {req && <span className="text-muted-foreground font-normal"> / {req.ethics_hours}</span>}
            </span>
          </div>
          {ethicsProgress !== null && (
            <Progress value={ethicsProgress} className="h-2" />
          )}
        </div>

        {/* Category breakdown */}
        {credits.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {credits.slice(0, 4).map((c) => (
              <Badge key={c.category} variant="outline" className="text-[10px]">
                {c.category}: {c.hours}h
              </Badge>
            ))}
          </div>
        )}

        {jurisdiction && (
          <p className="text-[10px] text-muted-foreground">
            {jurisdiction} requirements ({req?.period_years ?? '?'}-year cycle)
          </p>
        )}
      </CardContent>
    </Card>
  );
}
