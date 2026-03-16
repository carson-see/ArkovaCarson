/**
 * AIReportsPage (P8-S16)
 *
 * Thin page wrapper for the AIReportsPanel component.
 */

import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { AppShell } from '@/components/layout';
import { AIReportsPanel } from '@/components/reports/AIReportsPanel';
import { AI_REPORTS_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';

export function AIReportsPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

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
            {AI_REPORTS_LABELS.PAGE_TITLE}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {AI_REPORTS_LABELS.PAGE_SUBTITLE}
          </p>
        </div>
        <AIReportsPanel />
      </div>
    </AppShell>
  );
}
