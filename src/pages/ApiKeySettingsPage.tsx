/**
 * API Key Settings Page
 *
 * Placeholder page for API key management (P4.5-TS-09 — deferred post-launch).
 * Shows a "coming soon" message until the Verification API is implemented.
 *
 * @see P4.5-TS-09
 */

import { Key } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { AppShell } from '@/components/layout';
import { Card, CardContent } from '@/components/ui/card';
import { API_KEY_LABELS } from '@/lib/copy';

export function ApiKeySettingsPage() {
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();

  return (
    <AppShell
      user={user}
      profile={profile}
      profileLoading={profileLoading}
      onSignOut={signOut}
    >
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Key className="h-6 w-6 text-primary" />
          {API_KEY_LABELS.PAGE_TITLE}
        </h1>
        <p className="text-muted-foreground mt-1">
          {API_KEY_LABELS.PAGE_DESCRIPTION}
        </p>
      </div>

      <Card className="shadow-card-rest">
        <CardContent className="py-12 text-center">
          <Key className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-muted-foreground">
            {API_KEY_LABELS.COMING_SOON}
          </p>
        </CardContent>
      </Card>
    </AppShell>
  );
}
