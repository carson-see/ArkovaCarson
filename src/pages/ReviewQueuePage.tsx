/**
 * ReviewQueuePage (P8-S9)
 *
 * Thin page wrapper for the ReviewQueue component.
 */

import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { AppShell } from '@/components/layout';
import { ReviewQueue } from '@/components/organization/ReviewQueue';
import { REVIEW_QUEUE_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';

export function ReviewQueuePage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  // Redirect non-admins to dashboard
  if (!profileLoading && profile?.role !== 'ORG_ADMIN') {
    return <Navigate to={ROUTES.DASHBOARD} replace />;
  }

  return (
    <AppShell
      user={user}
      profile={profile}
      profileLoading={profileLoading}
      onSignOut={handleSignOut}
    >
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {REVIEW_QUEUE_LABELS.PAGE_TITLE}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {REVIEW_QUEUE_LABELS.PAGE_SUBTITLE}
          </p>
        </div>
        <ReviewQueue />
      </div>
    </AppShell>
  );
}
