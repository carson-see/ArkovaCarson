/**
 * RequestAffiliationDialog Component (IDT-11)
 *
 * Dialog for child orgs to request affiliation with a verified parent org.
 * Includes search for verified orgs and one-click request submission.
 */

import { useState, useCallback, useEffect } from 'react';
import {
  Building2, Search, Loader2, ShieldCheck, Link2, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { WORKER_URL } from '@/lib/workerClient';
import { supabase } from '@/lib/supabase';
import { SUB_ORG_LABELS } from '@/lib/copy';

interface VerifiedOrg {
  id: string;
  display_name: string;
  domain: string | null;
  logo_url: string | null;
  verification_status: string;
}

interface RequestAffiliationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentOrgId: string;
  onRequested?: () => void;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Not authenticated');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${session.access_token}`,
  };
}

export function RequestAffiliationDialog({
  open,
  onOpenChange,
  currentOrgId,
  onRequested,
}: RequestAffiliationDialogProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<VerifiedOrg[]>([]);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectedOrg, setSelectedOrg] = useState<VerifiedOrg | null>(null);

  // Search verified orgs
  const handleSearch = useCallback(async (query: string) => {
    setSearchQuery(query);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }

    setSearching(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from('organizations')
        .select('id, display_name, domain, logo_url, verification_status')
        .eq('verification_status', 'VERIFIED')
        .is('parent_org_id', null)
        .neq('id', currentOrgId)
        .ilike('display_name', `%${query.trim()}%`)
        .limit(10);

      if (!error && data) {
        setResults(data as VerifiedOrg[]);
      }
    } catch {
      // Silently handle search errors
    } finally {
      setSearching(false);
    }
  }, [currentOrgId]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setSearchQuery('');
      setResults([]);
      setSelectedOrg(null);
    }
  }, [open]);

  const handleRequest = useCallback(async () => {
    if (!selectedOrg) return;
    setSubmitting(true);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${WORKER_URL}/api/v1/org/sub-orgs/request`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ parentOrgId: selectedOrg.id }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) {
        toast.error(data.error ?? SUB_ORG_LABELS.REQUEST_FAILED);
        return;
      }
      toast.success(SUB_ORG_LABELS.REQUEST_SUCCESS);
      onOpenChange(false);
      onRequested?.();
    } catch {
      toast.error(SUB_ORG_LABELS.REQUEST_FAILED);
    } finally {
      setSubmitting(false);
    }
  }, [selectedOrg, onOpenChange, onRequested]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5" />
            {SUB_ORG_LABELS.REQUEST_DIALOG_TITLE}
          </DialogTitle>
          <DialogDescription>
            {SUB_ORG_LABELS.REQUEST_DIALOG_DESCRIPTION}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Search input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder={SUB_ORG_LABELS.SEARCH_PLACEHOLDER}
              className="pl-10"
            />
          </div>

          {/* Selected org */}
          {selectedOrg && (
            <div className="flex items-center justify-between p-3 rounded-lg border border-primary/30 bg-primary/5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
                  {selectedOrg.logo_url ? (
                    <img src={selectedOrg.logo_url} alt={selectedOrg.display_name} className="h-full w-full object-cover rounded-md" />
                  ) : (
                    <Building2 className="h-5 w-5 text-muted-foreground" />
                  )}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{selectedOrg.display_name}</p>
                    <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs gap-1">
                      <ShieldCheck className="h-3 w-3" />
                      Verified
                    </Badge>
                  </div>
                  {selectedOrg.domain && (
                    <p className="text-xs text-muted-foreground">{selectedOrg.domain}</p>
                  )}
                </div>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                onClick={() => setSelectedOrg(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}

          {/* Search results */}
          {!selectedOrg && searchQuery.trim().length >= 2 && (
            <div className="max-h-64 overflow-y-auto space-y-1 rounded-lg border border-border/50 p-1">
              {searching ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : results.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-6 text-center">
                  <Building2 className="h-8 w-8 text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">{SUB_ORG_LABELS.NO_RESULTS}</p>
                </div>
              ) : (
                results.map((org) => (
                  <button
                    key={org.id}
                    className="flex items-center gap-3 w-full p-2.5 rounded-md hover:bg-muted/50 transition-colors text-left"
                    onClick={() => setSelectedOrg(org)}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
                      {org.logo_url ? (
                        <img src={org.logo_url} alt={org.display_name} className="h-full w-full object-cover rounded-md" />
                      ) : (
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">{org.display_name}</p>
                        <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                      </div>
                      {org.domain && (
                        <p className="text-xs text-muted-foreground truncate">{org.domain}</p>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          )}

          {/* Submit button */}
          <Button
            className="w-full"
            onClick={handleRequest}
            disabled={!selectedOrg || submitting}
          >
            {submitting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Link2 className="mr-2 h-4 w-4" />
            )}
            {SUB_ORG_LABELS.REQUEST_AFFILIATION}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
