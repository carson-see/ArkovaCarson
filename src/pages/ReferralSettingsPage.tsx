/**
 * Referral Settings Page — SCRUM-5024, `/settings/referrals`.
 *
 * Wraps `ReferralPanel` in the AppShell. The organization comes from
 * `useActiveOrg()` rather than `profile.org_id` so a user who administers both
 * a parent and a sub-organization sees the one they actually selected
 * (ORG-HIER-01), instead of whichever org the legacy primary column names.
 *
 * ORG_ADMIN gates MINTING only. A member of the organization can still see the
 * code and who joined through it — the code is a shareable string, not a
 * secret, and hiding it from the people asked to share it helps nobody.
 * Authority is re-checked in SQL either way: `ensure_org_referral_code` requires
 * `is_org_admin_of`, so a member who reached the button would still be refused.
 */

import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useActiveOrg } from '@/hooks/useActiveOrg';
import { AppShell } from '@/components/layout';
import { ReferralPanel } from '@/components/org/ReferralPanel';
import { REFERRAL_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';

export function ReferralSettingsPage() {
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { orgId, loading: orgLoading } = useActiveOrg();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  const canManage = profile?.role === 'ORG_ADMIN';

  return (
    <AppShell
      user={user}
      profile={profile}
      profileLoading={profileLoading}
      onSignOut={handleSignOut}
    >
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">{REFERRAL_LABELS.PAGE_TITLE}</h1>
          <p className="text-sm text-muted-foreground">{REFERRAL_LABELS.PAGE_DESCRIPTION}</p>
        </div>
        {/* While memberships resolve, `orgId` is legitimately null. Rendering
            the panel with null would flash "Join or create an organization" at
            a user who has one, so the spinner stays until the answer is real. */}
        {orgLoading ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {REFERRAL_LABELS.PAGE_TITLE}
          </div>
        ) : (
          <ReferralPanel orgId={orgId} canManage={canManage} />
        )}
      </div>
    </AppShell>
  );
}
