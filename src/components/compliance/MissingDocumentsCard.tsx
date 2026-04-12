/**
 * Missing Documents Card (NCE-10)
 *
 * Shows required documents that the org is missing, with upload CTAs.
 */

import { AlertTriangle, Upload } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/routes';

interface MissingDoc {
  type: string;
  requirement: string;
  regulatory_reference: string | null;
  score_impact: number;
}

interface MissingDocumentsCardProps {
  documents: MissingDoc[];
}

export function MissingDocumentsCard({ documents }: MissingDocumentsCardProps) {
  if (documents.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-emerald-500" />
            Missing Documents
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            All required documents are present. Great work!
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Missing Documents ({documents.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {documents.map((doc) => (
          <div key={doc.type} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
            <div className="space-y-1">
              <p className="text-sm font-medium">{doc.type.replace(/_/g, ' ')}</p>
              {doc.regulatory_reference && (
                <p className="text-xs text-muted-foreground">{doc.regulatory_reference}</p>
              )}
              <p className="text-xs text-amber-600 dark:text-amber-400">+{doc.score_impact} points if uploaded</p>
            </div>
            <Link to={ROUTES.DOCUMENTS}>
              <Button size="sm" variant="outline" className="gap-1">
                <Upload className="h-3 w-3" />
                Upload
              </Button>
            </Link>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
