/**
 * Admin Organizations Page (SN2)
 *
 * Platform admin page showing all organizations with member count,
 * anchor count, free-tier testing cap, search, and pagination.
 * Click-through to org detail. Platform admins can set each org's free
 * testing allowance inline (SCRUM-2225).
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Building2,
  Search,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  ArrowLeft,
  Users,
  FileText,
  SlidersHorizontal,
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
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { workerFetch } from '@/lib/workerClient';
import { ROUTES } from '@/lib/routes';
import { isPlatformAdmin } from '@/lib/platform';

interface AdminOrganization {
  id: string;
  legal_name: string | null;
  display_name: string;
  domain: string | null;
  org_prefix: string | null;
  verification_status: string;
  member_count: number;
  anchor_count: number;
  is_test: boolean;
  anchor_quota: number | null;
  created_at: string;
}

const DEFAULT_FREE_QUOTA = 10;

export function AdminOrganizationsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { items, total, page, limit, loading, error, fetchList } = useAdminList<AdminOrganization>('/api/admin/organizations');

  const [searchInput, setSearchInput] = useState(searchParams.get('search') ?? '');

  // SCRUM-2225 — free-tier cap editor state.
  const [editingOrg, setEditingOrg] = useState<AdminOrganization | null>(null);
  const [capEnabled, setCapEnabled] = useState(true);
  const [quotaInput, setQuotaInput] = useState(String(DEFAULT_FREE_QUOTA));
  const [saving, setSaving] = useState(false);

  const isAdmin = isPlatformAdmin(profile);

  const doFetch = useCallback((p = 1) => {
    fetchList({ page: p, search: searchInput });
  }, [fetchList, searchInput]);

  useEffect(() => {
    if (isAdmin) doFetch(parseInt(searchParams.get('page') ?? '1', 10));
  }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = () => {
    setSearchParams({ search: searchInput, page: '1' });
    doFetch(1);
  };

  const handlePageChange = (newPage: number) => {
    setSearchParams({ search: searchInput, page: String(newPage) });
    doFetch(newPage);
  };

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  const openCap = (org: AdminOrganization) => {
    setEditingOrg(org);
    setCapEnabled(org.is_test && org.anchor_quota != null);
    setQuotaInput(String(org.anchor_quota ?? DEFAULT_FREE_QUOTA));
  };

  const saveCap = async () => {
    if (!editingOrg) return;
    const quotaNum = parseInt(quotaInput, 10);
    if (capEnabled && (!Number.isInteger(quotaNum) || quotaNum < 0)) {
      toast.error('Enter a whole number of free actions (0 or more).');
      return;
    }
    setSaving(true);
    try {
      const res = await workerFetch(`/api/admin/organizations/${encodeURIComponent(editingOrg.id)}/quota`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          capEnabled
            ? { anchor_quota: quotaNum, is_test: true }
            : { anchor_quota: null, is_test: false },
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to update cap');
        return;
      }
      toast.success(
        capEnabled
          ? `${editingOrg.display_name}: capped at ${quotaNum} free testing action${quotaNum === 1 ? '' : 's'}.`
          : `${editingOrg.display_name}: uncapped (billable).`,
      );
      setEditingOrg(null);
      doFetch(page);
    } catch {
      toast.error('Failed to update cap');
    } finally {
      setSaving(false);
    }
  };

  const renderCap = (org: AdminOrganization) => {
    if (org.is_test && org.anchor_quota != null) {
      const over = org.anchor_count >= org.anchor_quota;
      return (
        <Badge variant={over ? 'destructive' : 'secondary'} className="text-[10px]">
          {org.anchor_count}/{org.anchor_quota} free
        </Badge>
      );
    }
    return <span className="text-xs text-muted-foreground">Uncapped</span>;
  };

  if (!profileLoading && !isAdmin) {
    return (
      <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut}>
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

  const totalPages = Math.ceil(total / limit);

  return (
    <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut}>
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate(ROUTES.ADMIN_OVERVIEW)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">All Organizations</h1>
          <p className="text-muted-foreground text-sm">{total.toLocaleString()} total organizations</p>
        </div>
      </div>

      {/* Search */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or domain..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="pl-9"
          />
        </div>
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

      {/* Organizations */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            Organizations
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={`skel-${i}`} className="h-16 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-muted-foreground">No organizations found.</p>
              {searchInput && (
                <Button variant="link" size="sm" className="mt-2" onClick={() => { setSearchInput(''); setSearchParams({}); fetchList({ page: 1, search: '' }); }}>
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            <>
              {/* Mobile card layout */}
              <div className="space-y-3 md:hidden">
                {items.map((org) => (
                  <div
                    key={org.id}
                    className="rounded-lg border p-4 cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => navigate(`/organizations/${org.id}`)}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium">{org.display_name}</span>
                      {org.org_prefix && (
                        <Badge variant="secondary" className="font-mono text-[10px]">{org.org_prefix}</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {org.member_count}</span>
                      <span className="flex items-center gap-1"><FileText className="h-3 w-3" /> {org.anchor_count}</span>
                      {org.domain && <span>{org.domain}</span>}
                    </div>
                    <div className="flex items-center justify-between mt-2">
                      <span className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Free tier:</span>
                        {renderCap(org)}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7"
                        onClick={(e) => { e.stopPropagation(); openCap(org); }}
                      >
                        <SlidersHorizontal className="h-3.5 w-3.5 mr-1" /> Set cap
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop table */}
              <div className="overflow-x-auto hidden md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2 pr-4">Organization</th>
                      <th className="pb-2 pr-4">Prefix</th>
                      <th className="pb-2 pr-4">Domain</th>
                      <th className="pb-2 pr-4">Members</th>
                      <th className="pb-2 pr-4">Records</th>
                      <th className="pb-2 pr-4">Free tier</th>
                      <th className="pb-2">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((org) => (
                      <tr
                        key={org.id}
                        className="border-b last:border-0 hover:bg-muted/50 cursor-pointer"
                        onClick={() => navigate(`/organizations/${org.id}`)}
                      >
                        <td className="py-3 pr-4">
                          <div className="font-medium">{org.display_name}</div>
                          {org.legal_name && org.legal_name !== org.display_name && (
                            <div className="text-xs text-muted-foreground">{org.legal_name}</div>
                          )}
                        </td>
                        <td className="py-3 pr-4">
                          {org.org_prefix ? (
                            <Badge variant="secondary" className="font-mono text-[10px]">{org.org_prefix}</Badge>
                          ) : '—'}
                        </td>
                        <td className="py-3 pr-4 text-muted-foreground">
                          {org.domain ?? '—'}
                        </td>
                        <td className="py-3 pr-4">
                          <span className="flex items-center gap-1">
                            <Users className="h-3.5 w-3.5 text-muted-foreground" />
                            {org.member_count}
                          </span>
                        </td>
                        <td className="py-3 pr-4">
                          <span className="flex items-center gap-1">
                            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                            {org.anchor_count}
                          </span>
                        </td>
                        <td className="py-3 pr-4" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-2">
                            {renderCap(org)}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              title="Set free-tier cap"
                              onClick={(e) => { e.stopPropagation(); openCap(org); }}
                            >
                              <SlidersHorizontal className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                        <td className="py-3 text-muted-foreground">
                          {new Date(org.created_at).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
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

      {/* SCRUM-2225 — free-tier cap editor */}
      <Dialog open={!!editingOrg} onOpenChange={(open) => { if (!open) setEditingOrg(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Free testing cap</DialogTitle>
            <DialogDescription>
              {editingOrg?.display_name} — how many documents this organization can secure for free before it must upgrade.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="cap-toggle">Capped free tier</Label>
                <p className="text-xs text-muted-foreground">Off = uncapped, billable account.</p>
              </div>
              <Switch id="cap-toggle" checked={capEnabled} onCheckedChange={setCapEnabled} />
            </div>
            {capEnabled && (
              <div className="space-y-1.5">
                <Label htmlFor="cap-quota">Free testing actions</Label>
                <Input
                  id="cap-quota"
                  type="number"
                  min={0}
                  value={quotaInput}
                  onChange={(e) => setQuotaInput(e.target.value)}
                  className="w-32"
                />
                <p className="text-xs text-muted-foreground">New signups default to {DEFAULT_FREE_QUOTA}.</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingOrg(null)} disabled={saving}>Cancel</Button>
            <Button onClick={saveCap} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
