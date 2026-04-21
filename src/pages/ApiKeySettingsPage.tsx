/**
 * API Key Settings Page (P4.5-TS-09)
 *
 * Full API key management page with key CRUD and usage dashboard.
 * Calls worker Verification API endpoints via useApiKeys hook.
 *
 * @see P4.5-TS-09, P4.5-TS-10
 */

import { Link, useNavigate } from 'react-router-dom';
import { ExternalLink, BookOpen, Key } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useApiKeys, useApiUsage } from '@/hooks/useApiKeys';
import { AppShell } from '@/components/layout';
import { ApiKeySettings } from '@/components/api/ApiKeySettings';
import { ApiUsageDashboard } from '@/components/api/ApiUsageDashboard';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { OrgRequiredCard } from '@/components/shared/OrgRequiredCard';
import { ROUTES } from '@/lib/routes';
import { DEVELOPER_PAGE_LABELS as L, API_KEY_LABELS } from '@/lib/copy';
import { PUBLIC_API_URL } from '@/lib/workerClient';

export function ApiKeySettingsPage() {
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const navigate = useNavigate();
  // API keys are org-scoped (the worker rejects individual callers with
  // "User must belong to an organization"). Gate the hooks on org
  // membership so we don't burn worker round-trips + Sentry breadcrumbs
  // for every individual-tier visit.
  const isIndividual = !profileLoading && profile !== null && !profile.org_id;
  const orgScoped = !profileLoading && !!profile?.org_id;
  const { keys, loading: keysLoading, error: keysError, createKey, revokeKey, deleteKey } = useApiKeys({ enabled: orgScoped });
  const { usage, loading: usageLoading, error: usageError } = useApiUsage({ enabled: orgScoped });

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
        {/* API Documentation card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-primary" />
              {L.API_DOCS_CARD_TITLE}
            </CardTitle>
            <CardDescription>{L.API_DOCS_CARD_DESC}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <Button asChild>
              <a href={`${PUBLIC_API_URL}/api/docs`} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-2 h-4 w-4" />
                {L.API_DOCS_CARD_BUTTON}
              </a>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link to={ROUTES.DEVELOPERS}>
                {L.API_DOCS_CARD_LINK}
                <ExternalLink className="ml-1.5 h-3 w-3" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        {isIndividual ? (
          <OrgRequiredCard
            data-testid="api-keys-org-required"
            icon={<Key className="h-5 w-5 text-primary" />}
            title={API_KEY_LABELS.ORG_REQUIRED_TITLE}
            description={API_KEY_LABELS.ORG_REQUIRED_BODY}
            ctaLabel={API_KEY_LABELS.ORG_REQUIRED_CTA}
          />
        ) : (
          <>
            <ApiKeySettings
              keys={keys}
              onCreate={createKey}
              onRevoke={revokeKey}
              onDelete={deleteKey}
              loading={keysLoading}
              fetchError={keysError}
            />
            <ApiUsageDashboard
              usage={usage}
              loading={usageLoading}
              error={usageError}
            />
          </>
        )}
      </div>
    </AppShell>
  );
}
