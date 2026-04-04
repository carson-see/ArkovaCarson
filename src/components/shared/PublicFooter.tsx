/**
 * Shared Public Footer (GEO-08)
 *
 * Reusable footer for public-facing GEO pages (How It Works, Use Cases, Enterprise).
 * All copy sourced from PUBLIC_FOOTER_LABELS per Constitution 1.3.
 */

import { Link } from 'react-router-dom';
import { ROUTES } from '@/lib/routes';
import { PUBLIC_FOOTER_LABELS } from '@/lib/copy';

const NAV_LINKS = [
  { to: ROUTES.SEARCH, label: PUBLIC_FOOTER_LABELS.NAV_SEARCH },
  { to: ROUTES.VERIFY_FORM, label: PUBLIC_FOOTER_LABELS.NAV_VERIFY },
  { to: ROUTES.HOW_IT_WORKS, label: PUBLIC_FOOTER_LABELS.NAV_HOW_IT_WORKS },
  { to: ROUTES.USE_CASES, label: PUBLIC_FOOTER_LABELS.NAV_USE_CASES },
  { to: ROUTES.ENTERPRISE, label: PUBLIC_FOOTER_LABELS.NAV_ENTERPRISE },
  { to: ROUTES.DEVELOPERS, label: PUBLIC_FOOTER_LABELS.NAV_DEVELOPERS },
  { to: ROUTES.CONTACT, label: PUBLIC_FOOTER_LABELS.NAV_CONTACT },
  { to: ROUTES.PRIVACY, label: PUBLIC_FOOTER_LABELS.NAV_PRIVACY },
  { to: ROUTES.TERMS, label: PUBLIC_FOOTER_LABELS.NAV_TERMS },
] as const;

export function PublicFooter() {
  return (
    <footer className="border-t mt-16">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <nav
          className="flex flex-wrap justify-center gap-6 text-sm text-muted-foreground"
          aria-label="Site navigation"
        >
          {NAV_LINKS.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className="hover:text-primary transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <p className="text-center text-xs text-muted-foreground mt-4">
          &copy; {new Date().getFullYear()} {PUBLIC_FOOTER_LABELS.COPYRIGHT}
        </p>
      </div>
    </footer>
  );
}
