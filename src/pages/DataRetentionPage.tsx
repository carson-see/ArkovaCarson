/**
 * Data Retention Policy Page (COMP-04)
 *
 * Public page at /privacy/data-retention. Per-category retention periods,
 * GDPR Art. 13/14 transparency, right to erasure instructions, legal hold.
 */

import { Link } from 'react-router-dom';
import { Clock, Trash2, Scale, AlertTriangle } from 'lucide-react';
import { ArkovaLogo } from '@/components/layout/ArkovaLogo';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { usePageMeta } from '@/hooks/usePageMeta';
import { DATA_RETENTION_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';

const RETENTION_TABLE = [
  { category: 'Anchor records (fingerprints, status, timestamps)', period: '10 years', basis: 'eIDAS Art. 24(2) — qualified trust service retention', deletion: 'Automated after retention period' },
  { category: 'Signature records', period: '10 years', basis: 'eIDAS Art. 24(2)', deletion: 'Automated after retention period' },
  { category: 'Timestamp tokens (RFC 3161)', period: '10 years', basis: 'eIDAS Art. 24(2)', deletion: 'Automated after retention period' },
  { category: 'Audit events', period: '7 years', basis: 'SOC 2 Trust Services Criteria', deletion: 'Automated after retention period' },
  { category: 'User accounts & profiles', period: 'Until deletion requested', basis: 'GDPR Art. 6(1)(b) — contract performance', deletion: 'Self-service via Settings > Delete Account' },
  { category: 'Organization data', period: 'Until org deletion requested', basis: 'GDPR Art. 6(1)(b)', deletion: 'Admin request or account deletion' },
  { category: 'API keys (hashed)', period: 'Until revoked + 90 days', basis: 'Security audit trail', deletion: 'Automated 90 days after revocation' },
  { category: 'Network anchor records', period: 'Permanent', basis: 'Immutable public ledger', deletion: 'Cannot be deleted (contains no PII)' },
];

export function DataRetentionPage() {
  usePageMeta({
    title: DATA_RETENTION_LABELS.PAGE_TITLE + ' — Arkova',
    description: DATA_RETENTION_LABELS.PAGE_DESCRIPTION,
  });

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-4xl items-center gap-2 px-6 py-4">
          <Link to="/" className="flex items-center gap-2 text-foreground hover:opacity-80 transition-opacity">
            <ArkovaLogo size={32} />
            <span className="font-semibold">Arkova</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight mb-4">{DATA_RETENTION_LABELS.PAGE_TITLE}</h1>
        <p className="text-muted-foreground mb-8">{DATA_RETENTION_LABELS.INTRO}</p>

        {/* Retention Table */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-primary" />
              Retention Periods by Data Category
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 pr-4 font-medium text-muted-foreground">Data Category</th>
                    <th className="text-left py-2 pr-4 font-medium text-muted-foreground">Retention Period</th>
                    <th className="text-left py-2 pr-4 font-medium text-muted-foreground">Legal Basis</th>
                    <th className="text-left py-2 font-medium text-muted-foreground">Deletion Method</th>
                  </tr>
                </thead>
                <tbody>
                  {RETENTION_TABLE.map(row => (
                    <tr key={row.category} className="border-b last:border-0">
                      <td className="py-3 pr-4">{row.category}</td>
                      <td className="py-3 pr-4 font-medium">{row.period}</td>
                      <td className="py-3 pr-4 text-muted-foreground">{row.basis}</td>
                      <td className="py-3 text-muted-foreground">{row.deletion}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Network Note */}
        <Card className="mb-8 border-amber-500/30">
          <CardContent className="pt-6">
            <div className="flex gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-sm text-muted-foreground">{DATA_RETENTION_LABELS.NETWORK_NOTE}</p>
            </div>
          </CardContent>
        </Card>

        {/* Right to Erasure */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-red-400" />
              {DATA_RETENTION_LABELS.ERASURE_TITLE}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{DATA_RETENTION_LABELS.ERASURE_BODY}</p>
          </CardContent>
        </Card>

        {/* Legal Hold */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Scale className="h-5 w-5 text-blue-400" />
              {DATA_RETENTION_LABELS.LEGAL_HOLD_TITLE}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{DATA_RETENTION_LABELS.LEGAL_HOLD_BODY}</p>
          </CardContent>
        </Card>

        {/* Back link */}
        <div className="text-center pt-4 border-t">
          <Link to={ROUTES.PRIVACY} className="text-sm text-primary hover:underline">Back to Privacy Policy</Link>
        </div>
      </main>
    </div>
  );
}
