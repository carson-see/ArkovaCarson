/**
 * Recommendations Card (NCE-10, NCA-FU2 SCRUM-906)
 *
 * Displays Nessie's prioritized compliance action items.
 * Each recommendation links to the anchor-upload flow with pre-filled params.
 */

import { Lightbulb, Upload } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ROUTES } from '@/lib/routes';

interface GapItem {
  type: string;
  requirement: string;
  regulatory_reference: string | null;
  score_impact: number;
  peer_adoption_pct: number | null;
  jurisdiction_code?: string;
  org_has_matching_docs?: number;
}

interface RecommendationsCardProps {
  missingRequired: GapItem[];
  missingRecommended: GapItem[];
  summary: string;
}

function buildUploadUrl(item: GapItem): string {
  const params = new URLSearchParams({ action: 'upload' });
  if (item.type) params.set('credential_type', item.type);
  if (item.jurisdiction_code) params.set('jurisdiction', item.jurisdiction_code);
  return `${ROUTES.RECORDS}?${params.toString()}`;
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
          <Link
            key={`${item.type}-${i}`}
            to={buildUploadUrl(item)}
            className="flex items-start gap-3 p-3 rounded-lg bg-muted/50 hover:bg-muted/80 transition-colors group"
          >
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 text-xs flex items-center justify-center font-medium">
              {i + 1}
            </span>
            <div className="space-y-1 flex-1">
              {item.org_has_matching_docs != null && item.org_has_matching_docs > 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  You have {item.org_has_matching_docs} matching doc{item.org_has_matching_docs > 1 ? 's' : ''} — tag one?
                </p>
              )}
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
            <Upload className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-1" />
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
