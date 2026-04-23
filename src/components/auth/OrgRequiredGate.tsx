/**
 * OrgRequiredGate (UX-03 — SCRUM-1029)
 *
 * Wraps any org-scoped page. When the current profile has no `org_id`,
 * renders a friendly upgrade prompt instead of a raw 403/404. Fixes UAT
 * bugs #1 + #3 from docs/bugs/uat_2026_04_18_product_guide.md.
 */
import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Building2, ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useProfile } from '@/hooks/useProfile';
import { Skeleton } from '@/components/ui/skeleton';

interface OrgRequiredGateProps {
  children: ReactNode;
  /** Short explanation of why an org is needed for this page. */
  explanation?: string;
  /** Override the title shown on the gate card. */
  title?: string;
}

export function OrgRequiredGate({
  children,
  explanation = 'This page is available once you create or join an organization.',
  title = 'Organization required',
}: OrgRequiredGateProps) {
  const { profile, loading } = useProfile();

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl p-6 space-y-3">
        <Skeleton className="h-8 w-3/5" />
        <Skeleton className="h-32" />
      </div>
    );
  }

  if (profile?.org_id) {
    return <>{children}</>;
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-primary/10 p-2">
              <Building2 className="h-5 w-5 text-primary" aria-hidden="true" />
            </div>
            <CardTitle>{title}</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{explanation}</p>
          <div className="flex flex-col sm:flex-row gap-2">
            <Button asChild>
              <Link to="/onboarding/org">
                Create an organization <ArrowRight className="h-4 w-4 ml-1" aria-hidden="true" />
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/onboarding/org?mode=invite">Join with an invite code</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default OrgRequiredGate;
