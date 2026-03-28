/**
 * Platform Controls Page
 *
 * Master admin control panel for platform operators.
 * Provides real-time switchboard flag management, pipeline kill switches,
 * and system-wide configuration controls.
 *
 * Platform admin only (carson@arkova.ai, sarah@arkova.ai).
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Shield,
  AlertTriangle,
  Power,
  RefreshCw,
  Database,
  Cpu,
  Loader2,
  History,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/lib/supabase';
import { isPlatformAdmin } from '@/lib/platform';

interface SwitchboardFlag {
  id: string;
  flag_key: string;
  enabled: boolean;
  description: string | null;
  updated_at: string;
}

interface FlagHistoryEntry {
  id: string;
  flag_id: string;
  old_value: boolean | null;
  new_value: boolean;
  changed_at: string;
  reason: string | null;
}

// Categorize flags for UI grouping
const FLAG_CATEGORIES: Record<string, { label: string; icon: typeof Shield; flags: string[] }> = {
  pipeline: {
    label: 'Data Pipeline',
    icon: Database,
    flags: [
      'ENABLE_PUBLIC_RECORDS_INGESTION',
      'ENABLE_PUBLIC_RECORD_ANCHORING',
      'ENABLE_PUBLIC_RECORD_EMBEDDINGS',
      'ENABLE_ATTESTATION_ANCHORING',
    ],
  },
  network: {
    label: 'Network & Chain',
    icon: Shield,
    flags: [
      'ENABLE_PROD_NETWORK_ANCHORING',
      'ENABLE_BATCH_ANCHORING',
    ],
  },
  ai: {
    label: 'AI & Intelligence',
    icon: Cpu,
    flags: [
      'ENABLE_AI_EXTRACTION',
      'ENABLE_AI_FRAUD',
      'ENABLE_AI_REPORTS',
      'ENABLE_SEMANTIC_SEARCH',
    ],
  },
  platform: {
    label: 'Platform & Billing',
    icon: Power,
    flags: [
      'MAINTENANCE_MODE',
      'ENABLE_NEW_CHECKOUTS',
      'ENABLE_REPORTS',
      'ENABLE_OUTBOUND_WEBHOOKS',
      'ENABLE_VERIFICATION_API',
      'ENABLE_X402_PAYMENTS',
    ],
  },
};

// Flags that are dangerous to toggle (require confirmation)
const DANGEROUS_FLAGS = new Set([
  'MAINTENANCE_MODE',
  'ENABLE_PROD_NETWORK_ANCHORING',
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = supabase as any;

export function PlatformControlsPage() {
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const isAdmin = isPlatformAdmin(user?.email);

  const handleSignOut = async () => {
    await signOut();
  };

  const [flags, setFlags] = useState<SwitchboardFlag[]>([]);
  const [history, setHistory] = useState<FlagHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const fetchFlags = useCallback(async () => {
    const { data, error } = await dbAny
      .from('switchboard_flags')
      .select('*')
      .order('flag_key');

    if (error) {
      toast.error('Failed to load switchboard flags');
      return;
    }
    setFlags((data ?? []) as SwitchboardFlag[]);
    setLoading(false);
  }, []);

  const fetchHistory = useCallback(async () => {
    const { data } = await dbAny
      .from('switchboard_flag_history')
      .select('*')
      .order('changed_at', { ascending: false })
      .limit(50);

    setHistory((data ?? []) as FlagHistoryEntry[]);
  }, []);

  useEffect(() => {
    if (isAdmin) {
      fetchFlags();
      fetchHistory();
    } else {
      setLoading(false);
    }
  }, [isAdmin, fetchFlags, fetchHistory]);

  const toggleFlag = useCallback(async (flag: SwitchboardFlag) => {
    const newValue = !flag.enabled;
    const isDangerous = DANGEROUS_FLAGS.has(flag.flag_key);

    if (isDangerous) {
      const confirmed = window.confirm(
        `⚠️ ${flag.flag_key} is a dangerous flag.\n\nAre you sure you want to ${newValue ? 'ENABLE' : 'DISABLE'} it?\n\n${flag.description ?? ''}`
      );
      if (!confirmed) return;
    }

    setToggling(flag.flag_key);

    const { error } = await dbAny
      .from('switchboard_flags')
      .update({ enabled: newValue, updated_at: new Date().toISOString() })
      .eq('id', flag.id);

    if (error) {
      toast.error(`Failed to toggle ${flag.flag_key}: ${error.message}`);
    } else {
      toast.success(`${flag.flag_key} → ${newValue ? 'ON' : 'OFF'}`);
      setFlags(prev => prev.map(f => f.id === flag.id ? { ...f, enabled: newValue } : f));
      fetchHistory();
    }

    setToggling(null);
  }, [fetchHistory]);

  if (!isAdmin) {
    return (
      <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut}>
        <div className="flex items-center justify-center h-96">
          <p className="text-muted-foreground">Access Restricted</p>
        </div>
      </AppShell>
    );
  }

  const getFlagsByCategory = (categoryFlags: string[]) =>
    flags.filter(f => categoryFlags.includes(f.flag_key));

  const _getFlagLabel = (flagKey: string) =>
    history.find(h => h.flag_id === flagKey)?.reason ?? undefined;

  return (
    <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut}>
      <div className="space-y-6 max-w-5xl mx-auto p-4 md:p-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Platform Controls</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Master switchboard for all platform features. Changes take effect immediately.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowHistory(!showHistory)}
            >
              <History className="h-4 w-4 mr-1" />
              {showHistory ? 'Hide' : 'Show'} History
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { fetchFlags(); fetchHistory(); }}
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              Refresh
            </Button>
          </div>
        </div>

        {/* Quick Actions */}
        <Card className="border-destructive/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Quick Actions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  const ingestionFlag = flags.find(f => f.flag_key === 'ENABLE_PUBLIC_RECORDS_INGESTION');
                  if (ingestionFlag) toggleFlag(ingestionFlag);
                }}
                disabled={toggling !== null}
              >
                <Power className="h-4 w-4 mr-1" />
                {flags.find(f => f.flag_key === 'ENABLE_PUBLIC_RECORDS_INGESTION')?.enabled
                  ? 'Stop Ingestion'
                  : 'Start Ingestion'}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  const anchoringFlag = flags.find(f => f.flag_key === 'ENABLE_PUBLIC_RECORD_ANCHORING');
                  if (anchoringFlag) toggleFlag(anchoringFlag);
                }}
                disabled={toggling !== null}
              >
                <Shield className="h-4 w-4 mr-1" />
                {flags.find(f => f.flag_key === 'ENABLE_PUBLIC_RECORD_ANCHORING')?.enabled
                  ? 'Stop Anchoring'
                  : 'Start Anchoring'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const maintenanceFlag = flags.find(f => f.flag_key === 'MAINTENANCE_MODE');
                  if (maintenanceFlag) toggleFlag(maintenanceFlag);
                }}
                disabled={toggling !== null}
                className={flags.find(f => f.flag_key === 'MAINTENANCE_MODE')?.enabled ? 'border-destructive text-destructive' : ''}
              >
                <AlertTriangle className="h-4 w-4 mr-1" />
                {flags.find(f => f.flag_key === 'MAINTENANCE_MODE')?.enabled
                  ? 'Exit Maintenance'
                  : 'Maintenance Mode'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Flag Categories */}
        {loading ? (
          <div className="space-y-4">
            {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-48" />)}
          </div>
        ) : (
          Object.entries(FLAG_CATEGORIES).map(([key, category]) => {
            const categoryFlags = getFlagsByCategory(category.flags);
            if (categoryFlags.length === 0) return null;
            const CategoryIcon = category.icon;

            return (
              <Card key={key}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <CategoryIcon className="h-4 w-4" />
                    {category.label}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {categoryFlags.map(flag => (
                      <div
                        key={flag.id}
                        className="flex items-center justify-between py-2 px-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <code className="text-xs font-mono">{flag.flag_key}</code>
                            {DANGEROUS_FLAGS.has(flag.flag_key) && (
                              <Badge variant="destructive" className="text-[10px] px-1 py-0">
                                DANGEROUS
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5 truncate">
                            {flag.description}
                          </p>
                          <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                            Last updated: {new Date(flag.updated_at).toLocaleString()}
                          </p>
                        </div>
                        <button
                          onClick={() => toggleFlag(flag)}
                          disabled={toggling === flag.flag_key}
                          className="ml-4 flex-shrink-0"
                          aria-label={`Toggle ${flag.flag_key}`}
                        >
                          {toggling === flag.flag_key ? (
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                          ) : flag.enabled ? (
                            <ToggleRight className="h-8 w-8 text-green-500" />
                          ) : (
                            <ToggleLeft className="h-8 w-8 text-muted-foreground" />
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}

        {/* Audit History */}
        {showHistory && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <History className="h-4 w-4" />
                Recent Changes
              </CardTitle>
            </CardHeader>
            <CardContent>
              {history.length === 0 ? (
                <p className="text-sm text-muted-foreground">No flag changes recorded.</p>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {history.map(entry => (
                    <div key={entry.id} className="flex items-center gap-3 py-1.5 px-2 rounded text-sm border-b last:border-0">
                      <Badge variant={entry.new_value ? 'default' : 'secondary'} className="text-[10px] px-1.5">
                        {entry.new_value ? 'ON' : 'OFF'}
                      </Badge>
                      <code className="text-xs font-mono flex-1 truncate">{entry.flag_id}</code>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(entry.changed_at).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
