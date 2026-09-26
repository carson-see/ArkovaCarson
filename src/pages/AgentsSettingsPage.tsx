/**
 * Agents Settings Page (SPEC-AGENTS-UI)
 *
 * ComputeID / agent passports (services/worker/src/api/v1/agents.ts,
 * agents-computeid.ts) shipped with zero reachable frontend — an org admin
 * could grant `agents:manage` on an API key but had no way to see which
 * agents existed, their status, or revoke one except by raw curl. PR #3083
 * fixed a real defect where suspending an agent did not deactivate its API
 * keys; that fix is only reachable through this page.
 *
 * Thin pass-through, mirroring ApiKeySettingsPage: the hook owns data +
 * mutations, this page only wires it to the org-gate + AppShell.
 *
 * Scope: management of EXISTING agents only — registration, key minting,
 * and the ComputeID admission flow are separate surfaces (out of scope).
 */

import { useNavigate } from 'react-router-dom';
import { Bot } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useAgents } from '@/hooks/useAgents';
import { AppShell } from '@/components/layout';
import { AgentsSettings } from '@/components/agents/AgentsSettings';
import { OrgRequiredCard } from '@/components/shared/OrgRequiredCard';
import { ROUTES } from '@/lib/routes';
import { AGENT_LABELS } from '@/lib/copy';

export function AgentsSettingsPage() {
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const navigate = useNavigate();

  // Agents are org-scoped (the worker rejects individual callers with
  // "Organization membership required"). Gate the hook on org membership so
  // an individual-tier visit never burns a worker round-trip for data that
  // can never come back non-empty for them.
  const isIndividual = !profileLoading && profile !== null && !profile.org_id;
  const orgScoped = !profileLoading && !!profile?.org_id;
  const { agents, loading, error, suspendAgent, resumeAgent, revokeAgent } = useAgents({ enabled: orgScoped });

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
      <div className="max-w-4xl mx-auto">
        {isIndividual ? (
          <OrgRequiredCard
            data-testid="agents-org-required"
            icon={<Bot className="h-5 w-5 text-primary" />}
            title={AGENT_LABELS.ORG_REQUIRED_TITLE}
            description={AGENT_LABELS.ORG_REQUIRED_BODY}
            ctaLabel={AGENT_LABELS.ORG_REQUIRED_CTA}
          />
        ) : (
          <AgentsSettings
            agents={agents}
            onSuspend={suspendAgent}
            onResume={resumeAgent}
            onRevoke={revokeAgent}
            loading={loading}
            fetchError={error}
          />
        )}
      </div>
    </AppShell>
  );
}
