/**
 * Data Retention Policy Page (COMP-04)
 *
 * Public page at /privacy/data-retention showing per-category retention periods,
 * right to erasure instructions, and legal hold policy.
 * GDPR Art. 13/14 transparency requirement.
 */

import { Link } from 'react-router-dom';
import { Building2, Shield, Clock, Trash2, Scale } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { usePageMeta } from '@/hooks/usePageMeta';
import { DATA_RETENTION_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';

const RETENTION_TABLE = [
  { category: 'Anchor records', period: '10 years', basis: 'eIDAS Art. 24(2)', method: 'Automated purge after retention period' },
  { category: 'Audit events', period: '7 years', basis: 'SOC 2 CC7.2', method: 'Automated purge after retention period' },
  { category: 'User accounts', period: 'Until deletion requested', basis: 'GDPR Art. 6(1)(b)', method: 'Account deletion via Settings' },
  { category: 'Signature records', period: '10 years', basis: 'eIDAS Art. 24(2)', method: 'Automated purge after retention period' },
  { category: 'Timestamp tokens', period: '10 years', basis: 'ETSI EN 319 421', method: 'Automated purge after retention period' },
  { category: 'API usage logs', period: '90 days', basis: 'Operational necessity', method: 'Rolling deletion' },
  { category: 'Webhook delivery logs', period: '30 days', basis: 'Operational necessity', method: 'Rolling deletion' },
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
            <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-primary/10">
              <Building2 className="h-4 w-4 text-primary" />
            </div>
            <span className="font-semibold">Arkova</span>
          </Link>
          <span className="text-muted-foreground mx-2">/</span>
          <Link to={ROUTES.PRIVACY} className="text-sm text-muted-foreground hover:text-foreground">Privacy</Link>
          <span className="text-muted-foreground mx-2">/</span>
          <span className="text-sm">Data Retention</span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12">
        <div className="mb-10">
          <h1 className="text-3xl font-bold tracking-tight mb-3">{DATA_RETENTION_LABELS.PAGE_TITLE}</h1>
          <p className="text-muted-foreground">{DATA_RETENTION_LABELS.INTRO}</p>
        </div>

        {/* Retention Table */}
        <section className="mb-12">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Clock className="h-5 w-5" /> Retention Periods
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="pb-3 font-medium">Data Category</th>
                      <th className="pb-3 font-medium">Retention Period</th>
                      <th className="pb-3 font-medium">Legal Basis</th>
                      <th className="pb-3 font-medium">Deletion Method</th>
                    </tr>
                  </thead>
                  <tbody>
                    {RETENTION_TABLE.map(row => (
                      <tr key={row.category} className="border-b last:border-0">
                        <td className="py-3 font-medium">{row.category}</td>
                        <td className="py-3 text-muted-foreground">{row.period}</td>
                        <td className="py-3 text-muted-foreground">{row.basis}</td>
                        <td className="py-3 text-muted-foreground">{row.method}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground mt-4 italic">
                {DATA_RETENTION_LABELS.NETWORK_NOTE}
              </p>
            </CardContent>
          </Card>
        </section>

        {/* Right to Erasure */}
        <section className="mb-12">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Trash2 className="h-5 w-5" /> {DATA_RETENTION_LABELS.ERASURE_TITLE}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{DATA_RETENTION_LABELS.ERASURE_BODY}</p>
            </CardContent>
          </Card>
        </section>

        {/* Legal Hold */}
        <section className="mb-12">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Scale className="h-5 w-5" /> {DATA_RETENTION_LABELS.LEGAL_HOLD_TITLE}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{DATA_RETENTION_LABELS.LEGAL_HOLD_BODY}</p>
            </CardContent>
          </Card>
        </section>

        {/* Footer */}
        <footer className="text-center py-8 border-t">
          <div className="flex items-center justify-center gap-4 text-sm text-muted-foreground">
            <Link to={ROUTES.PRIVACY} className="hover:text-foreground flex items-center gap-1">
              <Shield className="h-3.5 w-3.5" /> Privacy Policy
            </Link>
            <span>|</span>
            <Link to={ROUTES.CONTACT} className="hover:text-foreground">
              Contact Us
            </Link>
          </div>
        </footer>
      </main>
    </div>
  );
}
