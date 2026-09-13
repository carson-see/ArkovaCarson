/**
 * ManageSubOrgs Component (IDT-11)
 *
 * Displays and manages affiliated sub-organizations for a parent org.
 * Parent org admins can create, approve, revoke, fund and offboard affiliates.
 *
 * Founder feedback 2026-09-13 ("when I try and use sub orgs it's clunky and
 * confusing") produced docs/uat/suborg-ux/FINDINGS.md. Nothing there was a
 * missing capability — every parent-side action already existed — so this
 * component gained no endpoint. What changed is the order things appear in,
 * what the destructive actions ask before firing, and what the copy says:
 *
 *   - the list comes first; the four-field create form is a disclosure beneath
 *     it, because an admin arrives to approve a waiting request, not to type;
 *   - Revoke confirms, like Offboard beside it already did, and both name the
 *     organization (at 375 px the row name truncates to ~8 characters);
 *   - worker replies are translated, never echoed — the shipped build could
 *     show an operator the literal text `sub_org_limit_reached`;
 *   - the pending count is stated and reported upward, so the parent page can
 *     badge its tab and the queue is visible without opening the panel.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Building2, Check, X, Loader2, Link2, Plus, Users2, AlertTriangle, RefreshCw, Coins,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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

/** What the panel knows about its own list, reported to the page for the tab badge. */
export interface SubOrgCounts {
  pending: number;
  approved: number;
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
  /**
   * Called after every list load with the counts, or with `null` when the list
   * could not be loaded. Never called with zeroes on failure: a tab badge that
   * reads "nothing waiting" because a fetch failed is worse than no badge.
   */
  onCountsChange?: (counts: SubOrgCounts | null) => void;
}

/**
 * Worker replies, translated.
 *
 * `toast.error(data.error ?? FALLBACK)` echoed whatever the worker sent. Some of
 * those replies are machine codes (`sub_org_limit_reached`,
 * `credit_allocation_unavailable`) and the rest are engineer-facing sentences,
 * so the shipped build could and did put both in front of an operator
 * (docs/uat/suborg-ux/step8-create-error-toast-1280.png).
 *
 * Unrecognised replies are NOT silently generalised away: `translateWorkerError`
 * logs the raw value before returning the caller's fallback, so a new worker
 * code shows up in the console rather than vanishing.
 */
const WORKER_ERROR_COPY: Record<string, string> = {
  sub_org_limit_reached: SUB_ORG_LABELS.ERROR_LIMIT_REACHED,
  cap_check_unavailable: SUB_ORG_LABELS.ERROR_CAP_CHECK_UNAVAILABLE,
  credit_allocation_unavailable: SUB_ORG_LABELS.ERROR_TEMPORARILY_UNAVAILABLE,
  credit_rollup_unavailable: SUB_ORG_LABELS.ERROR_TEMPORARILY_UNAVAILABLE,
  balance_lookup_unavailable: SUB_ORG_LABELS.ERROR_TEMPORARILY_UNAVAILABLE,
  insufficient_parent_balance: SUB_ORG_LABELS.CREDITS_INSUFFICIENT_PARENT,
  insufficient_child_balance: SUB_ORG_LABELS.CREDITS_INSUFFICIENT_CHILD,
  'Admin permissions required': SUB_ORG_LABELS.ERROR_NOT_ADMIN,
  'Your organization already has an active or pending affiliation':
    SUB_ORG_LABELS.ERROR_ALREADY_AFFILIATED,
  'Cannot affiliate with yourself': SUB_ORG_LABELS.ERROR_SELF_AFFILIATION,
  'Can only affiliate with verified organizations': SUB_ORG_LABELS.ERROR_PARENT_NOT_VERIFIED,
  'Parent organization not found': SUB_ORG_LABELS.ERROR_PARENT_NOT_FOUND,
  'Cannot affiliate with a sub-organization': SUB_ORG_LABELS.ERROR_PARENT_IS_CHILD,
  'Invalid affiliate organization details': SUB_ORG_LABELS.CREATE_MISSING_FIELDS,
};

export function translateWorkerError(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const mapped = WORKER_ERROR_COPY[raw];
  if (mapped) return mapped;
  console.error('[sub-orgs] unmapped worker error', raw);
  return fallback;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Not authenticated');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${session.access_token}`,
  };
}

