/**
 * Organizations List Page
 *
 * Shows all organizations the current user belongs to.
 * Click into an org to see its profile page.
 * Users with no orgs see an empty state with option to create one.
 *
 * Session 10: Fixed Create Organization — opens dialog instead of
 * redirecting to onboarding (which is RouteGuard-blocked for onboarded users).
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Plus, Crown, Shield, User } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useUserOrgs } from '@/hooks/useUserOrgs';
import { AppShell } from '@/components/layout';
import { CreateOrgDialog } from '@/components/organization';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ROUTES, orgProfilePath } from '@/lib/routes';

const ROLE_CONFIG = {
  owner: { label: 'Owner', icon: Crown, variant: 'default' as const },
  admin: { label: 'Admin', icon: Shield, variant: 'secondary' as const },
  member: { label: 'Member', icon: User, variant: 'outline' as const },
} as const;

export function OrganizationsListPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { orgs, loading, refreshOrgs } = useUserOrgs();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  const handleOrgCreated = (orgId: string) => {
    refreshOrgs();
    navigate(orgProfilePath(orgId));
  };

  return (
    <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut}>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Organizations</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {orgs.length > 0 ? `You belong to ${orgs.length} organization${orgs.length > 1 ? 's' : ''}` : 'Manage your organization memberships'}
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)} size="sm">
          <Plus className="mr-2 h-4 w-4" />
          Create Organization
        </Button>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={`org-skel-${i}`} className="h-24 w-full" />
          ))}
        </div>
      ) : orgs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-4">
            <Building2 className="h-8 w-8 text-muted-foreground" />
          </div>
          <h2 className="text-xl font-semibold mb-2">No Organizations</h2>
          <p className="text-sm text-muted-foreground max-w-sm mb-6">
            You are not currently part of any organization. Create one to start sharing verification capabilities with your team.
          </p>
          <Button onClick={() => setCreateDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Create Organization
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {orgs.map((org) => {
            const roleConfig = ROLE_CONFIG[org.role];
            const RoleIcon = roleConfig.icon;
            return (
              <Card
                key={org.orgId}
                className="cursor-pointer hover:bg-muted/50 transition-colors"
                onClick={() => navigate(orgProfilePath(org.orgId))}
              >
                <CardContent className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                        <Building2 className="h-5 w-5 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="font-medium truncate">{org.displayName}</h3>
                        {org.domain && (
                          <p className="text-xs text-muted-foreground truncate">{org.domain}</p>
                        )}
                      </div>
                    </div>
                    <Badge variant={roleConfig.variant} className="shrink-0 ml-2">
                      <RoleIcon className="mr-1 h-3 w-3" />
                      {roleConfig.label}
                    </Badge>
                  </div>

                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    {org.orgPrefix && (
                      <span className="font-mono bg-muted px-1.5 py-0.5 rounded text-[10px]">{org.orgPrefix}</span>
                    )}
                    <span>Joined {new Date(org.joinedAt).toLocaleDateString()}</span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <CreateOrgDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreated={handleOrgCreated}
      />
    </AppShell>
  );
}
