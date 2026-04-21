import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/routes';

export interface OrgRequiredCardProps {
  title: string;
  description: string;
  ctaLabel: string;
  icon?: ReactNode;
  /** Test ID for querying from tests. */
  'data-testid'?: string;
  /** Optional override for the CTA destination (defaults to the onboarding org route). */
  ctaTo?: string;
}

/**
 * Shown in place of org-scoped UI when the caller is an individual-tier
 * user with no organisation. Standardises the empty-state CTA across
 * org-gated pages — Compliance Scorecard and API Keys both hit the
 * worker's "User must belong to an organization" branch.
 */
export function OrgRequiredCard({
  title,
  description,
  ctaLabel,
  icon,
  ctaTo = ROUTES.ONBOARDING_ORG,
  ...rest
}: Readonly<OrgRequiredCardProps>) {
  return (
    <Card data-testid={rest['data-testid']}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon}
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild>
          <Link to={ctaTo}>{ctaLabel}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
