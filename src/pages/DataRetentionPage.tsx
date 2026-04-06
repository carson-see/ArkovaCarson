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

const RETENTION_SCHEDULE = [
  {
    category: 'Anchor Records',
    period: 'Indefinite',
    basis: 'eIDAS Art. 24(2) — qualified trust service provider record-keeping',
    deletion: 'No deletion (core proof chain)',
  },
  {
    category: 'Signature Records',
    period: 'Indefinite',
    basis: 'eIDAS Art. 24(2) — qualified electronic signature evidence',
    deletion: 'No deletion (legal evidence)',
  },
  {
    category: 'Timestamp Tokens',
    period: 'Indefinite',
    basis: 'eIDAS Art. 24(2) — qualified timestamp evidence',
    deletion: 'No deletion (legal evidence)',
  },
  {
    category: 'Audit Events',
    period: '7 years',
    basis: 'SOC 2 Type II / SOX Section 802',
    deletion: 'Archival then deletion',
  },
  {
    category: 'Billing Events',
    period: '7 years',
    basis: 'Financial records retention (SOX)',
    deletion: 'Archival then deletion',
  },
  {
    category: 'User Accounts',
    period: 'Until deletion requested',
    basis: 'Service delivery (GDPR Art. 6(1)(b))',
    deletion: 'Anonymization on request',
  },
  {
    category: 'AI Extraction Metadata',
    period: '2 years',
    basis: 'Model improvement and audit trail',
    deletion: 'Archival then deletion',
  },
  {
    category: 'Application Logs',
    period: '1 year',
    basis: 'Operational monitoring',
    deletion: 'Automated deletion',
  },
] as const;

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
          Privacy Policy
        </Link>

        <h1 className="text-3xl font-bold tracking-tight mb-3">{DATA_RETENTION_LABELS.PAGE_TITLE}</h1>
        <p className="text-muted-foreground mb-10">{DATA_RETENTION_LABELS.INTRO}</p>

        {/* Retention Schedule Table */}
        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4">Retention Schedule</h2>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">Data Category</th>
                  <th className="px-4 py-3 text-left font-medium">Retention Period</th>
                  <th className="px-4 py-3 text-left font-medium hidden sm:table-cell">Legal Basis</th>
                  <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Deletion Method</th>
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
          <p className="text-sm text-amber-900 dark:text-amber-200">{DATA_RETENTION_LABELS.NETWORK_NOTE}</p>
        </section>

        {/* Right to Erasure */}
        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-3">{DATA_RETENTION_LABELS.ERASURE_TITLE}</h2>
          <p className="text-sm text-muted-foreground">{DATA_RETENTION_LABELS.ERASURE_BODY}</p>
        </section>

        {/* Legal Hold */}
        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-3">{DATA_RETENTION_LABELS.LEGAL_HOLD_TITLE}</h2>
          <p className="text-sm text-muted-foreground">{DATA_RETENTION_LABELS.LEGAL_HOLD_BODY}</p>
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
