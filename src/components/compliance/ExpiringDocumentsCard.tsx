/**
 * Expiring Documents Card (NCE-10)
 *
 * Shows documents approaching expiration with urgency indicators.
 */

import { Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface ExpiringDoc {
  type: string;
  anchor_id: string;
  title: string | null;
  expiry_date: string;
  days_remaining: number;
}

interface ExpiringDocumentsCardProps {
  documents: ExpiringDoc[];
}

function urgencyColor(days: number): string {
  if (days <= 7) return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
  if (days <= 30) return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300';
  if (days <= 60) return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300';
  return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
}

export function ExpiringDocumentsCard({ documents }: ExpiringDocumentsCardProps) {
  if (documents.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Expiring Soon
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No documents expiring in the next 90 days.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Clock className="h-4 w-4 text-amber-500" />
          Expiring Soon ({documents.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {documents.map((doc) => (
          <div key={doc.anchor_id} className="flex items-center justify-between p-2 rounded-lg bg-muted/50">
            <div>
              <p className="text-sm font-medium">{doc.title ?? doc.type.replace(/_/g, ' ')}</p>
              <p className="text-xs text-muted-foreground">
                Expires {new Date(doc.expiry_date).toLocaleDateString()}
              </p>
            </div>
            <Badge variant="outline" className={urgencyColor(doc.days_remaining)}>
              {doc.days_remaining}d
            </Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
