/**
 * Data Retention Policy Page (COMP-04)
 *
 * Public page at /privacy/data-retention showing per-data-category
 * retention periods, right to erasure instructions, and legal hold policy.
 * GDPR Art. 13/14 transparency requirement.
 */

import { Link } from 'react-router-dom';
import { Shield, ArrowLeft } from 'lucide-react';
import { usePageMeta } from '@/hooks/usePageMeta';
import { DATA_RETENTION_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';

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
            <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-primary/10">
              <Shield className="h-4 w-4 text-primary" />
            </div>
            <span className="font-semibold">Arkova</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12">
        <Link
          to={ROUTES.PRIVACY}
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {L.PAGE_TITLE}
        </Link>

        <h1 className="text-3xl font-bold tracking-tight mb-3">{L.PAGE_TITLE}</h1>
        <p className="text-muted-foreground mb-10">{L.INTRO}</p>

        {/* Retention Schedule Table */}
        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4">{L.SECTION_SCHEDULE}</h2>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">{L.TABLE_HEADER_CATEGORY}</th>
                  <th className="px-4 py-3 text-left font-medium">{L.TABLE_HEADER_PERIOD}</th>
                  <th className="px-4 py-3 text-left font-medium hidden sm:table-cell">{L.TABLE_HEADER_BASIS}</th>
                  <th className="px-4 py-3 text-left font-medium hidden md:table-cell">{L.TABLE_HEADER_DELETION}</th>
                </tr>
              </thead>
              <tbody>
                {RETENTION_SCHEDULE.map((row) => (
                  <tr key={row.category} className="border-b last:border-b-0">
                    <td className="px-4 py-3 font-medium">{row.category}</td>
                    <td className="px-4 py-3">{row.period}</td>
                    <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{row.basis}</td>
                    <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{row.deletion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Network Permanence Note */}
        <section className="mb-10 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
          <p className="text-sm text-amber-900 dark:text-amber-200">{L.NETWORK_NOTE}</p>
        </section>

        {/* Right to Erasure */}
        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-3">{L.ERASURE_TITLE}</h2>
          <p className="text-sm text-muted-foreground">{L.ERASURE_BODY}</p>
        </section>

        {/* Legal Hold */}
        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-3">{L.LEGAL_HOLD_TITLE}</h2>
          <p className="text-sm text-muted-foreground">{L.LEGAL_HOLD_BODY}</p>
        </section>
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