export function ManageSubOrgs({ orgId, onCountsChange }: ManageSubOrgsProps) {
  const [subOrgs, setSubOrgs] = useState<SubOrg[]>([]);
  const [affiliateName, setAffiliateName] = useState('');
  const [affiliateLegalName, setAffiliateLegalName] = useState('');
  const [affiliateDomain, setAffiliateDomain] = useState('');
  const [affiliateAdminEmail, setAffiliateAdminEmail] = useState('');
  const [showCreate, setShowCreate] = useState(false);
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
  // SCRUM-3868 — the sub-org awaiting an offboard confirmation, if any.
  const [offboarding, setOffboarding] = useState<SubOrg | null>(null);
  const [offboardBusy, setOffboardBusy] = useState(false);
  // The sub-org awaiting a REVOKE confirmation. Revoke used to fire on the
  // first click while the gentler Offboard beside it confirmed, so the two
  // red buttons in a row behaved differently for no reason a user could see.
  const [revoking, setRevoking] = useState<SubOrg | null>(null);

  // Held in a ref so a parent passing an inline lambda cannot retrigger the
  // fetch effect on every render.
  const onCountsChangeRef = useRef(onCountsChange);
  useEffect(() => { onCountsChangeRef.current = onCountsChange; }, [onCountsChange]);

  const reportCounts = useCallback((rows: SubOrg[] | null) => {
    if (rows === null) {
      onCountsChangeRef.current?.(null);
      return;
    }
    onCountsChangeRef.current?.({
      pending: rows.filter((s) => s.parent_approval_status === 'PENDING').length,
      approved: rows.filter((s) => s.parent_approval_status === 'APPROVED').length,
    });
  }, []);

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
          reportCounts(null);
        }
        return;
      }
      const data = await response.json() as { subOrgs: SubOrg[] };
      setLoadError(false);
      setSubOrgs(data.subOrgs);
      reportCounts(data.subOrgs);
    } catch {
      // Network/parse failure on the load — show the explicit error state only
      // for the initial load / Retry; action refetches keep using toast.
      if (isInitialLoad) {
        setLoadError(true);
        setSubOrgs([]);
        reportCounts(null);
      }
    } finally {
      setLoading(false);
    }
  }, [orgId, reportCounts]);

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
   * SCRUM-3868 — end a client relationship: return the unspent credits, then
   * suspend. The worker does it in that order so a failure leaves the credits
   * with the parent rather than stranded. Anchored records are untouched.
   */
  const handleOffboard = useCallback(async (child: SubOrg) => {
    setOffboardBusy(true);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${WORKER_URL}/api/v1/org/sub-orgs/offboard?orgId=${encodeURIComponent(orgId)}`,
        { method: 'POST', headers, body: JSON.stringify({ childOrgId: child.id }) },
      );
      const data = await response.json().catch(() => ({})) as {
        reclaimed?: number; suspended?: boolean;
      };

      if (!response.ok) {
        // A partial offboard is its own message: the credits DID move, so the
        // operator must not assume nothing happened and start over blind.
        toast.error(
          data.reclaimed && data.suspended === false
            ? SUB_ORG_LABELS.OFFBOARD_PARTIAL
            : SUB_ORG_LABELS.OFFBOARD_FAILED,
        );
        return;
      }

      setOffboarding(null);
      await Promise.all([fetchSubOrgs(false), fetchCredits()]);
      toast.success(SUB_ORG_LABELS.OFFBOARD_DONE);
    } catch {
      toast.error(SUB_ORG_LABELS.OFFBOARD_FAILED);
    } finally {
      setOffboardBusy(false);
    }
  }, [orgId, fetchSubOrgs, fetchCredits]);

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
        toast.error(translateWorkerError(data.error, SUB_ORG_LABELS.CREDITS_FAILED));
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
        toast.error(translateWorkerError(data.error, SUB_ORG_LABELS.CREATE_FAILED));
        return;
      }
      toast.success(SUB_ORG_LABELS.CREATE_SUCCESS);
      setAffiliateName('');
      setAffiliateLegalName('');
      setAffiliateDomain('');
      setAffiliateAdminEmail('');
      setShowCreate(false);
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
        toast.error(translateWorkerError(data.error, SUB_ORG_LABELS.APPROVE_FAILED));
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
        toast.error(translateWorkerError(data.error, SUB_ORG_LABELS.REVOKE_FAILED));
        return;
      }
      setRevoking(null);
      toast.success(SUB_ORG_LABELS.REVOKE_SUCCESS);
      await fetchSubOrgs(false);
    } catch {
      toast.error(SUB_ORG_LABELS.REVOKE_FAILED);
    } finally {
      setActionLoading(null);
    }
  }, [fetchSubOrgs, orgId]);

  const approvedCount = subOrgs.filter((s) => s.parent_approval_status === 'APPROVED').length;
  const pendingCount = subOrgs.filter((s) => s.parent_approval_status === 'PENDING').length;

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

  /**
   * The create form. Rendered under the list behind a disclosure, and from the
   * empty state, so the same markup serves both without duplicating field ids.
   */
  function renderCreateForm() {
    return (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">{SUB_ORG_LABELS.ADD_AFFILIATE_HELP}</p>
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
        <Button
          size="sm"
          className="w-full sm:w-auto"
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
    );
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
        {/*
          Counts. `approvedCount` used to render with a hardcoded plural noun
          ("1 affiliated organizations") and the pending ones — the number an
          admin is actually here for — were not stated at all.
        */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <Link2 className="h-4 w-4" />
            <span>
              <strong className="text-foreground">{approvedCount}</strong>
              {' '}
              {approvedCount === 1 ? SUB_ORG_LABELS.COUNT_LABEL_ONE : SUB_ORG_LABELS.COUNT_LABEL}
            </span>
          </span>
          {pendingCount > 0 && (
            <span className="flex items-center gap-2 text-amber-400">
              <AlertTriangle className="h-4 w-4" />
              <span>
                <strong>{pendingCount}</strong>
                {' '}
                {pendingCount === 1
                  ? SUB_ORG_LABELS.PENDING_COUNT_ONE
                  : SUB_ORG_LABELS.PENDING_COUNT_MANY}
              </span>
            </span>
          )}
          {/* SCRUM-3865: the pool every allocation below draws from. */}
          {parentBalance !== null && (
            <span className="flex items-center gap-2">
              <Coins className="h-4 w-4" />
              <span>
                <strong className="text-foreground">{parentBalance}</strong>
                {' '}{SUB_ORG_LABELS.CREDITS_AVAILABLE}
              </span>
            </span>
          )}
        </div>

        {/* Sub-org list — first, because approving a waiting request is the job. */}
        {loadError ? (
          <div
            role="alert"
            className="flex flex-col items-center justify-center gap-3 py-8 text-center"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
              <AlertTriangle className="h-6 w-6 text-amber-500" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground">{SUB_ORG_LABELS.LOAD_ERROR_TITLE}</p>
              <p className="text-sm text-muted-foreground max-w-sm">{SUB_ORG_LABELS.LOAD_ERROR_DESC}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => { void handleRetry(); }} disabled={retrying}>
              <RefreshCw className={`mr-2 h-4 w-4 ${retrying ? 'animate-spin' : ''}`} />
              {SUB_ORG_LABELS.LOAD_ERROR_RETRY}
            </Button>
          </div>
        ) : subOrgs.length === 0 ? (
          /*
            The empty state used to be one sentence naming what was absent. A
            first-time admin could not tell what an affiliated organization is,
            that another org can request one, or where to start.
          */
          <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
            <Building2 className="h-10 w-10 text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground">
                {SUB_ORG_LABELS.EMPTY_STATE_TITLE}
              </p>
              <p className="text-sm text-muted-foreground max-w-md">
                {SUB_ORG_LABELS.EMPTY_STATE_BODY}
              </p>
            </div>
            {!showCreate && (
              <Button size="sm" onClick={() => setShowCreate(true)}>
                <Plus className="mr-1 h-4 w-4" />
                {SUB_ORG_LABELS.ADD_AFFILIATE_OPEN}
              </Button>
            )}
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
                  Stacks below `sm`. The previous row pinned the actions on the
                  same line, which truncated "Fabrikam Compliance" to
                  "Fabrikam C…" at 375 px — the org was identified worse than
                  its own status chip
                  (docs/uat/suborg-ux/step6a-approved-row-actions-375.png).
                */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
                      {sub.logo_url ? (
                        <img src={sub.logo_url} alt={`${sub.display_name} organization logo`} className="h-full w-full object-cover rounded-md" loading="lazy" decoding="async" width={40} height={40} />
                      ) : (
                        <Building2 className="h-5 w-5 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm font-medium break-words">{sub.display_name}</p>
                      <div className="flex flex-wrap items-center gap-2">
                        {getStatusBadge(sub.parent_approval_status)}
                        {sub.domain && (
                          <span className="text-xs text-muted-foreground break-all">{sub.domain}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                    {sub.parent_approval_status === 'PENDING' && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="flex-1 sm:flex-none text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/10"
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
                          className="flex-1 sm:flex-none text-red-400 border-red-500/20 hover:bg-red-500/10"
                          onClick={() => setRevoking(sub)}
                          disabled={actionLoading === sub.id}
                        >
                          <X className="mr-1 h-4 w-4" />
                          {SUB_ORG_LABELS.REVOKE}
                        </Button>
                      </>
                    )}
                    {/*
                      SCRUM-3868 — Offboard is the real end-of-relationship
                      action: it returns unspent credits and suspends. Revoke,
                      beside it, only severs the affiliation edge. Both now
                      confirm, and both name the organization.
                    */}
                    {sub.parent_approval_status === 'APPROVED' && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="flex-1 sm:flex-none text-red-400 border-red-500/20 hover:bg-red-500/10"
                          onClick={() => setOffboarding(sub)}
                        >
                          {SUB_ORG_LABELS.OFFBOARD}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="flex-1 sm:flex-none text-red-400 border-red-500/20 hover:bg-red-500/10"
                          onClick={() => setRevoking(sub)}
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
                      </>
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
                  <div className="mt-3 pt-3 border-t border-border/40 space-y-2">
                    {/* The balance was a bare number floated to the row edge. */}
                    {typeof childBalances[sub.id] === 'number' && (
                      <p className="text-xs text-muted-foreground">
                        <span>{SUB_ORG_LABELS.CHILD_BALANCE_LABEL}</span>:{' '}
                        <strong className="text-foreground">
                          {childBalances[sub.id]} {SUB_ORG_LABELS.CREDITS_BALANCE_SUFFIX}
                        </strong>
                      </p>
                    )}
                    <div className="flex flex-wrap items-end gap-2">
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
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/*
          Create form. Below the list and collapsed by default: the shipped
          build put these four fields between the panel header and the rows, so
          the pending request an admin came to approve was under a form they had
          no intention of filling in.
        */}
        {subOrgs.length > 0 && <Separator />}
        {showCreate ? (
          <div className="space-y-3">
            {renderCreateForm()}
            <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>
              {SUB_ORG_LABELS.ADD_AFFILIATE_CLOSE}
            </Button>
          </div>
        ) : subOrgs.length > 0 ? (
          // The empty state renders its own copy of this trigger, inline with
          // the explanation, so it is not repeated here.
          <Button variant="outline" size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="mr-1 h-4 w-4" />
            {SUB_ORG_LABELS.ADD_AFFILIATE_OPEN}
          </Button>
        ) : null}
      </CardContent>

      {/*
        SCRUM-3868 — offboarding moves money and suspends an organization, so it
        confirms. The copy states what is NOT done as well as what is: the
        sub-org's already-secured documents stay verifiable, which is the thing
        an operator most needs to be sure of before clicking. The title names
        the organization because at 375 px the row name is truncated.
      */}
      <AlertDialog open={offboarding !== null} onOpenChange={(open) => { if (!open) setOffboarding(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {SUB_ORG_LABELS.OFFBOARD_TITLE_NAMED.replace('{name}', offboarding?.display_name ?? '')}
            </AlertDialogTitle>
            <AlertDialogDescription>{SUB_ORG_LABELS.OFFBOARD_BODY}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={offboardBusy}>
              {SUB_ORG_LABELS.OFFBOARD_CANCEL}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={offboardBusy}
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={(e) => {
                e.preventDefault();
                if (offboarding) void handleOffboard(offboarding);
              }}
            >
              {offboardBusy
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : SUB_ORG_LABELS.OFFBOARD_CONFIRM}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/*
        Revoke confirmation. The body says only what revoking is verified to do
        — sever the affiliation — and explicitly points at Offboard for the
        stronger action, because the two red buttons sat side by side with
        nothing distinguishing them (§1.5: measured vs asserted vs NOT asserted).
      */}
      <AlertDialog open={revoking !== null} onOpenChange={(open) => { if (!open) setRevoking(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {SUB_ORG_LABELS.REVOKE_TITLE.replace('{name}', revoking?.display_name ?? '')}
            </AlertDialogTitle>
            <AlertDialogDescription>{SUB_ORG_LABELS.REVOKE_BODY}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading !== null}>
              {SUB_ORG_LABELS.REVOKE_CANCEL}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={actionLoading !== null}
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={(e) => {
                e.preventDefault();
                if (revoking) void handleRevoke(revoking.id);
              }}
            >
              {actionLoading !== null
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : SUB_ORG_LABELS.REVOKE_CONFIRM}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
