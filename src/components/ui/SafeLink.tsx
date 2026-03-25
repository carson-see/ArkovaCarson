/**
 * SEC-007: SafeLink component — wraps <a> with URL validation.
 *
 * Prevents XSS via javascript: URIs by validating href before rendering.
 * Drop-in replacement for <a> in cases with dynamic href values.
 */

import React from 'react';
import { isSafeUrl } from '@/lib/urlValidator';

type SafeLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string | undefined | null;
  children: React.ReactNode;
};

export function SafeLink({ href, children, ...rest }: SafeLinkProps) {
  const safeHref = href && isSafeUrl(href) ? href : undefined;

  if (!safeHref) {
    // Render as a span if the URL is unsafe — prevents click navigation
    return <span {...(rest as React.HTMLAttributes<HTMLSpanElement>)}>{children}</span>;
  }

  return (
    <a href={safeHref} {...rest}>
      {children}
    </a>
  );
}
