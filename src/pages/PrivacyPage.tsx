/**
 * Privacy Policy Page
 *
 * Public route at /privacy.
 */

import { Link } from 'react-router-dom';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { JurisdictionPrivacyNotices } from '@/components/compliance/JurisdictionPrivacyNotices';
import { DATA_RETENTION_LABELS, LEGAL_PAGE_LABELS, PRIVACY_CONTACT_EMAIL, SUPPORT_CONTACT_EMAIL } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';

import { usePageMeta } from '@/hooks/usePageMeta';

export function PrivacyPage() {
  usePageMeta({
    title: LEGAL_PAGE_LABELS.PRIVACY_PAGE_TITLE,
    description: LEGAL_PAGE_LABELS.PRIVACY_PAGE_DESCRIPTION,
  });

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-6 py-4">
          <Link to="/" className="flex items-center gap-2 text-foreground hover:opacity-80 transition-opacity">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <ArkovaIcon className="h-4 w-4 text-primary" />
            </div>
            <span className="font-semibold">Arkova</span>
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight mb-8">{LEGAL_PAGE_LABELS.PRIVACY_HEADING}</h1>
        <div className="prose prose-neutral dark:prose-invert max-w-none space-y-6 text-sm text-muted-foreground">
          <p className="text-base text-foreground">
            <strong>{LEGAL_PAGE_LABELS.PRIVACY_EFFECTIVE_DATE_LABEL}</strong>{' '}
            {LEGAL_PAGE_LABELS.PRIVACY_EFFECTIVE_DATE}
          </p>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">{LEGAL_PAGE_LABELS.PRIVACY_S1_HEADING}</h2>
            <p>
              {LEGAL_PAGE_LABELS.PRIVACY_S1_BODY_BEFORE_EMPHASIS}{' '}
              <strong>{LEGAL_PAGE_LABELS.PRIVACY_S1_BODY_EMPHASIS}</strong>{' '}
              {LEGAL_PAGE_LABELS.PRIVACY_S1_BODY_AFTER_EMPHASIS}
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">{LEGAL_PAGE_LABELS.PRIVACY_S2_HEADING}</h2>
            <p>{LEGAL_PAGE_LABELS.PRIVACY_S2_BODY}</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">{LEGAL_PAGE_LABELS.PRIVACY_S3_HEADING}</h2>
            <p>{LEGAL_PAGE_LABELS.PRIVACY_S3_BODY}</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">{LEGAL_PAGE_LABELS.PRIVACY_S4_HEADING}</h2>
            <p>{LEGAL_PAGE_LABELS.PRIVACY_S4_BODY}</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">{LEGAL_PAGE_LABELS.PRIVACY_S5_HEADING}</h2>
            {/* S5 transfer basis is counsel-gated (SCRUM-2283) — the rule lives at
                LEGAL_PAGE_LABELS.PRIVACY_S5_TRANSFER_BASIS in copy.ts. */}
            <p>{LEGAL_PAGE_LABELS.PRIVACY_S5_TRANSFER_BASIS}</p>
            <p>{LEGAL_PAGE_LABELS.PRIVACY_S5_REGIONAL_TRANSFERS}</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">{LEGAL_PAGE_LABELS.PRIVACY_S6_HEADING}</h2>
            <p>
              {LEGAL_PAGE_LABELS.PRIVACY_S6_BODY}{' '}
              <a href={`mailto:${SUPPORT_CONTACT_EMAIL}`} className="text-primary hover:underline">
                {SUPPORT_CONTACT_EMAIL}
              </a>.
            </p>
            <p>
              {LEGAL_PAGE_LABELS.PRIVACY_S6_RETENTION_POLICY_PREFIX}{' '}
              <Link to={ROUTES.DATA_RETENTION} className="text-primary hover:underline">
                {DATA_RETENTION_LABELS.PAGE_TITLE}
              </Link>.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">{LEGAL_PAGE_LABELS.PRIVACY_S7_HEADING}</h2>
            <p>
              {LEGAL_PAGE_LABELS.PRIVACY_S7_BODY}{' '}
              <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`} className="text-primary hover:underline">
                {PRIVACY_CONTACT_EMAIL}
              </a>.
            </p>
          </section>

          {/* REG-14: Jurisdiction-Specific Privacy Notices */}
          <div className="pt-6 border-t">
            <JurisdictionPrivacyNotices />
          </div>

          <p className="text-xs pt-6 border-t">
            {LEGAL_PAGE_LABELS.PRIVACY_UPDATE_NOTICE}
          </p>
        </div>
      </main>
      <footer className="border-t">
        <div className="mx-auto max-w-3xl px-6 py-6">
          <nav className="flex flex-wrap justify-center gap-4 text-xs text-muted-foreground mb-3" aria-label="Site navigation">
            <Link to="/about" className="hover:text-foreground transition-colors">About</Link>
            <Link to="/search" className="hover:text-foreground transition-colors">Search Records</Link>
            <Link to="/verify" className="hover:text-foreground transition-colors">Verify</Link>
            <Link to="/developers" className="hover:text-foreground transition-colors">Developers</Link>
            <Link to="/terms" className="hover:text-foreground transition-colors">Terms</Link>
            <Link to="/contact" className="hover:text-foreground transition-colors">Contact</Link>
          </nav>
          <p className="text-center text-xs text-muted-foreground">&copy; {new Date().getFullYear()} Arkova</p>
        </div>
      </footer>
    </div>
  );
}
