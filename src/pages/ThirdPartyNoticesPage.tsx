/**
 * Third-Party Notices Page
 *
 * Public route at /legal/third-party-notices. Discharges the NOTICE
 * obligations of the open-source components shipped in the Arkova frontend
 * bundle — most importantly libheif-js (LGPL-3.0), used for client-side
 * HEIC/HEIF image support. An unreachable notices page does not satisfy
 * these obligations, so this page is linked from the public footer
 * (src/components/shared/PublicFooter.tsx).
 *
 * Data source: src/data/thirdPartyNotices.generated.json, produced by
 * `npm run license:notices:generate` (scripts/security/generate-third-party-notices.ts).
 * Do not hand-edit the generated file — regenerate it instead.
 */

import { Link } from 'react-router-dom';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { THIRD_PARTY_NOTICES_LABELS } from '@/lib/copy';
import { usePageMeta } from '@/hooks/usePageMeta';
import thirdPartyNotices from '@/data/thirdPartyNotices.generated.json';

interface GeneralNoticeEntry {
  name: string;
  version: string;
  license: string;
  repository?: string;
}

interface CopyleftNoticeEntry extends GeneralNoticeEntry {
  sourceUrl?: string;
  status: 'pending' | 'active';
  statusNote: string;
  unmodified: boolean;
  licenseTextUrls: string[];
  licenseTextNote?: string;
}

const NOTICES = thirdPartyNotices as {
  generatedAt: string;
  generalDependencies: GeneralNoticeEntry[];
  copyleftDependencies: CopyleftNoticeEntry[];
};

export function ThirdPartyNoticesPage() {
  usePageMeta({
    title: THIRD_PARTY_NOTICES_LABELS.PAGE_TITLE,
    description: THIRD_PARTY_NOTICES_LABELS.PAGE_DESCRIPTION,
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
        <h1 className="text-3xl font-bold tracking-tight mb-4">{THIRD_PARTY_NOTICES_LABELS.HEADING}</h1>
        <p className="text-sm text-muted-foreground mb-8">{THIRD_PARTY_NOTICES_LABELS.INTRO}</p>

        {NOTICES.copyleftDependencies.length > 0 && (
          <section className="space-y-4 mb-10">
            <h2 className="text-lg font-semibold text-foreground">
              {THIRD_PARTY_NOTICES_LABELS.COPYLEFT_SECTION_HEADING}
            </h2>
            <p className="text-sm text-muted-foreground">{THIRD_PARTY_NOTICES_LABELS.COPYLEFT_SECTION_INTRO}</p>

            <ul className="space-y-6">
              {NOTICES.copyleftDependencies.map((entry) => (
                <li key={`${entry.name}@${entry.version}`} className="rounded-lg border p-4 text-sm space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-semibold text-foreground">
                      {entry.name}@{entry.version}
                    </span>
                    <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {entry.license}
                    </span>
                    {entry.status === 'pending' && (
                      <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                        {THIRD_PARTY_NOTICES_LABELS.PENDING_BADGE}
                      </span>
                    )}
                  </div>

                  <p className="text-muted-foreground">{entry.statusNote}</p>

                  {entry.unmodified && (
                    <p className="text-muted-foreground">{THIRD_PARTY_NOTICES_LABELS.UNMODIFIED_LABEL}</p>
                  )}

                  <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs">
                    {entry.repository && (
                      <a
                        href={entry.repository}
                        className="text-primary hover:underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {THIRD_PARTY_NOTICES_LABELS.REPOSITORY_LABEL}
                      </a>
                    )}
                    {entry.sourceUrl && (
                      <a
                        href={entry.sourceUrl}
                        className="text-primary hover:underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {THIRD_PARTY_NOTICES_LABELS.SOURCE_LINK_LABEL}
                      </a>
                    )}
                    {entry.licenseTextUrls.map((url) => (
                      <a
                        key={url}
                        href={url}
                        className="text-primary hover:underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {THIRD_PARTY_NOTICES_LABELS.LICENSE_TEXT_LABEL} ({url.replace('https://', '')})
                      </a>
                    ))}
                  </div>

                  {entry.licenseTextNote && (
                    <p className="text-xs text-muted-foreground pt-1">{entry.licenseTextNote}</p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">
            {THIRD_PARTY_NOTICES_LABELS.GENERAL_SECTION_HEADING}
          </h2>
          <p className="text-sm text-muted-foreground">{THIRD_PARTY_NOTICES_LABELS.GENERAL_SECTION_INTRO}</p>

          <div className="rounded-lg border divide-y text-sm">
            {NOTICES.generalDependencies.map((entry) => (
              <div
                key={`${entry.name}@${entry.version}`}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"
              >
                <span className="font-mono text-foreground">
                  {entry.name}@{entry.version}
                </span>
                <span className="text-xs text-muted-foreground">{entry.license}</span>
              </div>
            ))}
          </div>

          <p className="text-xs text-muted-foreground pt-2">
            {THIRD_PARTY_NOTICES_LABELS.GENERATED_AT_PREFIX}: {NOTICES.generatedAt}
          </p>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto max-w-3xl px-6 py-6">
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
