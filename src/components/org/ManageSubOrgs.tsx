/**
 * ManageSubOrgs Component (IDT-11)
 *
 * Displays and manages affiliated sub-organizations for a parent org.
 * Parent org admins can approve/revoke affiliation requests and set max affiliates.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Building2, Check, X, Loader2, Link2, Settings2, Users2,
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
  const [maxSubOrgs, setMaxSubOrgs] = useState<number | null>(null);
  const [maxSubOrgsInput, setMaxSubOrgsInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [maxSaving, setMaxSaving] = useState(false);

  const fetchSubOrgs = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${WORKER_URL}/api/v1/org/sub-orgs`, { headers });
      if (!response.ok) return;
      const data = await response.json() as { subOrgs: SubOrg[]; maxSubOrgs: number | null };
      setSubOrgs(data.subOrgs);
      setMaxSubOrgs(data.maxSubOrgs);
      setMaxSubOrgsInput(data.maxSubOrgs?.toString() ?? '');
    } catch {
      // Silently handle fetch errors on load
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSubOrgs();
  }, [fetchSubOrgs, orgId]);

  const handleApprove = useCallback(async (childOrgId: string) => {
    setActionLoading(childOrgId);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${WORKER_URL}/api/v1/org/sub-orgs/approve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ childOrgId }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) {
        toast.error(data.error ?? SUB_ORG_LABELS.APPROVE_FAILED);
        return;
      }
      toast.success(SUB_ORG_LABELS.APPROVE_SUCCESS);
      await fetchSubOrgs();
    } catch {
      toast.error(SUB_ORG_LABELS.APPROVE_FAILED);
    } finally {
      setActionLoading(null);
    }
  }, [fetchSubOrgs]);

  const handleRevoke = useCallback(async (childOrgId: string) => {
    setActionLoading(childOrgId);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${WORKER_URL}/api/v1/org/sub-orgs/revoke`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ childOrgId }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) {
        toast.error(data.error ?? SUB_ORG_LABELS.REVOKE_FAILED);
        return;
      }
      toast.success(SUB_ORG_LABELS.REVOKE_SUCCESS);
      await fetchSubOrgs();
    } catch {
      toast.error(SUB_ORG_LABELS.REVOKE_FAILED);
    } finally {
      setActionLoading(null);
    }
  }, [fetchSubOrgs]);

  const handleSaveMax = useCallback(async () => {
    setMaxSaving(true);
    try {
      const headers = await getAuthHeaders();
      const value = maxSubOrgsInput.trim() === '' ? null : parseInt(maxSubOrgsInput, 10);
      if (value !== null && (isNaN(value) || value < 0)) {
        toast.error('Please enter a valid number or leave empty for no limit.');
        return;
      }
      const response = await fetch(`${WORKER_URL}/api/v1/org/sub-orgs/max`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ maxSubOrgs: value }),
      });
      if (!response.ok) {
        toast.error('Failed to update setting.');
        return;
      }
      setMaxSubOrgs(value);
      toast.success('Maximum affiliates updated.');
    } catch {
      toast.error('Failed to update setting.');
    } finally {
      setMaxSaving(false);
    }
  }, [maxSubOrgsInput]);

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
            {maxSubOrgs ? `/${maxSubOrgs}` : ''} {SUB_ORG_LABELS.COUNT_LABEL}
          </span>
        </div>

        {/* Max sub-orgs setting */}
        <div className="space-y-2">
          <Label htmlFor="max-sub-orgs" className="flex items-center gap-2 text-sm">
            <Settings2 className="h-3.5 w-3.5" />
            {SUB_ORG_LABELS.MAX_SUB_ORGS_LABEL}
          </Label>
          <p className="text-xs text-muted-foreground">{SUB_ORG_LABELS.MAX_SUB_ORGS_HINT}</p>
          <div className="flex gap-2 max-w-xs">
            <Input
              id="max-sub-orgs"
              type="number"
              min="0"
              value={maxSubOrgsInput}
              onChange={(e) => setMaxSubOrgsInput(e.target.value)}
              placeholder="No limit"
              className="w-32"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleSaveMax}
              disabled={maxSaving}
            >
              {maxSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
            </Button>
          </div>
        </div>

        <Separator />

        {/* Sub-org list */}
        {subOrgs.length === 0 ? (
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
                      <img src={sub.logo_url} alt={sub.display_name} className="h-full w-full object-cover rounded-md" />
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
