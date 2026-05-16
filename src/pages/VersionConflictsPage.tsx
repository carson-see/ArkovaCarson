/**
 * Version Conflicts Page (SCRUM-1126)
 *
 * Lists pending version conflicts for the org and allows an admin to
 * select the canonical version or skip review.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/layout';
import { OrgRequiredGate } from '@/components/auth/OrgRequiredGate';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { useVersionResolution, type VersionConflictItem } from '@/hooks/useVersionResolution';
import { VERSION_RESOLUTION_LABELS } from '@/lib/copy';
import { formatAge } from '@/lib/formatters';
import { AlertTriangle, CheckCircle, FileStack, Inbox, Loader2, RefreshCw } from 'lucide-react';

interface ConflictGroup {
  external_file_id: string;
  rows: VersionConflictItem[];
  oldest: VersionConflictItem;
}

function groupByExternalFile(items: VersionConflictItem[]): ConflictGroup[] {
  const byKey = new Map<string, VersionConflictItem[]>();
  for (const item of items) {
    const key = item.external_file_id ?? `__noid:${item.public_id}`;
    const arr = byKey.get(key) ?? [];
    arr.push(item);
    byKey.set(key, arr);
  }
  const groups: ConflictGroup[] = [];
  for (const [key, arr] of byKey) {
    arr.sort((a, b) => a.created_at.localeCompare(b.created_at));
    groups.push({ external_file_id: key, rows: arr, oldest: arr[0] });
  }
  groups.sort((a, b) => a.oldest.created_at.localeCompare(b.oldest.created_at));
  return groups;
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4" data-testid="version-conflicts-loading">
      {[1, 2, 3].map((i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-5 w-48" />
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-4 w-32" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div
      className="flex flex-col items-center justify-center py-16 text-center"
      data-testid="version-conflicts-empty"
    >
      <Inbox className="h-12 w-12 text-muted-foreground/50 mb-4" />
      <p className="text-muted-foreground text-sm">
        {VERSION_RESOLUTION_LABELS.EMPTY}
      </p>
    </div>
  );
}

function ErrorDisplay({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert variant="destructive" data-testid="version-conflicts-error">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription className="flex items-center justify-between">
        <span>{VERSION_RESOLUTION_LABELS.ERROR}</span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="h-3 w-3 mr-1" />
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function ConflictCard({
  group,
  onResolve,
  resolving,
}: {
  group: ConflictGroup;
  onResolve: (externalFileId: string, selectedPublicId: string) => void;
  resolving: boolean;
}) {
  const filename = group.oldest.filename ?? 'Unnamed document';
  const age = formatAge(group.oldest.created_at);

  return (
    <Card data-testid="version-conflict-card">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <FileStack className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <CardTitle className="text-base truncate">{filename}</CardTitle>
          </div>
          <Badge variant="secondary" className="flex-shrink-0">
            {group.rows.length} {VERSION_RESOLUTION_LABELS.SIBLING_COUNT_LABEL}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {group.rows.map((item) => (
            <div
              key={item.public_id}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 rounded-md border bg-muted/30"
            >
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground font-mono truncate">
                  {item.fingerprint.slice(0, 16)}...
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {formatAge(item.created_at)}
                </p>
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <Button
                  size="sm"
                  variant="default"
                  disabled={resolving}
                  onClick={() => onResolve(group.external_file_id, item.public_id)}
                >
                  {resolving ? (
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  ) : (
                    <CheckCircle className="h-3 w-3 mr-1" />
                  )}
                  {VERSION_RESOLUTION_LABELS.actions.APPROVE}
                </Button>
              </div>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Created {age}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function VersionConflictsInner() {
  const { items, loading, error, fetchPending, resolve } = useVersionResolution();
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    void fetchPending();
  }, [fetchPending]);

  const groups = useMemo(() => groupByExternalFile(items), [items]);

  const handleResolve = useCallback(
    async (externalFileId: string, selectedPublicId: string) => {
      setResolving(true);
      await resolve(externalFileId, selectedPublicId);
      setResolving(false);
    },
    [resolve],
  );

  if (loading && items.length === 0) {
    return <LoadingSkeleton />;
  }

  if (error && items.length === 0) {
    return <ErrorDisplay message={error} onRetry={fetchPending} />;
  }

  if (groups.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {groups.map((group) => (
        <ConflictCard
          key={group.external_file_id}
          group={group}
          onResolve={handleResolve}
          resolving={resolving}
        />
      ))}
    </div>
  );
}

export function VersionConflictsPage() {
  const { user, signOut } = useAuth();

  return (
    <AppShell user={user ?? undefined} onSignOut={signOut}>
      <OrgRequiredGate>
        <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold tracking-tight">
              {VERSION_RESOLUTION_LABELS.PAGE_TITLE}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {VERSION_RESOLUTION_LABELS.PAGE_SUBTITLE}
            </p>
          </div>
          <VersionConflictsInner />
        </div>
      </OrgRequiredGate>
    </AppShell>
  );
}

export default VersionConflictsPage;
