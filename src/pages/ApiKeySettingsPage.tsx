/**
 * API Key Settings Page (P4.5-TS-09)
 *
 * Full API key management page with key CRUD and usage dashboard.
 * Calls worker Verification API endpoints via useApiKeys hook.
 *
 * @see P4.5-TS-09, P4.5-TS-10
 */

import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useApiKeys, useApiUsage } from '@/hooks/useApiKeys';
import { AppShell } from '@/components/layout';
import { ApiKeySettings } from '@/components/api/ApiKeySettings';
import { ApiUsageDashboard } from '@/components/api/ApiUsageDashboard';
import { ROUTES } from '@/lib/routes';

export function ApiKeySettingsPage() {
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const navigate = useNavigate();
  const { keys, loading: keysLoading, createKey, revokeKey, deleteKey } = useApiKeys();
  const { usage, loading: usageLoading, error: usageError } = useApiUsage();

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
      <div className="space-y-8 max-w-4xl mx-auto">
        <ApiKeySettings
          keys={keys}
          onCreate={createKey}
          onRevoke={revokeKey}
          onDelete={deleteKey}
          loading={keysLoading}
        />
        <ApiUsageDashboard
          usage={usage}
          loading={usageLoading}
          error={usageError}
        />
      </div>
    </AppShell>
  );
}
