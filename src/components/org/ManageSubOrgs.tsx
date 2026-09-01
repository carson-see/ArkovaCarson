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
  /** SCRUM-3867 — is this sub-org running on OUR DocuSign connection? */
  docusignInherited?: boolean;
}

/**
 * SCRUM-3865 — the two directions of a credit transfer. A negative amount is a
 * reclaim, so both rows drive the same endpoint and the same handler.
 */
const CREDIT_ACTIONS = [
  { dir: 1 as const, labelKey: 'CREDITS_ADD' as const, variant: undefined },
  { dir: -1 as const, labelKey: 'CREDITS_RECLAIM' as const, variant: 'outline' as const },
];

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
  // SCRUM-3865 — credit provisioning state.
  const [parentBalance, setParentBalance] = useState<number | null>(null);
  const [childBalances, setChildBalances] = useState<Record<string, number>>({});
  const [creditAmounts, setCreditAmounts] = useState<Record<string, string>>({});
  const [creditBusy, setCreditBusy] = useState<{ id: string; dir: 1 | -1 } | null>(null);
  const [connectorBusy, setConnectorBusy] = useState<string | null>(null);

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

  /**
   * SCRUM-3865 — parent + per-sub-org credit balances.
   *
   * Deliberately independent of `fetchSubOrgs`: credit provisioning is additive
   * to a panel that already worked, so a rollup outage must degrade to "no
   * balances shown" rather than taking out approve/revoke with it. Failures are
   * swallowed here for exactly that reason.
   */
  const fetchCredits = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const url = `${WORKER_URL}/api/v1/org/sub-orgs/credits?orgId=${encodeURIComponent(orgId)}`;
      const response = await fetch(url, { headers });
      if (!response.ok) return;
      const data = await response.json() as {
        parentBalance: number;
        children: { childOrgId: string; balance: number }[];
      };
      setParentBalance(data.parentBalance);
      setChildBalances(
        Object.fromEntries((data.children ?? []).map((c) => [c.childOrgId, c.balance])),
      );
    } catch {
      // Balances stay hidden; the rest of the panel is unaffected.
    }
  }, [orgId]);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    await Promise.all([fetchSubOrgs(), fetchCredits()]);
    setRetrying(false);
  }, [fetchSubOrgs, fetchCredits]);

  useEffect(() => {
    async function run() { await Promise.all([fetchSubOrgs(), fetchCredits()]); }
    void run();
  }, [fetchSubOrgs, fetchCredits]);

  /**
   * SCRUM-3867 — lend this org's DocuSign connection to a sub-org, or take it
   * back. The parent is the party lending credentials, which is why the control
   * lives here rather than on the sub-org's own connector card.
   */
  const handleToggleInheritance = useCallback(async (childOrgId: string, inherited: boolean) => {
    setConnectorBusy(childOrgId);
    try {
      const headers = await getAuthHeaders();
      const path = inherited ? 'docusign/inherit/stop' : 'docusign/inherit';
      const response = await fetch(`${WORKER_URL}/api/v1/integrations/${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ org_id: childOrgId }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string };

      if (!response.ok) {
        const message =
          data.error === 'parent_not_connected' ? SUB_ORG_LABELS.DOCUSIGN_PARENT_NOT_CONNECTED
          : data.error === 'already_connected' ? SUB_ORG_LABELS.DOCUSIGN_ALREADY_CONNECTED
          : SUB_ORG_LABELS.DOCUSIGN_SHARE_FAILED;
        toast.error(message);
        return;
      }

      setSubOrgs((prev) => prev.map((s) =>
        s.id === childOrgId ? { ...s, docusignInherited: !inherited } : s));
      toast.success(
        inherited ? SUB_ORG_LABELS.DOCUSIGN_SHARING_STOPPED : SUB_ORG_LABELS.DOCUSIGN_SHARED,
      );
    } catch {
      toast.error(SUB_ORG_LABELS.DOCUSIGN_SHARE_FAILED);
    } finally {
      setConnectorBusy(null);
    }
  }, []);

  /**
   * Move credits between the parent and one sub-org. `direction` is the sign:
   * the worker treats a negative amount as a reclaim, which is also the
   * offboarding lever, so both buttons drive one endpoint.
   */
  const handleMoveCredits = useCallback(async (childOrgId: string, direction: 1 | -1) => {
    const raw = (creditAmounts[childOrgId] ?? '').trim();
    const parsed = Number(raw);
    if (!raw || !Number.isInteger(parsed) || parsed <= 0) {
      toast.error(SUB_ORG_LABELS.CREDITS_INVALID_AMOUNT);
      return;
    }

    setCreditBusy({ id: childOrgId, dir: direction });
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${WORKER_URL}/api/v1/org/sub-orgs/credits?orgId=${encodeURIComponent(orgId)}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ childOrgId, amount: parsed * direction }),
        },
      );
      const data = await response.json() as {
        parentBalance?: number;
        childBalance?: number;
        error?: string;
      };

      if (!response.ok) {
        const message =
          data.error === 'insufficient_parent_balance' ? SUB_ORG_LABELS.CREDITS_INSUFFICIENT_PARENT
          : data.error === 'insufficient_child_balance' ? SUB_ORG_LABELS.CREDITS_INSUFFICIENT_CHILD
          : SUB_ORG_LABELS.CREDITS_FAILED;
        toast.error(message);
        return;
      }

      if (typeof data.parentBalance === 'number') setParentBalance(data.parentBalance);
      if (typeof data.childBalance === 'number') {
        setChildBalances((prev) => ({ ...prev, [childOrgId]: data.childBalance as number }));
      }
      setCreditAmounts((prev) => ({ ...prev, [childOrgId]: '' }));
      toast.success(
        direction > 0 ? SUB_ORG_LABELS.CREDITS_ADDED : SUB_ORG_LABELS.CREDITS_RECLAIMED,
      );
    } catch {
      toast.error(SUB_ORG_LABELS.CREDITS_FAILED);
    } finally {
      setCreditBusy(null);
    }
  }, [creditAmounts, orgId]);

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
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <Link2 className="h-4 w-4" />
            <span>
              <strong className="text-foreground">{approvedCount}</strong>
              {' '}{SUB_ORG_LABELS.COUNT_LABEL}
            </span>
          </span>
          {/* SCRUM-3865: the pool every allocation below draws from. */}
          {parentBalance !== null && (
            <span className="flex items-center gap-2">
              <Users2 className="h-4 w-4" />
              <span>
                <strong className="text-foreground">{parentBalance}</strong>
                {' '}{SUB_ORG_LABELS.CREDITS_AVAILABLE}
              </span>
            </span>
          )}
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
                data-testid="sub-org-row"
                className="p-3 rounded-lg border border-border/50 bg-card hover:bg-muted/30 transition-colors"
              >
                {/*
                  Wraps at narrow widths: with the actions pinned on the same
                  line the name truncated to a single character at 375px.
                */}
                <div className="flex flex-wrap items-center justify-between gap-2">
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

                {/*
                  SCRUM-3865 — credit provisioning. Offered only for an APPROVED
                  affiliation: funding an org whose affiliation is pending or
                  revoked would move credits across a boundary the parent has not
                  (or no longer) accepted. Reclaim is the same endpoint with a
                  negative amount, which is also the offboarding lever.
                */}
                {sub.parent_approval_status === 'APPROVED' && (
                  <div className="mt-3 pt-3 border-t border-border/40 flex flex-wrap items-end gap-2">
                    <div className="w-28 shrink-0">
                      <Label
                        htmlFor={`credits-${sub.id}`}
                        className="text-xs text-muted-foreground"
                      >
                        {SUB_ORG_LABELS.CREDITS_AMOUNT_LABEL}
                      </Label>
                      <Input
                        id={`credits-${sub.id}`}
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        className="h-9"
                        value={creditAmounts[sub.id] ?? ''}
                        onChange={(e) =>
                          setCreditAmounts((prev) => ({ ...prev, [sub.id]: e.target.value }))
                        }
                      />
                    </div>
                    {/*
                      Both directions are one control driven from one list. Hand-
                      written as two blocks they had already drifted: only the Add
                      button showed a spinner while a transfer was in flight.
                    */}
                    {CREDIT_ACTIONS.map(({ dir, labelKey, variant }) => {
                      const busy = creditBusy?.id === sub.id;
                      return (
                        <Button
                          key={labelKey}
                          size="sm"
                          variant={variant}
                          className="h-9"
                          onClick={() => { void handleMoveCredits(sub.id, dir); }}
                          disabled={busy}
                        >
                          {busy && creditBusy?.dir === dir
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : SUB_ORG_LABELS[labelKey]}
                        </Button>
                      );
                    })}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-9"
                      onClick={() => { void handleToggleInheritance(sub.id, sub.docusignInherited === true); }}
                      disabled={connectorBusy === sub.id}
                    >
                      {connectorBusy === sub.id
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : sub.docusignInherited
                          ? SUB_ORG_LABELS.DOCUSIGN_STOP_SHARING
                          : SUB_ORG_LABELS.DOCUSIGN_SHARE}
                    </Button>
                    {typeof childBalances[sub.id] === 'number' && (
                      <span className="text-xs text-muted-foreground ml-auto self-center">
                        {childBalances[sub.id]} {SUB_ORG_LABELS.CREDITS_BALANCE_SUFFIX}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
