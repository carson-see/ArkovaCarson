/**
 * Recommendations Card (NCE-10)
 *
 * Displays Nessie's prioritized compliance action items.
 */

import { Lightbulb } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface GapItem {
  type: string;
  requirement: string;
  regulatory_reference: string | null;
  score_impact: number;
  peer_adoption_pct: number | null;
}

interface RecommendationsCardProps {
  missingRequired: GapItem[];
  missingRecommended: GapItem[];
  summary: string;
}

export function RecommendationsCard({ missingRequired, missingRecommended, summary }: RecommendationsCardProps) {
  const allItems = [...missingRequired, ...missingRecommended];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-blue-500" />
          Nessie Recommendations
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{summary}</p>
        {allItems.slice(0, 5).map((item, i) => (
          <div key={`${item.type}-${i}`} className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 text-xs flex items-center justify-center font-medium">
              {i + 1}
            </span>
            <div className="space-y-1">
              <p className="text-sm font-medium">
                Upload {item.type.replace(/_/g, ' ').toLowerCase()}
              </p>
              {item.regulatory_reference && (
                <p className="text-xs text-muted-foreground">{item.regulatory_reference}</p>
              )}
              <div className="flex gap-2 text-xs">
                {item.score_impact > 0 && (
                  <span className="text-emerald-600 dark:text-emerald-400">+{item.score_impact} pts</span>
                )}
                {item.peer_adoption_pct != null && (
                  <span className="text-muted-foreground">{item.peer_adoption_pct}% of peers have this</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
