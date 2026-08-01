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
  Coins,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useAdminList } from '@/hooks/useAdminList';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
import { ADMIN_CREDIT_ADJUST_LABELS as CREDIT } from '@/lib/copy';

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
  credit_balance: number | null;
  created_at: string;
}

const DEFAULT_FREE_QUOTA = 10;

// The helpers below are pure (no hook/closure dependencies) and are declared
// at module scope rather than inside the component. Besides being
// independently testable, this keeps them out of the component function's
// own lexical body — SonarCloud typescript:S3776 (Cognitive Complexity) was
// flagging the component at 20 against a limit of 15 because every branch
// in every inline handler was scored as part of one giant function.

function renderOrgCapBadge(org: AdminOrganization) {
  if (org.is_test && org.anchor_quota != null) {
    const over = org.anchor_count >= org.anchor_quota;
    return (
      <Badge variant={over ? 'destructive' : 'secondary'} className="text-[10px]">
        {org.anchor_count}/{org.anchor_quota} free
      </Badge>
    );
  }
  return <span className="text-xs text-muted-foreground">Uncapped</span>;
}

function isValidQuotaInput(capEnabled: boolean, quotaNum: number): boolean {
  return !capEnabled || (Number.isInteger(quotaNum) && quotaNum >= 0);
}

function buildQuotaPayload(capEnabled: boolean, quotaNum: number): { anchor_quota: number | null; is_test: boolean } {
  return capEnabled
    ? { anchor_quota: quotaNum, is_test: true }
    : { anchor_quota: null, is_test: false };
}

function buildQuotaSuccessMessage(displayName: string, capEnabled: boolean, quotaNum: number): string {
  if (!capEnabled) return `${displayName}: uncapped (billable).`;
  const unit = quotaNum === 1 ? 'action' : 'actions';
  return `${displayName}: capped at ${quotaNum} free testing ${unit}.`;
}

/** Maps an adjust-credits API error code to a user-facing toast message. */
function resolveCreditsErrorMessage(errorCode: string | undefined): string {
  if (errorCode === 'insufficient_balance') return CREDIT.ERROR_INSUFFICIENT_BALANCE;
  return errorCode ?? CREDIT.ERROR_GENERIC;
}

