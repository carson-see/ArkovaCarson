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
const L = DATA_RETENTION_LABELS;

const RETENTION_SCHEDULE = [
  { category: L.CAT_ANCHOR_RECORDS, period: L.PERIOD_INDEFINITE, basis: L.BASIS_EIDAS_TSP, deletion: L.DELETION_NO_PROOF },
  { category: L.CAT_SIGNATURE_RECORDS, period: L.PERIOD_INDEFINITE, basis: L.BASIS_EIDAS_SIG, deletion: L.DELETION_NO_LEGAL },
  { category: L.CAT_TIMESTAMP_TOKENS, period: L.PERIOD_INDEFINITE, basis: L.BASIS_EIDAS_TS, deletion: L.DELETION_NO_LEGAL },
  { category: L.CAT_AUDIT_EVENTS, period: L.PERIOD_7_YEARS, basis: L.BASIS_SOC2_SOX, deletion: L.DELETION_ARCHIVE },
  { category: L.CAT_BILLING_EVENTS, period: L.PERIOD_7_YEARS, basis: L.BASIS_SOX_FINANCIAL, deletion: L.DELETION_ARCHIVE },
  { category: L.CAT_USER_ACCOUNTS, period: L.PERIOD_UNTIL_DELETION, basis: L.BASIS_GDPR_SERVICE, deletion: L.DELETION_ANONYMIZE },
  { category: L.CAT_AI_METADATA, period: L.PERIOD_2_YEARS, basis: L.BASIS_AI_AUDIT, deletion: L.DELETION_ARCHIVE },
  { category: L.CAT_APP_LOGS, period: L.PERIOD_1_YEAR, basis: L.BASIS_OPERATIONAL, deletion: L.DELETION_AUTOMATED },
];

export function DataRetentionPage() {
  usePageMeta({
    title: L.PAGE_TITLE + ' — Arkova',
    description: L.PAGE_DESCRIPTION,
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
        <h1 className="text-3xl font-bold tracking-tight mb-4">{L.PAGE_TITLE}</h1>
        <p className="text-muted-foreground mb-8">{L.INTRO}</p>

        {/* Retention Table */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-primary" />
              {L.SECTION_SCHEDULE}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 pr-4 font-medium text-muted-foreground">{L.TABLE_HEADER_CATEGORY}</th>
                    <th className="text-left py-2 pr-4 font-medium text-muted-foreground">{L.TABLE_HEADER_PERIOD}</th>
                    <th className="text-left py-2 pr-4 font-medium text-muted-foreground hidden sm:table-cell">{L.TABLE_HEADER_BASIS}</th>
                    <th className="text-left py-2 font-medium text-muted-foreground hidden md:table-cell">{L.TABLE_HEADER_DELETION}</th>
                  </tr>
                </thead>
                <tbody>
                  {RETENTION_SCHEDULE.map(row => (
                    <tr key={row.category} className="border-b last:border-0">
                      <td className="py-3 pr-4">{row.category}</td>
                      <td className="py-3 pr-4 font-medium">{row.period}</td>
                      <td className="py-3 pr-4 text-muted-foreground hidden sm:table-cell">{row.basis}</td>
                      <td className="py-3 text-muted-foreground hidden md:table-cell">{row.deletion}</td>
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
              <p className="text-sm text-muted-foreground">{L.NETWORK_NOTE}</p>
            </div>
          </CardContent>
        </Card>

        {/* Right to Erasure */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-red-400" />
              {L.ERASURE_TITLE}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{L.ERASURE_BODY}</p>
          </CardContent>
        </Card>

        {/* Legal Hold */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Scale className="h-5 w-5 text-primary" />
              {L.LEGAL_HOLD_TITLE}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{L.LEGAL_HOLD_BODY}</p>
          </CardContent>
        </Card>
      </main>

      <footer className="border-t">
        <div className="mx-auto max-w-4xl px-6 py-6">
          <nav className="flex flex-wrap justify-center gap-4 text-xs text-muted-foreground mb-3" aria-label="Site navigation">
            <Link to="/about" className="hover:text-foreground transition-colors">About</Link>
            <Link to="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
            <Link to="/terms" className="hover:text-foreground transition-colors">Terms</Link>
            <Link to="/contact" className="hover:text-foreground transition-colors">Contact</Link>
          </nav>
          <p className="text-center text-xs text-muted-foreground">&copy; {new Date().getFullYear()} Arkova</p>
        </div>
      </footer>
    </div>
  );
}
