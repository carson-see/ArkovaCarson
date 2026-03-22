/**
 * Admin Users List Page (SN1)
 *
 * Platform admin page showing all users with search, filter, and pagination.
 * Click-through from Platform Overview stat cards.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Users,
  Search,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  ArrowLeft,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useAdminList } from '@/hooks/useAdminList';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ROUTES } from '@/lib/routes';

const PLATFORM_ADMIN_EMAILS = ['carson@arkova.ai', 'sarah@arkova.ai'];

interface AdminUser {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  org_id: string | null;
  org_name: string | null;
  created_at: string;
}

export function AdminUsersPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { items, total, page, limit, loading, error, fetchList } = useAdminList<AdminUser>('/api/admin/users');

  const [searchInput, setSearchInput] = useState(searchParams.get('search') ?? '');
  const [roleFilter, setRoleFilter] = useState(searchParams.get('role') ?? '');

  const isAdmin = PLATFORM_ADMIN_EMAILS.includes(user?.email ?? '');

  const doFetch = useCallback((p = 1) => {
    fetchList({ page: p, search: searchInput, filters: { role: roleFilter } });
  }, [fetchList, searchInput, roleFilter]);

  useEffect(() => {
    if (isAdmin) doFetch(parseInt(searchParams.get('page') ?? '1', 10));
  }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = () => {
    setSearchParams({ search: searchInput, role: roleFilter, page: '1' });
    doFetch(1);
  };

  const handlePageChange = (newPage: number) => {
    setSearchParams({ search: searchInput, role: roleFilter, page: String(newPage) });
    doFetch(newPage);
  };

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  if (!profileLoading && !isAdmin) {
    return (
      <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut}>
        <div className="flex flex-col items-center justify-center py-20">
          <AlertTriangle className="h-8 w-8 text-destructive mb-4" />
          <h2 className="text-xl font-semibold mb-2">Unauthorized</h2>
          <Button variant="outline" onClick={() => navigate(ROUTES.DASHBOARD)}>Back to Dashboard</Button>
        </div>
      </AppShell>
    );
  }

  const totalPages = Math.ceil(total / limit);

  return (
    <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut}>
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate(ROUTES.ADMIN_OVERVIEW)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">All Users</h1>
          <p className="text-muted-foreground text-sm">{total.toLocaleString()} total users</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by email or name..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="pl-9"
          />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => { setRoleFilter(e.target.value); }}
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">All Roles</option>
          <option value="INDIVIDUAL">Individual</option>
          <option value="ORG_ADMIN">Org Admin</option>
          <option value="ORG_MEMBER">Org Member</option>
        </select>
        <Button onClick={handleSearch} variant="outline" size="sm" className="h-10">
          Search
        </Button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700">
          <AlertTriangle className="inline h-4 w-4 mr-2" />
          {error}
        </div>
      )}

      {/* Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Users className="h-4 w-4" />
            Users
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={`skel-${i}`} className="h-12 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No users found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 pr-4">Email</th>
                    <th className="pb-2 pr-4 hidden sm:table-cell">Name</th>
                    <th className="pb-2 pr-4 hidden md:table-cell">Role</th>
                    <th className="pb-2 pr-4 hidden lg:table-cell">Organization</th>
                    <th className="pb-2">Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((u) => (
                    <tr key={u.id} className="border-b last:border-0 hover:bg-muted/50 cursor-pointer" onClick={() => navigate(`/admin/users/${u.id}`)}>
                      <td className="py-3 pr-4 font-mono text-xs">{u.email}</td>
                      <td className="py-3 pr-4 hidden sm:table-cell">{u.full_name ?? '—'}</td>
                      <td className="py-3 pr-4 hidden md:table-cell">
                        <RoleBadge role={u.role} />
                      </td>
                      <td className="py-3 pr-4 hidden lg:table-cell text-muted-foreground">
                        {u.org_name ?? '—'}
                      </td>
                      <td className="py-3 text-muted-foreground">
                        {new Date(u.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t">
              <p className="text-xs text-muted-foreground">
                Page {page} of {totalPages}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => handlePageChange(page - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => handlePageChange(page + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}

function RoleBadge({ role }: Readonly<{ role: string }>) {
  switch (role) {
    case 'ORG_ADMIN':
      return <Badge className="bg-blue-500/10 text-blue-700 border-blue-500/30">Admin</Badge>;
    case 'ORG_MEMBER':
      return <Badge variant="secondary">Member</Badge>;
    case 'INDIVIDUAL':
      return <Badge variant="outline">Individual</Badge>;
    default:
      return <Badge variant="outline">{role}</Badge>;
  }
}
