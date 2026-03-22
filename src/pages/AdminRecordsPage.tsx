/**
 * Admin Records List Page (SN1)
 *
 * Platform admin page showing all records with search, filter by status/type, pagination.
 * Click-through from Platform Overview stat cards.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  FileText,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ROUTES } from '@/lib/routes';
import { isPlatformAdmin } from '@/lib/platform';

interface AdminRecord {
  id: string;
  public_id: string;
  filename: string;
  credential_type: string;
  status: string;
  chain_tx_id: string | null;
  fingerprint: string;
  user_id: string;
  user_email: string | null;
  org_id: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

export function AdminRecordsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { items, total, page, limit, loading, error, fetchList } = useAdminList<AdminRecord>('/api/admin/records');

  const [searchInput, setSearchInput] = useState(searchParams.get('search') ?? '');
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || 'ALL');
  const [typeFilter, setTypeFilter] = useState(searchParams.get('type') || 'ALL');

  const isAdmin = isPlatformAdmin(user?.email);

  const doFetch = useCallback((p = 1) => {
    fetchList({ page: p, search: searchInput, filters: { status: statusFilter === 'ALL' ? '' : statusFilter, type: typeFilter === 'ALL' ? '' : typeFilter } });
  }, [fetchList, searchInput, statusFilter, typeFilter]);

  useEffect(() => {
    if (isAdmin) doFetch(parseInt(searchParams.get('page') ?? '1', 10));
  }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = () => {
    setSearchParams({ search: searchInput, status: statusFilter === 'ALL' ? '' : statusFilter, type: typeFilter === 'ALL' ? '' : typeFilter, page: '1' });
    doFetch(1);
  };

  const handlePageChange = (newPage: number) => {
    setSearchParams({ search: searchInput, status: statusFilter === 'ALL' ? '' : statusFilter, type: typeFilter === 'ALL' ? '' : typeFilter, page: String(newPage) });
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
          <h1 className="text-2xl font-semibold tracking-tight">All Records</h1>
          <p className="text-muted-foreground text-sm">{total.toLocaleString()} total records</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by filename, ID, or fingerprint..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); const sf = v === 'ALL' ? '' : v; const tf = typeFilter === 'ALL' ? '' : typeFilter; setSearchParams({ search: searchInput, status: sf, type: tf, page: '1' }); fetchList({ page: 1, search: searchInput, filters: { status: sf, type: tf } }); }}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All Statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Statuses</SelectItem>
            <SelectItem value="PENDING">Pending</SelectItem>
            <SelectItem value="SUBMITTED">Submitted</SelectItem>
            <SelectItem value="SECURED">Secured</SelectItem>
            <SelectItem value="REVOKED">Revoked</SelectItem>
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v); const sf = statusFilter === 'ALL' ? '' : statusFilter; const tf = v === 'ALL' ? '' : v; setSearchParams({ search: searchInput, status: sf, type: tf, page: '1' }); fetchList({ page: 1, search: searchInput, filters: { status: sf, type: tf } }); }}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All Types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Types</SelectItem>
            <SelectItem value="PROFESSIONAL">Professional</SelectItem>
            <SelectItem value="ACADEMIC">Academic</SelectItem>
            <SelectItem value="LICENSE">License</SelectItem>
            <SelectItem value="CERTIFICATE">Certificate</SelectItem>
            <SelectItem value="OTHER">Other</SelectItem>
          </SelectContent>
        </Select>
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
            <FileText className="h-4 w-4" />
            Records
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
            <p className="text-sm text-muted-foreground text-center py-8">No records found.</p>
          ) : (
            <>
              {/* Mobile card layout */}
              <div className="space-y-3 md:hidden">
                {items.map((r) => (
                  <div
                    key={r.id}
                    className="rounded-lg border p-4 cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => navigate(`/records/${r.id}`)}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium truncate max-w-[200px]">{r.filename}</span>
                      <RecordStatusBadge status={r.status} />
                    </div>
                    <div className="text-xs text-muted-foreground font-mono mb-1">{r.public_id}</div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="capitalize text-[10px]">
                          {r.credential_type?.toLowerCase() ?? '—'}
                        </Badge>
                        <span className="font-mono truncate max-w-[120px]">{r.user_email ?? '—'}</span>
                      </div>
                      <span>{new Date(r.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop table */}
              <div className="overflow-x-auto hidden md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2 pr-4">Document</th>
                      <th className="pb-2 pr-4">Status</th>
                      <th className="pb-2 pr-4">Type</th>
                      <th className="pb-2 pr-4">Owner</th>
                      <th className="pb-2">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((r) => (
                      <tr
                        key={r.id}
                        className="border-b last:border-0 hover:bg-muted/50 cursor-pointer"
                        onClick={() => navigate(`/records/${r.id}`)}
                      >
                        <td className="py-3 pr-4">
                          <div className="font-medium truncate max-w-[300px]">{r.filename}</div>
                          <div className="text-xs text-muted-foreground font-mono">{r.public_id}</div>
                        </td>
                        <td className="py-3 pr-4">
                          <RecordStatusBadge status={r.status} />
                        </td>
                        <td className="py-3 pr-4">
                          <Badge variant="outline" className="capitalize text-xs">
                            {r.credential_type?.toLowerCase() ?? '—'}
                          </Badge>
                        </td>
                        <td className="py-3 pr-4 text-muted-foreground text-xs font-mono">
                          {r.user_email ?? '—'}
                        </td>
                        <td className="py-3 text-muted-foreground text-xs">
                          {new Date(r.created_at).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t">
              <p className="text-xs text-muted-foreground">Page {page} of {totalPages}</p>
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

function RecordStatusBadge({ status }: Readonly<{ status: string }>) {
  switch (status) {
    case 'SECURED':
      return <Badge className="bg-green-500/10 text-green-700 border-green-500/30">Secured</Badge>;
    case 'PENDING':
      return <Badge className="bg-amber-500/10 text-amber-700 border-amber-500/30">Pending</Badge>;
    case 'SUBMITTED':
      return <Badge className="bg-blue-500/10 text-blue-700 border-blue-500/30">Submitted</Badge>;
    case 'REVOKED':
      return <Badge variant="destructive">Revoked</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}
