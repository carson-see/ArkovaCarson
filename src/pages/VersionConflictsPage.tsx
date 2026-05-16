/**
 * VersionConflictsPage (SCRUM-1972 / SCRUM-1126)
 *
 * Admin page for reviewing and resolving version conflicts detected
 * by connector rules. Shows pending conflicts with approve/skip/flag actions.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileWarning, CheckCircle2, SkipForward, Flag, RefreshCw } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useVersionResolution } from '@/hooks/useVersionResolution';
import type { VersionConflictItem, ResolutionDecision } from '@/hooks/useVersionResolution';
import { AppShell } from '@/components/layout';
import { VERSION_RESOLUTION_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';
import { toast } from 'sonner';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function SourceBadge({ source }: { source: string }) {
  const label = source.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-muted border border-border text-muted-foreground">
      {label}
    </span>
  );
}

function ConflictCard({
  item,
  onResolve,
}: {
  item: VersionConflictItem;
  onResolve: (id: string, decision: ResolutionDecision, notes: string) => void;
}) {
  const [notes, setNotes] = useState('');

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <FileWarning className="h-5 w-5 text-amber-500 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium truncate">{item.filename ?? 'Unknown document'}</p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
              <SourceBadge source={item.source} />
              <span>{VERSION_RESOLUTION_LABELS.VERSION_LABEL} {item.version_number}</span>
              <span>&middot;</span>
              <span>{formatDate(item.created_at)}</span>
            </div>
          </div>
        </div>
      </div>

      <input
        type="text"
        value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder={VERSION_RESOLUTION_LABELS.NOTES_PLACEHOLDER}
        className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background"
      />

      <div className="flex items-center gap-2">
        <button
          onClick={() => onResolve(item.id, 'approve', notes)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md text-green-700 hover:bg-green-50 border border-green-200"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          {VERSION_RESOLUTION_LABELS.ACTION_APPROVE}
        </button>
        <button
          onClick={() => onResolve(item.id, 'skip', notes)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md text-muted-foreground hover:bg-muted/50 border border-border"
        >
          <SkipForward className="h-3.5 w-3.5" />
          {VERSION_RESOLUTION_LABELS.ACTION_SKIP}
        </button>
        <button
          onClick={() => onResolve(item.id, 'flag', notes)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md text-red-700 hover:bg-red-50 border border-red-200"
        >
          <Flag className="h-3.5 w-3.5" />
          {VERSION_RESOLUTION_LABELS.ACTION_FLAG}
        </button>
      </div>
    </div>
  );
}

export function VersionConflictsPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { items, loading, error, fetchPending, resolve } = useVersionResolution();

  useEffect(() => {
    fetchPending();
  }, [fetchPending]);

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  const handleResolve = async (versionId: string, decision: ResolutionDecision, notes: string) => {
    const result = await resolve(versionId, decision, notes);
    if (result?.success) {
      toast.success(VERSION_RESOLUTION_LABELS.ACTION_SUCCESS);
      fetchPending();
    }
  };

  return (
    <AppShell
      user={user}
      profile={profile}
      profileLoading={profileLoading}
      onSignOut={handleSignOut}
    >
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {VERSION_RESOLUTION_LABELS.PAGE_TITLE}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {VERSION_RESOLUTION_LABELS.PAGE_SUBTITLE}
            </p>
          </div>
          <button
            onClick={fetchPending}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-input hover:bg-accent"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {error && (
          <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading && (
          <div data-testid="version-conflicts-loading" className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="rounded-lg border border-border bg-card p-4 animate-pulse">
                <div className="h-5 bg-muted rounded w-1/3 mb-2" />
                <div className="h-4 bg-muted rounded w-1/4" />
              </div>
            ))}
          </div>
        )}

        {!loading && items.length === 0 && !error && (
          <div className="text-center py-12 border border-dashed border-border rounded-lg">
            <FileWarning className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm font-medium text-muted-foreground">
              {VERSION_RESOLUTION_LABELS.EMPTY}
            </p>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
              {VERSION_RESOLUTION_LABELS.EMPTY_DETAIL}
            </p>
          </div>
        )}

        {!loading && items.length > 0 && (
          <div className="space-y-3">
            {items.map(item => (
              <ConflictCard key={item.id} item={item} onResolve={handleResolve} />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
