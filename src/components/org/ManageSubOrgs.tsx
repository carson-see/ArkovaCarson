/**
 * ManageSubOrgs Component (IDT-11)
 *
 * Displays and manages affiliated sub-organizations for a parent org.
 * Parent org admins can create, approve, and revoke affiliate organizations.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Building2, Check, X, Loader2, Link2, Plus, Users2, AlertTriangle, RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { WORKER_URL } from '@/lib/workerClient';
import { supabase } from '@/lib/supabase';
import { SUB_ORG_LABELS } from '@/lib/copy';

interface SubOrg {
  id: string;
  display_name: string;
  domain: string | null;
  verification_status: string;
  parent_approval_status: string;
  created_at: string;
  logo_url: string | null;
}

interface ManageSubOrgsProps {
  orgId: string;
}

/**
 * SCRUM-1999 sibling — local copy constants for the sub-orgs load-error state.
 * `src/lib/copy.ts` (the canonical home for UI strings, CLAUDE.md §1.3) is locked
 * under a concurrent PR for this change, so these strings live here and stay free
 * of banned terms (`npm run lint:copy` clean). Promote into `SUB_ORG_LABELS` when
 * that file is next touched.
 */
const SUB_ORG_STATE_COPY = {
  LOAD_ERROR_TITLE: "Couldn't load affiliated organizations",
  LOAD_ERROR_DESC: 'Something went wrong while loading affiliated organizations. Please try again.',
  RETRY: 'Try Again',
} as const;

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Not authenticated');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${session.access_token}`,
  };
}

