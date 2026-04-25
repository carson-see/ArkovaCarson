/**
 * Anchor Queue (UX-02 — SCRUM-1028). See Confluence for full spec.
 *
 * Reads /api/queue/pending, groups PENDING_RESOLUTION anchors by
 * external_file_id, and POSTs /api/queue/resolve when an admin picks a winner.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/layout';
import { OrgRequiredGate } from '@/components/auth/OrgRequiredGate';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { workerFetch } from '@/lib/workerClient';
import { supabase } from '@/lib/supabase';
import { formatAge } from '@/lib/formatters';
import { AlertTriangle, CheckCircle, Inbox, Keyboard, Loader2, Play } from 'lucide-react';

interface PendingAnchor {
  // SCRUM-1121: round-trip `public_id` (short opaque slug) instead of the
  // internal anchors.id UUID. CLAUDE.md §6 — internal ids must never leak.
  public_id: string;
  external_file_id: string | null;
  filename: string | null;
  fingerprint: string;
  created_at: string;
  sibling_count: number;
}

interface Group {
  external_file_id: string;
  rows: PendingAnchor[];
  oldest: PendingAnchor;
}

interface OrgRoleQuery {
  eq(column: string, value: string): OrgRoleQuery;
  maybeSingle(): Promise<{ data: { role?: string } | null; error: unknown }>;
}

interface OrgRoleReader {
  from(table: 'org_members'): {
    select(columns: 'role'): OrgRoleQuery;
  };
}

const POLL_INTERVAL_MS = 30_000;

function groupByExternal(rows: PendingAnchor[]): Group[] {
  const byKey = new Map<string, PendingAnchor[]>();
  for (const r of rows) {
    const key = r.external_file_id ?? `__noid:${r.public_id}`;
    const arr = byKey.get(key) ?? [];
    arr.push(r);
    byKey.set(key, arr);
  }
  const out: Group[] = [];
  for (const [key, arr] of byKey) {
    arr.sort((a, b) => a.created_at.localeCompare(b.created_at));
    out.push({ external_file_id: key, rows: arr, oldest: arr[0] });
  }
  out.sort((a, b) => a.oldest.created_at.localeCompare(b.oldest.created_at));
  return out;
}

function rowsEqual(a: PendingAnchor[], b: PendingAnchor[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].public_id !== b[i].public_id || a[i].fingerprint !== b[i].fingerprint) return false;
  }
  return true;
}

/** Builder for the header status string. Pulled out to avoid a nested ternary. */
function formatQueueStatus(loading: boolean, pendingCount: number, oldestAge: string | null): string {
  if (loading) return 'Loading…';
  if (pendingCount === 0) return 'Queue is clear.';
  const suffix = pendingCount === 1 ? '' : 's';
  const verbSuffix = pendingCount === 1 ? 's' : '';
  const agePart = oldestAge ? ` (oldest ${oldestAge})` : '';
  return `${pendingCount} item${suffix} need${verbSuffix} your review${agePart}.`;
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

function handleQueueKey(
  e: KeyboardEvent,
  groups: Group[],
  clampedFocus: number,
  setFocusIdx: React.Dispatch<React.SetStateAction<number>>,
  setShowHelp: React.Dispatch<React.SetStateAction<boolean>>,
  openDialog: (g: Group) => void,
): void {
  if (e.key === 'j' || e.key === 'ArrowDown') {
    e.preventDefault();
    setFocusIdx((i) => Math.min(i + 1, Math.max(0, groups.length - 1)));
    return;
  }
  if (e.key === 'k' || e.key === 'ArrowUp') {
    e.preventDefault();
    setFocusIdx((i) => Math.max(i - 1, 0));
    return;
  }
  if (e.key === 'e') {
    // Intentionally NOT Enter — a focused button/link swallows Enter, so
    // letting it also open the dialog double-fires on native click.
    const g = groups[clampedFocus];
    if (g) openDialog(g);
    return;
  }
  if (e.key === '?') setShowHelp((v) => !v);
}

/** Keyboard shortcut handler for QueueInner. Extracted so the parent
 *  function's cognitive complexity stays under Sonar's 15 cap.
 */
function useQueueKeyboardShortcuts(args: {
  groups: Group[];
  clampedFocus: number;
  dialogGroup: Group | null;
  setFocusIdx: React.Dispatch<React.SetStateAction<number>>;
  setShowHelp: React.Dispatch<React.SetStateAction<boolean>>;
  openDialog: (g: Group) => void;
}): void {
  const { groups, clampedFocus, dialogGroup, setFocusIdx, setShowHelp, openDialog } = args;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (dialogGroup) return;
      if (isEditableTarget(e.target)) return;
      handleQueueKey(e, groups, clampedFocus, setFocusIdx, setShowHelp, openDialog);
    }
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [groups, clampedFocus, dialogGroup, setFocusIdx, setShowHelp, openDialog]);
}

/**
 * Poll `cb` every `intervalMs`. Skips when the tab is hidden and catches up
 * when the tab becomes visible again. Extracted from QueueInner so Sonar's
 * cognitive-complexity check stays under 15 and the polling contract is
 * reusable.
 */