function buildCreditsSuccessMessage(action: 'add' | 'remove', amountLabel: string, displayName: string): string {
  return action === 'add'
    ? CREDIT.SUCCESS_ADD(amountLabel, displayName)
    : CREDIT.SUCCESS_REMOVE(amountLabel, displayName);
}

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

  // L2-A5 — credit adjust dialog state (founder admin-controls: add/remove credits).
  const [creditsOrg, setCreditsOrg] = useState<AdminOrganization | null>(null);
  const [creditsAction, setCreditsAction] = useState<'add' | 'remove'>('add');
  const [creditsAmountInput, setCreditsAmountInput] = useState('');
  const [creditsReasonInput, setCreditsReasonInput] = useState('');
  const [creditsStep, setCreditsStep] = useState<'input' | 'confirm'>('input');
  const [creditsIdempotencyKey, setCreditsIdempotencyKey] = useState<string | null>(null);
  const [creditsSaving, setCreditsSaving] = useState(false);

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
    const quotaNum = Number.parseInt(quotaInput, 10);
    if (!isValidQuotaInput(capEnabled, quotaNum)) {
      toast.error('Enter a whole number of free actions (0 or more).');
      return;
    }
    setSaving(true);
    try {
      const res = await workerFetch(`/api/admin/organizations/${encodeURIComponent(editingOrg.id)}/quota`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildQuotaPayload(capEnabled, quotaNum)),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to update cap');
        return;
      }
      toast.success(buildQuotaSuccessMessage(editingOrg.display_name, capEnabled, quotaNum));
      setEditingOrg(null);
      doFetch(page);
    } catch {
      toast.error('Failed to update cap');
    } finally {
      setSaving(false);
    }
  };

  // L2-A5 — credit adjust dialog handlers.
  const openCredits = (org: AdminOrganization) => {
    setCreditsOrg(org);
    setCreditsAction('add');
    setCreditsAmountInput('');
    setCreditsReasonInput('');
    setCreditsStep('input');
    setCreditsIdempotencyKey(null);
  };

  const closeCredits = () => {
    setCreditsOrg(null);
    setCreditsStep('input');
    setCreditsIdempotencyKey(null);
  };

  const creditsAmountNum = Number.parseInt(creditsAmountInput, 10);
  const creditsAmountValid = Number.isInteger(creditsAmountNum) && creditsAmountNum > 0;
  const creditsReasonValid = creditsReasonInput.trim().length > 0;
  const creditsCurrentBalance = creditsOrg?.credit_balance ?? 0;
  const creditsSignedAmount = creditsAction === 'add' ? creditsAmountNum : -creditsAmountNum;
  const creditsNewBalance = creditsAmountValid ? creditsCurrentBalance + creditsSignedAmount : creditsCurrentBalance;

  const reviewCredits = () => {
    if (!creditsAmountValid) {
      toast.error(CREDIT.AMOUNT_REQUIRED_ERROR);
      return;
    }
    if (!creditsReasonValid) {
      toast.error(CREDIT.REASON_REQUIRED_ERROR);
      return;
    }
    setCreditsIdempotencyKey(crypto.randomUUID());
    setCreditsStep('confirm');
  };

  const confirmCredits = async () => {
    if (!creditsOrg || !creditsIdempotencyKey) return;
    setCreditsSaving(true);
    try {
      const res = await workerFetch(`/api/admin/organizations/${encodeURIComponent(creditsOrg.id)}/credits/adjust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: creditsSignedAmount,
          reason: creditsReasonInput.trim(),
          idempotency_key: creditsIdempotencyKey,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(resolveCreditsErrorMessage(data.error));
        return;
      }
      toast.success(buildCreditsSuccessMessage(creditsAction, creditsAmountInput, creditsOrg.display_name));
      closeCredits();
      doFetch(page);
    } catch {
      toast.error(CREDIT.ERROR_GENERIC);
    } finally {
      setCreditsSaving(false);
    }
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
                        {renderOrgCapBadge(org)}
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
                    <div className="flex items-center justify-between mt-2">
                      <span className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{CREDIT.COLUMN_LABEL}:</span>
                        <Badge variant="secondary" className="text-[10px] font-mono">
                          {org.credit_balance != null ? org.credit_balance.toLocaleString() : CREDIT.UNKNOWN_BALANCE}
                        </Badge>
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7"
                        onClick={(e) => { e.stopPropagation(); openCredits(org); }}
                      >
                        <Coins className="h-3.5 w-3.5 mr-1" /> {CREDIT.BUTTON_LABEL}
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
                      <th className="pb-2 pr-4">{CREDIT.COLUMN_LABEL}</th>
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
                            {renderOrgCapBadge(org)}
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
                        <td className="py-3 pr-4" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-2">
                            <Badge variant="secondary" className="text-[10px] font-mono">
                              {org.credit_balance != null ? org.credit_balance.toLocaleString() : CREDIT.UNKNOWN_BALANCE}
                            </Badge>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              title={CREDIT.BUTTON_TITLE}
                              onClick={(e) => { e.stopPropagation(); openCredits(org); }}
                            >
                              <Coins className="h-3.5 w-3.5" />
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

      {/* L2-A5 — credit adjust dialog (founder admin-controls: add/remove credits) */}
      <Dialog open={!!creditsOrg} onOpenChange={(open) => { if (!open) closeCredits(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{CREDIT.DIALOG_TITLE}</DialogTitle>
            <DialogDescription>
              {creditsOrg ? CREDIT.DIALOG_DESCRIPTION(creditsOrg.display_name) : ''}
            </DialogDescription>
          </DialogHeader>

          {creditsStep === 'input' ? (
            <div className="space-y-4 py-2">
              <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
                <span className="text-sm text-muted-foreground">{CREDIT.CURRENT_BALANCE_LABEL}</span>
                <span className="font-mono text-sm font-medium">{creditsCurrentBalance.toLocaleString()}</span>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={creditsAction === 'add' ? 'default' : 'outline'}
                  size="sm"
                  className="flex-1"
                  onClick={() => setCreditsAction('add')}
                >
                  {CREDIT.ACTION_ADD}
                </Button>
                <Button
                  type="button"
                  variant={creditsAction === 'remove' ? 'default' : 'outline'}
                  size="sm"
                  className="flex-1"
                  onClick={() => setCreditsAction('remove')}
                >
                  {CREDIT.ACTION_REMOVE}
                </Button>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="credits-amount">{CREDIT.AMOUNT_LABEL}</Label>
                <Input
                  id="credits-amount"
                  type="number"
                  min={1}
                  step={1}
                  value={creditsAmountInput}
                  onChange={(e) => setCreditsAmountInput(e.target.value)}
                  className="w-32"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="credits-reason">{CREDIT.REASON_LABEL}</Label>
                <Textarea
                  id="credits-reason"
                  value={creditsReasonInput}
                  onChange={(e) => setCreditsReasonInput(e.target.value)}
                  placeholder={CREDIT.REASON_PLACEHOLDER}
                  rows={3}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              <div className="rounded-md border p-3 space-y-2">
                <p className="text-sm font-medium">
                  {creditsAction === 'add'
                    ? CREDIT.CONFIRM_SUMMARY_ADD(creditsAmountInput, creditsOrg?.display_name ?? '')
                    : CREDIT.CONFIRM_SUMMARY_REMOVE(creditsAmountInput, creditsOrg?.display_name ?? '')}
                </p>
                <p className="text-xs text-muted-foreground">{CREDIT.REASON_LABEL}: {creditsReasonInput}</p>
                <div className="flex items-center justify-between pt-2 border-t">
                  <span className="text-xs text-muted-foreground">{CREDIT.NEW_BALANCE_LABEL}</span>
                  <span className="font-mono text-sm font-medium">
                    {creditsCurrentBalance.toLocaleString()} → {Math.max(creditsNewBalance, 0).toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            {creditsStep === 'input' ? (
              <>
                <Button variant="outline" onClick={closeCredits}>Cancel</Button>
                <Button onClick={reviewCredits}>{CREDIT.REVIEW_BUTTON}</Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => setCreditsStep('input')} disabled={creditsSaving}>
                  {CREDIT.BACK_BUTTON}
                </Button>
                <Button onClick={confirmCredits} disabled={creditsSaving}>
                  {creditsSaving ? CREDIT.CONFIRMING_BUTTON : CREDIT.CONFIRM_BUTTON}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
