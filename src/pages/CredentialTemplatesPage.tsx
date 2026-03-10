/**
 * Credential Templates Page
 *
 * Wraps CredentialTemplatesManager in AppShell layout.
 * Uses useCredentialTemplates hook for CRUD operations.
 *
 * @see P5-TS-07
 */

import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useCredentialTemplates } from '@/hooks/useCredentialTemplates';
import { AppShell } from '@/components/layout';
import { CredentialTemplatesManager } from '@/components/credentials';
import { ROUTES } from '@/lib/routes';

export function CredentialTemplatesPage() {
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const navigate = useNavigate();

  const {
    templates,
    loading,
    error,
    createTemplate,
    updateTemplate,
    deleteTemplate,
  } = useCredentialTemplates(profile?.org_id);

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
      <CredentialTemplatesManager
        templates={templates}
        loading={loading}
        error={error}
        onCreate={createTemplate}
        onUpdate={updateTemplate}
        onDelete={deleteTemplate}
      />
    </AppShell>
  );
}
