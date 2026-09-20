/**
 * Breadcrumbs Component
 *
 * Shows contextual navigation breadcrumbs based on current route.
 * Detail pages (e.g., /records/:id) show a parent link.
 *
 * @see UF-09
 */

import { Link, useLocation } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { ROUTES } from '@/lib/routes';
import { NAV_POLISH_LABELS } from '@/lib/copy';

interface BreadcrumbSegment {
  label: string;
  to?: string;
}

function getBreadcrumbs(pathname: string): BreadcrumbSegment[] {
  // Record detail page: /records/:id
  if (/^\/records\/[^/]+$/.test(pathname)) {
    return [
      { label: NAV_POLISH_LABELS.BREADCRUMB_RECORDS, to: ROUTES.RECORDS },
      { label: 'Record Details' },
    ];
  }

  // Settings sub-pages
  if (pathname === ROUTES.CREDENTIAL_TEMPLATES) {
    return [
      { label: NAV_POLISH_LABELS.BREADCRUMB_SETTINGS, to: ROUTES.SETTINGS },
      { label: NAV_POLISH_LABELS.BREADCRUMB_CREDENTIAL_TEMPLATES },
    ];
  }
  if (pathname === ROUTES.SETTINGS_WEBHOOKS) {
    return [
      { label: NAV_POLISH_LABELS.BREADCRUMB_SETTINGS, to: ROUTES.SETTINGS },
      { label: NAV_POLISH_LABELS.BREADCRUMB_WEBHOOKS },
    ];
  }
  if (pathname === ROUTES.SETTINGS_API_KEYS) {
    return [
      { label: NAV_POLISH_LABELS.BREADCRUMB_SETTINGS, to: ROUTES.SETTINGS },
      { label: NAV_POLISH_LABELS.BREADCRUMB_API_KEYS },
    ];
  }
  if (pathname === ROUTES.SETTINGS_REFERRALS) {
    return [
      { label: NAV_POLISH_LABELS.BREADCRUMB_SETTINGS, to: ROUTES.SETTINGS },
      { label: NAV_POLISH_LABELS.BREADCRUMB_REFERRALS },
    ];
  }

  // Billing sub-pages
  if (pathname.startsWith('/billing/')) {
    return [
      { label: NAV_POLISH_LABELS.BREADCRUMB_BILLING, to: ROUTES.BILLING },
      { label: pathname.includes('success') ? 'Checkout Complete' : 'Checkout Cancelled' },
    ];
  }

  // Top-level pages: no breadcrumbs (title is sufficient)
  return [];
}

export function Breadcrumbs() {
  const location = useLocation();
  const segments = getBreadcrumbs(location.pathname);

  if (segments.length === 0) return null;

  return (
    <nav aria-label="Breadcrumbs" className="flex items-center gap-1 text-sm">
      {segments.map((segment, idx) => (
        <span key={segment.label} className="flex items-center gap-1">
          {idx > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
          {segment.to ? (
            <Link
              to={segment.to}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              {segment.label}
            </Link>
          ) : (
            <span className="text-foreground font-medium">{segment.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
