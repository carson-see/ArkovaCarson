/**
 * Admin User Detail Page
 *
 * Platform admin page showing individual user profile, records, and subscription info.
 * Accessed via /admin/users/:id from the AdminUsersPage user list.
 */

import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  User,
  Mail,
  Calendar,
  Shield,
  Building2,
  FileText,
  CreditCard,
  AlertTriangle,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ROUTES } from '@/lib/routes';
import { workerFetch } from '@/lib/workerClient';
import { isPlatformAdmin } from '@/lib/platform';

interface UserProfile {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  org_id: string | null;
  created_at: string;
  updated_at: string | null;
}

interface UserRecord {
  id: string;
  public_id: string;
  filename: string;
  credential_type: string;
  status: string;
  created_at: string;
}

interface UserSubscription {
  id: string;
  status: string;
  plan_name: string | null;
  current_period_end: string | null;
}

function RoleBadge({ role }: Readonly<{ role: string }>) {
  switch (role) {
    case 'ORG_ADMIN':
      return <Badge className="bg-blue-500/10 text-blue-700 border-blue-500/30">Org Admin</Badge>;
    case 'ORG_MEMBER':
      return <Badge variant="secondary">Org Member</Badge>;
    case 'INDIVIDUAL':
      return <Badge variant="outline">Individual</Badge>;
    default:
      return <Badge variant="outline">{role}</Badge>;
  }
}

function StatusBadge({ status }: Readonly<{ status: string }>) {
  const colors: Record<string, string> = {
    SECURED: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
    PENDING: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
    SUBMITTED: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
    REVOKED: 'bg-red-500/10 text-red-600 border-red-500/30',
    EXPIRED: 'bg-muted text-muted-foreground',
  };
  return <Badge className={colors[status] ?? ''}>{status}</Badge>;
}

export function AdminUserDetailPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { user: authUser, signOut } = useAuth();
  const { profile: authProfile, loading: profileLoading } = useProfile();

  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [records, setRecords] = useState<UserRecord[]>([]);
  const [subscription, setSubscription] = useState<UserSubscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = isPlatformAdmin(authUser?.email);

  useEffect(() => {
    if (!isAdmin || !id) return;

    setLoading(true);
    setError(null);

    const fetchUserDetail = async () => {
      try {
        const res = await workerFetch(`/api/admin/users/${encodeURIComponent(id)}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: 'Failed to load user' }));
          setError(body.error ?? 'User not found');
          setLoading(false);
          return;
        }
        const data = await res.json();
        setUserProfile(data.user);
        setOrgName(data.user.org_name ?? null);
        setRecords(data.records ?? []);
        setSubscription(data.subscription ?? null);
      } catch {
        setError('Failed to load user details');
      } finally {
        setLoading(false);
      }
    };

    fetchUserDetail();
  }, [isAdmin, id]);

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  if (!profileLoading && !isAdmin) {
    return (
      <AppShell user={authUser} profile={authProfile} profileLoading={profileLoading} onSignOut={handleSignOut}>
        <div className="flex flex-col items-center justify-center py-20 max-w-md mx-auto text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10 mb-4">
            <AlertTriangle className="h-8 w-8 text-destructive" />
          </div>
          <h2 className="text-xl font-semibold mb-2">Access Restricted</h2>
          <p className="text-sm text-muted-foreground mb-2">This page is only available to platform administrators.</p>
          <p className="text-xs text-muted-foreground mb-6">
            If you believe you should have access, contact your organization admin or reach out to support.
          </p>
          <Button variant="outline" onClick={() => navigate(ROUTES.DASHBOARD)}>Back to Dashboard</Button>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell user={authUser} profile={authProfile} profileLoading={profileLoading} onSignOut={handleSignOut}>
      {/* Back nav */}
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate(ROUTES.ADMIN_USERS)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">User Detail</h1>
          {userProfile && (
            <p className="text-muted-foreground text-sm">{userProfile.email}</p>
          )}
        </div>
      </div>

      {loading && (
        <div className="space-y-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {error && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <AlertTriangle className="h-8 w-8 text-destructive mb-4" />
            <h2 className="text-lg font-semibold mb-2">{error}</h2>
            <Button variant="outline" onClick={() => navigate(ROUTES.ADMIN_USERS)}>
              Back to Users
            </Button>
          </CardContent>
        </Card>
      )}

      {userProfile && !loading && (
        <div className="space-y-6">
          {/* Profile Card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <User className="h-4 w-4" />
                Profile
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex items-center gap-3">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Email</p>
                    <p className="text-sm font-mono">{userProfile.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <User className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Name</p>
                    <p className="text-sm">{userProfile.full_name ?? '—'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Shield className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Role</p>
                    <RoleBadge role={userProfile.role} />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Organization</p>
                    <p className="text-sm">{orgName ?? '—'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Joined</p>
                    <p className="text-sm">{new Date(userProfile.created_at).toLocaleDateString('en-US', { dateStyle: 'medium' })}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-muted-foreground break-all">{userProfile.id}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Subscription */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <CreditCard className="h-4 w-4" />
                Subscription
              </CardTitle>
            </CardHeader>
            <CardContent>
              {subscription ? (
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{subscription.plan_name ?? 'Plan'}</p>
                    <Badge variant={subscription.status === 'active' ? 'default' : 'secondary'}>
                      {subscription.status}
                    </Badge>
                  </div>
                  {subscription.current_period_end && (
                    <p className="text-xs text-muted-foreground">
                      Renews: {new Date(subscription.current_period_end).toLocaleDateString()}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No active subscription</p>
              )}
            </CardContent>
          </Card>

          {/* Records */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Records ({records.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {records.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No records found.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="pb-2 pr-4">Name</th>
                        <th className="pb-2 pr-4 hidden sm:table-cell">Type</th>
                        <th className="pb-2 pr-4">Status</th>
                        <th className="pb-2">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.map((r) => (
                        <tr key={r.id} className="border-b last:border-0 hover:bg-muted/50 cursor-pointer" onClick={() => navigate(`/records/${r.id}`)}>
                          <td className="py-3 pr-4">
                            <span className="text-sm">{r.filename}</span>
                            <span className="block text-[10px] text-muted-foreground font-mono">{r.public_id}</span>
                          </td>
                          <td className="py-3 pr-4 hidden sm:table-cell">
                            <Badge variant="secondary" className="text-[10px]">{r.credential_type}</Badge>
                          </td>
                          <td className="py-3 pr-4">
                            <StatusBadge status={r.status} />
                          </td>
                          <td className="py-3 text-muted-foreground text-xs">
                            {new Date(r.created_at).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </AppShell>
  );
}