export function ManageSubOrgs({ orgId }: ManageSubOrgsProps) {
  const [subOrgs, setSubOrgs] = useState<SubOrg[]>([]);
  const [affiliateName, setAffiliateName] = useState('');
  const [affiliateLegalName, setAffiliateLegalName] = useState('');
  const [affiliateDomain, setAffiliateDomain] = useState('');
  const [affiliateAdminEmail, setAffiliateAdminEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // `isInitialLoad` gates the full-panel error state to the mount fetch and the
  // explicit Retry. Action refetches (create/approve/revoke) pass `false`: a
  // transient post-action refetch failure must not wipe the list or raise the
  // banner — those errors are surfaced by the action handlers via toast.
  const fetchSubOrgs = useCallback(async (isInitialLoad = true) => {
    try {
      const headers = await getAuthHeaders();
      const url = `${WORKER_URL}/api/v1/org/sub-orgs?orgId=${encodeURIComponent(orgId)}`;
      const response = await fetch(url, { headers });
      if (!response.ok) {
        // SCRUM-1999 sibling: surface the load failure explicitly instead of
        // silently returning, which left an empty list with no signal — the
        // outage/denial masqueraded as the "no affiliates yet" empty state.
        if (isInitialLoad) {
          setLoadError(true);
          setSubOrgs([]);
        }
        return;
      }
      const data = await response.json() as { subOrgs: SubOrg[] };
      setLoadError(false);
      setSubOrgs(data.subOrgs);
    } catch {
      // Network/parse failure on the load — show the explicit error state only
      // for the initial load / Retry; action refetches keep using toast.
      if (isInitialLoad) {
        setLoadError(true);
        setSubOrgs([]);
      }
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    await fetchSubOrgs();
    setRetrying(false);
  }, [fetchSubOrgs]);

  useEffect(() => {
    async function run() { await fetchSubOrgs(); }
    void run();
  }, [fetchSubOrgs]);

  const handleCreateAffiliate = useCallback(async () => {
    const displayName = affiliateName.trim();
    const adminEmail = affiliateAdminEmail.trim().toLowerCase();
    if (!displayName || !adminEmail) {
      toast.error(SUB_ORG_LABELS.CREATE_MISSING_FIELDS);
      return;
    }

    setCreating(true);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${WORKER_URL}/api/v1/org/sub-orgs/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          parentOrgId: orgId,
          displayName,
          legalName: affiliateLegalName.trim() || undefined,
          domain: affiliateDomain.trim().toLowerCase() || undefined,
          adminEmail,
        }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) {
        toast.error(data.error ?? SUB_ORG_LABELS.CREATE_FAILED);
        return;
      }
      toast.success(SUB_ORG_LABELS.CREATE_SUCCESS);
      setAffiliateName('');
      setAffiliateLegalName('');
      setAffiliateDomain('');
      setAffiliateAdminEmail('');
      await fetchSubOrgs(false);
    } catch {
      toast.error(SUB_ORG_LABELS.CREATE_FAILED);
    } finally {
      setCreating(false);
    }
  }, [affiliateAdminEmail, affiliateDomain, affiliateLegalName, affiliateName, fetchSubOrgs, orgId]);

  const handleApprove = useCallback(async (childOrgId: string) => {
    setActionLoading(childOrgId);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${WORKER_URL}/api/v1/org/sub-orgs/approve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ childOrgId, parentOrgId: orgId }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) {
        toast.error(data.error ?? SUB_ORG_LABELS.APPROVE_FAILED);
        return;
      }
      toast.success(SUB_ORG_LABELS.APPROVE_SUCCESS);
      await fetchSubOrgs(false);
    } catch {
      toast.error(SUB_ORG_LABELS.APPROVE_FAILED);
    } finally {
      setActionLoading(null);
    }
  }, [fetchSubOrgs, orgId]);

  const handleRevoke = useCallback(async (childOrgId: string) => {
    setActionLoading(childOrgId);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${WORKER_URL}/api/v1/org/sub-orgs/revoke`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ childOrgId, parentOrgId: orgId }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) {
        toast.error(data.error ?? SUB_ORG_LABELS.REVOKE_FAILED);
        return;
      }
      toast.success(SUB_ORG_LABELS.REVOKE_SUCCESS);
      await fetchSubOrgs(false);
    } catch {
      toast.error(SUB_ORG_LABELS.REVOKE_FAILED);
    } finally {
      setActionLoading(null);
    }
  }, [fetchSubOrgs, orgId]);

  const approvedCount = subOrgs.filter((s) => s.parent_approval_status === 'APPROVED').length;

  function getStatusBadge(status: string) {
    switch (status) {
      case 'PENDING':
        return <Badge variant="outline" className="bg-amber-500/10 text-amber-400 border-amber-500/20 text-xs">{SUB_ORG_LABELS.STATUS_PENDING}</Badge>;
      case 'APPROVED':
        return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs">{SUB_ORG_LABELS.STATUS_APPROVED}</Badge>;
      case 'REVOKED':
        return <Badge variant="outline" className="bg-red-500/10 text-red-400 border-red-500/20 text-xs">{SUB_ORG_LABELS.STATUS_REVOKED}</Badge>;
      default:
        return null;
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users2 className="h-5 w-5" />
          {SUB_ORG_LABELS.MANAGE_TITLE}
        </CardTitle>
        <CardDescription>{SUB_ORG_LABELS.MANAGE_DESCRIPTION}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Count display */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link2 className="h-4 w-4" />
          <span>
            <strong className="text-foreground">{approvedCount}</strong>
            {' '}{SUB_ORG_LABELS.COUNT_LABEL}
          </span>
        </div>

        {/* Affiliate create form */}
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="affiliate-name">{SUB_ORG_LABELS.AFFILIATE_NAME_LABEL}</Label>
              <Input
                id="affiliate-name"
                value={affiliateName}
                onChange={(e) => setAffiliateName(e.target.value)}
                maxLength={255}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="affiliate-admin-email">{SUB_ORG_LABELS.AFFILIATE_ADMIN_EMAIL_LABEL}</Label>
              <Input
                id="affiliate-admin-email"
                type="email"
                value={affiliateAdminEmail}
                onChange={(e) => setAffiliateAdminEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="affiliate-legal-name">{SUB_ORG_LABELS.AFFILIATE_LEGAL_NAME_LABEL}</Label>
              <Input
                id="affiliate-legal-name"
                value={affiliateLegalName}
                onChange={(e) => setAffiliateLegalName(e.target.value)}
                maxLength={255}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="affiliate-domain">{SUB_ORG_LABELS.AFFILIATE_DOMAIN_LABEL}</Label>
              <Input
                id="affiliate-domain"
                value={affiliateDomain}
                onChange={(e) => setAffiliateDomain(e.target.value)}
                autoComplete="off"
              />
            </div>
          </div>
          <div>
            <Button
              size="sm"
              onClick={handleCreateAffiliate}
              disabled={creating}
            >
              {creating ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-1 h-4 w-4" />
              )}
              {SUB_ORG_LABELS.CREATE_AFFILIATE}
            </Button>
          </div>
        </div>

        <Separator />

        {/* Sub-org list */}
        {loadError ? (
          <div
            role="alert"
            className="flex flex-col items-center justify-center gap-3 py-8 text-center"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
              <AlertTriangle className="h-6 w-6 text-amber-500" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground">{SUB_ORG_STATE_COPY.LOAD_ERROR_TITLE}</p>
              <p className="text-sm text-muted-foreground max-w-sm">{SUB_ORG_STATE_COPY.LOAD_ERROR_DESC}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => { void handleRetry(); }} disabled={retrying}>
              <RefreshCw className={`mr-2 h-4 w-4 ${retrying ? 'animate-spin' : ''}`} />
              {SUB_ORG_STATE_COPY.RETRY}
            </Button>
          </div>
        ) : subOrgs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Building2 className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">{SUB_ORG_LABELS.EMPTY_STATE}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {subOrgs.map((sub) => (
              <div
                key={sub.id}
                className="flex items-center justify-between p-3 rounded-lg border border-border/50 bg-card hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
                    {sub.logo_url ? (
                      <img src={sub.logo_url} alt={`${sub.display_name} organization logo`} className="h-full w-full object-cover rounded-md" loading="lazy" decoding="async" width={40} height={40} />
                    ) : (
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">{sub.display_name}</p>
                      {getStatusBadge(sub.parent_approval_status)}
                    </div>
                    {sub.domain && (
                      <p className="text-xs text-muted-foreground truncate">{sub.domain}</p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0 ml-2">
                  {sub.parent_approval_status === 'PENDING' && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/10"
                        onClick={() => handleApprove(sub.id)}
                        disabled={actionLoading === sub.id}
                      >
                        {actionLoading === sub.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <>
                            <Check className="mr-1 h-4 w-4" />
                            {SUB_ORG_LABELS.APPROVE}
                          </>
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-red-400 border-red-500/20 hover:bg-red-500/10"
                        onClick={() => handleRevoke(sub.id)}
                        disabled={actionLoading === sub.id}
                      >
                        <X className="mr-1 h-4 w-4" />
                        {SUB_ORG_LABELS.REVOKE}
                      </Button>
                    </>
                  )}
                  {sub.parent_approval_status === 'APPROVED' && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-red-400 border-red-500/20 hover:bg-red-500/10"
                      onClick={() => handleRevoke(sub.id)}
                      disabled={actionLoading === sub.id}
                    >
                      {actionLoading === sub.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <>
                          <X className="mr-1 h-4 w-4" />
                          {SUB_ORG_LABELS.REVOKE}
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