function useVisibilityAwarePolling(cb: () => Promise<unknown>, intervalMs: number): void {
  useEffect(() => {
    const swallow = (p: Promise<unknown>) => {
      // fetchPending handles its own errors + sets `error` state. Swallow
      // here to satisfy TS/Sonar — `void p` triggers no-void rule.
      p.catch(() => undefined);
    };
    swallow(cb());
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      swallow(cb());
    }, intervalMs);
    function onVisibilityChange() {
      if (!document.hidden) swallow(cb());
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    return () => {
      clearInterval(id);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [cb, intervalMs]);
}

function canRunAnchoringJob(profileRole?: string | null, isPlatformAdmin?: boolean, orgRole?: string | null): boolean {
  return (
    profileRole === 'ORG_ADMIN' ||
    isPlatformAdmin === true ||
    orgRole === 'owner' ||
    orgRole === 'admin'
  );
}

function QueueInner() {
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<PendingAnchor[]>([]);
  const [dialogGroup, setDialogGroup] = useState<Group | null>(null);
  const [selectedPublicId, setSelectedPublicId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [running, setRunning] = useState(false);
  const [runMessage, setRunMessage] = useState<string | null>(null);
  const [orgRole, setOrgRole] = useState<string | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const [showHelp, setShowHelp] = useState(false);

  const fetchPending = useCallback(async () => {
    setError(null);
    try {
      const res = await workerFetch('/api/queue/pending?limit=100', { method: 'GET' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(body.error?.message ?? `Failed to fetch queue (${res.status})`);
      }
      const body = (await res.json()) as { items: PendingAnchor[] };
      const items = Array.isArray(body.items) ? body.items : [];
      // Preserve reference when payload is unchanged — keeps the grouping
      // memo stable across 30s poll ticks on an idle queue, which is the
      // common case at 10K DAU.
      setRows((prev) => (rowsEqual(prev, items) ? prev : items));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch queue');
    } finally {
      setLoading(false);
    }
  }, []);

  useVisibilityAwarePolling(fetchPending, POLL_INTERVAL_MS);

  useEffect(() => {
    let cancelled = false;
    async function loadOrgRole() {
      if (!user?.id || !profile?.org_id) {
        setOrgRole(null);
        return;
      }
      try {
        const { data, error: roleError } = await (supabase as unknown as OrgRoleReader)
          .from('org_members')
          .select('role')
          .eq('user_id', user.id)
          .eq('org_id', profile.org_id)
          .maybeSingle();
        if (!cancelled) {
          setOrgRole(roleError ? null : ((data as { role?: string } | null)?.role ?? null));
        }
      } catch {
        if (!cancelled) setOrgRole(null);
      }
    }
    void loadOrgRole();
    return () => {
      cancelled = true;
    };
  }, [profile?.org_id, user?.id]);

  const groups = useMemo(() => groupByExternal(rows), [rows]);
  const clampedFocus = Math.min(Math.max(focusIdx, 0), Math.max(0, groups.length - 1));

  useQueueKeyboardShortcuts({
    groups,
    clampedFocus,
    dialogGroup,
    setFocusIdx,
    setShowHelp,
    openDialog,
  });

  function openDialog(g: Group): void {
    setDialogGroup(g);
    setSelectedPublicId(g.rows[0]?.public_id ?? null);
    setReason('');
  }

  async function resolve(): Promise<void> {
    if (!dialogGroup || !selectedPublicId) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await workerFetch('/api/queue/resolve', {
        method: 'POST',
        body: JSON.stringify({
          external_file_id: dialogGroup.external_file_id,
          selected_public_id: selectedPublicId,
          reason: reason.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(body.error?.message ?? `Resolve failed (${res.status})`);
      }
      setDialogGroup(null);
      await fetchPending();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resolve failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function runQueue(): Promise<void> {
    setRunning(true);
    setError(null);
    setRunMessage(null);
    try {
      const res = await workerFetch('/api/queue/run', { method: 'POST' }, 120_000);
      const body = (await res.json().catch(() => ({}))) as {
        processed?: number;
        batchId?: string | null;
        txId?: string | null;
        error?: { message?: string };
      };
      if (!res.ok) {
        throw new Error(body.error?.message ?? `Run failed (${res.status})`);
      }
      const processed = body.processed ?? 0;
      const suffix = processed === 1 ? '' : 's';
      let message = 'Run complete. No pending anchors were ready to submit.';
      if (processed > 0) {
        const batchPart = body.batchId ? ` in ${body.batchId}` : '';
        message = `Run complete. ${processed} anchor${suffix} submitted${batchPart}.`;
      }
      setRunMessage(message);
      await fetchPending();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Run failed');
    } finally {
      setRunning(false);
    }
  }

  const pendingCount = rows.length;
  const oldestAge = groups[0] ? formatAge(groups[0].oldest.created_at) : null;
  const canRunQueue = canRunAnchoringJob(profile?.role, profile?.is_platform_admin, orgRole);

  return (
    <AppShell
      user={user ?? undefined}
      onSignOut={signOut}
      profile={profile ?? undefined}
      profileLoading={profileLoading}
    >
      <div className="mx-auto max-w-5xl p-4 md:p-6 space-y-4 md:space-y-6">
        <header className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Review queue</h1>
            <p
              className="text-sm text-muted-foreground"
              aria-live="polite"
            >
              {formatQueueStatus(loading, pendingCount, oldestAge)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canRunQueue && (
              <Button
                onClick={runQueue}
                disabled={running}
                data-testid="queue-run"
              >
                {running ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden="true" />
                ) : (
                  <Play className="h-4 w-4 mr-1" aria-hidden="true" />
                )}
                {running ? 'Running…' : 'Run'}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => setShowHelp(true)}
              aria-label="Show keyboard shortcuts"
            >
              <Keyboard className="h-4 w-4 mr-1" aria-hidden="true" /> Shortcuts
            </Button>
          </div>
        </header>

        {runMessage && (
          <Alert>
            <CheckCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>{runMessage}</AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!loading && pendingCount === 0 ? (
          <Card>
            <CardContent className="py-10 text-center space-y-3">
              <Inbox className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden="true" />
              <p className="font-medium">You're all caught up.</p>
              <p className="text-sm text-muted-foreground">
                When our rules flag a collision, it'll show up here.
              </p>
            </CardContent>
          </Card>
        ) : (
          <ol
            className="space-y-3"
            aria-label="Pending resolution groups"
          >
            {groups.map((g, idx) => {
              const focused = idx === clampedFocus;
              return (
                <li key={g.external_file_id}>
                  <Card
                    data-testid={`queue-group-${g.external_file_id}`}
                    className={focused ? 'ring-2 ring-primary' : undefined}
                  >
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex flex-wrap items-center gap-2">
                        <span className="truncate">
                          {g.oldest.filename ?? g.external_file_id}
                        </span>
                        <Badge variant="outline">
                          {g.rows.length} version{g.rows.length === 1 ? '' : 's'}
                        </Badge>
                        <Badge variant="secondary">age {formatAge(g.oldest.created_at)}</Badge>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                      <div className="text-xs text-muted-foreground break-all">
                        <div>external_file_id: {g.external_file_id}</div>
                        <div>latest fingerprint: {(g.rows[g.rows.length - 1].fingerprint ?? '').slice(0, 18)}…</div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          onClick={() => openDialog(g)}
                          data-testid={`queue-review-${g.external_file_id}`}
                        >
                          Review
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ol>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}
      </div>

      <Dialog open={!!dialogGroup} onOpenChange={(o) => !o && setDialogGroup(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pick the version to keep</DialogTitle>
            <DialogDescription>
              The version you pick flips to PENDING and anchors. The other
              versions move to REVOKED with an audit record.
            </DialogDescription>
          </DialogHeader>
          {dialogGroup && (
            <div className="space-y-4">
              <ul className="space-y-2">
                {dialogGroup.rows.map((r) => {
                  const checked = selectedPublicId === r.public_id;
                  return (
                    <li key={r.public_id}>
                      <label
                        className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer ${
                          checked ? 'border-primary bg-primary/5' : 'border-border'
                        }`}
                      >
                        <input
                          type="radio"
                          name="winner"
                          value={r.public_id}
                          checked={checked}
                          onChange={() => setSelectedPublicId(r.public_id)}
                          className="mt-1"
                        />
                        <div className="text-sm space-y-1 break-all">
                          <div className="font-medium">{r.filename ?? r.public_id}</div>
                          <div className="text-xs text-muted-foreground">
                            fingerprint: {r.fingerprint}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            created {new Date(r.created_at).toLocaleString()}
                          </div>
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <div className="space-y-2">
                <Label htmlFor="resolve-reason">Reason (optional, stored in audit)</Label>
                <Input
                  id="resolve-reason"
                  value={reason}
                  maxLength={2000}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Kept the latest version signed by counsel…"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogGroup(null)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              onClick={resolve}
              disabled={!selectedPublicId || submitting}
              data-testid="queue-resolve-submit"
            >
              {submitting ? 'Resolving…' : (
                <>
                  <CheckCircle className="h-4 w-4 mr-1" aria-hidden="true" /> Keep this version
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showHelp} onOpenChange={setShowHelp}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
          </DialogHeader>
          <ul className="text-sm space-y-1">
            <li><kbd>J</kbd> / <kbd>↓</kbd> — next item</li>
            <li><kbd>K</kbd> / <kbd>↑</kbd> — previous item</li>
            <li><kbd>E</kbd> / <kbd>Enter</kbd> — review highlighted item</li>
            <li><kbd>?</kbd> — toggle this help</li>
          </ul>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

export function AnchorQueuePage() {
  return (
    <OrgRequiredGate
      title="Queue needs an organization"
      explanation="Create or join an organization to see queued documents."
    >
      <QueueInner />
    </OrgRequiredGate>
  );
}

export default AnchorQueuePage;
