/**
 * Google Drive folder picker dialog (SPEC-CONNECTORS §2, §5).
 *
 * My Drive only (D2) — there is no "shared drives" affordance anywhere in
 * this component; `DRIVE_PICKER_SHARED_DRIVES_NOTE` says so directly rather
 * than the UI silently omitting a control a user might expect. Folder ids
 * are the binding (immutable); names are display-only and may go stale if a
 * folder is renamed (PM-4) — that reconciliation happens where the card
 * renders the selected list, not here.
 *
 * Mobile (< sm): renders full-width/full-height so it reads as a full-screen
 * sheet without a second component; breadcrumbs collapse to
 * `... / <current>` with the full trail behind a tap.
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Folder, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { workerFetch } from '@/lib/workerClient';
import { CONNECTORS_LABELS } from '@/lib/copy';

export const DRIVE_FOLDER_SELECTION_CAP = 20;

export interface SelectedDriveFolder {
  type: 'drive_folder';
  folder_id: string;
  folder_name: string;
}

interface DriveFolderRow {
  id: string;
  name: string;
  hasChildren: boolean | null;
  driveId: string | null;
}

interface Crumb {
  id: string;
  name: string;
}

const ERROR_COPY: Record<string, string> = {
  insufficient_drive_scope: CONNECTORS_LABELS.DRIVE_FOLDERS_SCOPE_MISSING,
  reconnect_required: CONNECTORS_LABELS.DRIVE_FOLDERS_RECONNECT,
  folder_forbidden: CONNECTORS_LABELS.DRIVE_FOLDERS_FORBIDDEN,
  folder_not_found: CONNECTORS_LABELS.DRIVE_FOLDERS_NOT_FOUND,
  drive_unavailable: CONNECTORS_LABELS.DRIVE_FOLDERS_UNAVAILABLE,
  not_connected: CONNECTORS_LABELS.DRIVE_FOLDERS_NOT_CONNECTED,
};

const RECONNECT_CODES = new Set(['insufficient_drive_scope', 'reconnect_required']);

interface DriveFolderPickerProps {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSelected: SelectedDriveFolder[];
  onDone: (selected: SelectedDriveFolder[]) => void;
  onReconnect?: () => void;
}

export function DriveFolderPicker({
  orgId,
  open,
  onOpenChange,
  initialSelected,
  onDone,
  onReconnect,
}: DriveFolderPickerProps) {
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: 'root', name: CONNECTORS_LABELS.DRIVE_PICKER_ROOT }]);
  const [rows, setRows] = useState<DriveFolderRow[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, string>>(
    () => new Map(initialSelected.map((f) => [f.folder_id, f.folder_name])),
  );

  const currentParent = crumbs[crumbs.length - 1]!.id;

  const fetchFolders = useCallback(
    async (parent: string, pageToken?: string) => {
      const params = new URLSearchParams({ org_id: orgId, parent });
      if (pageToken) params.set('page_token', pageToken);
      const res = await workerFetch(`/api/v1/integrations/google_drive/folders?${params.toString()}`, {
        method: 'GET',
      });
      const body = await res.json().catch(() => ({})) as {
        folders?: DriveFolderRow[];
        nextPageToken?: string;
        error?: { code?: string };
      };
      if (!res.ok) {
        throw new Error(body?.error?.code ?? 'internal');
      }
      return body;
    },
    [orgId],
  );

  const load = useCallback(
    async (parent: string) => {
      setLoading(true);
      setErrorCode(null);
      try {
        const body = await fetchFolders(parent);
        setRows(body.folders ?? []);
        setNextPageToken(body.nextPageToken);
      } catch (err) {
        setRows([]);
        setNextPageToken(undefined);
        setErrorCode(err instanceof Error ? err.message : 'internal');
      } finally {
        setLoading(false);
      }
    },
    [fetchFolders],
  );

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async load settles after the effect returns
    void load(currentParent);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when the dialog opens or the current folder changes
  }, [open, currentParent]);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the picker's own transient UI state (breadcrumb + selection draft) on the open transition, not synchronizing from an external system
      setCrumbs([{ id: 'root', name: CONNECTORS_LABELS.DRIVE_PICKER_ROOT }]);
      setSelected(new Map(initialSelected.map((f) => [f.folder_id, f.folder_name])));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only on open transition
  }, [open]);

  const loadMore = useCallback(async () => {
    if (!nextPageToken) return;
    setLoadingMore(true);
    try {
      const body = await fetchFolders(currentParent, nextPageToken);
      setRows((prev) => [...prev, ...(body.folders ?? [])]);
      setNextPageToken(body.nextPageToken);
    } catch (err) {
      setErrorCode(err instanceof Error ? err.message : 'internal');
    } finally {
      setLoadingMore(false);
    }
  }, [currentParent, nextPageToken, fetchFolders]);

  function openFolder(row: DriveFolderRow) {
    setCrumbs((prev) => [...prev, { id: row.id, name: row.name }]);
  }

  function jumpTo(index: number) {
    setCrumbs((prev) => prev.slice(0, index + 1));
  }

  function toggleSelected(row: DriveFolderRow) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(row.id)) {
        next.delete(row.id);
      } else {
        if (next.size >= DRIVE_FOLDER_SELECTION_CAP) return prev;
        // Names capped at 120 chars on write (§3) — trim well before the
        // schema's 500-char max, purely for the trigger_config size budget.
        next.set(row.id, row.name.slice(0, 120));
      }
      return next;
    });
  }

  function handleDone() {
    const result: SelectedDriveFolder[] = Array.from(selected.entries()).map(([folder_id, folder_name]) => ({
      type: 'drive_folder',
      folder_id,
      folder_name,
    }));
    onDone(result);
    onOpenChange(false);
  }

  const atCap = selected.size >= DRIVE_FOLDER_SELECTION_CAP;
  const mappedError = errorCode ? ERROR_COPY[errorCode] ?? CONNECTORS_LABELS.CONNECTOR_LOAD_FAILED : null;
  const isReconnectError = errorCode ? RECONNECT_CODES.has(errorCode) : false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="drive-folder-picker"
        className="flex h-[100dvh] w-screen max-w-none flex-col sm:h-auto sm:max-h-[80vh] sm:w-full sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{CONNECTORS_LABELS.DRIVE_PICKER_TITLE}</DialogTitle>
        </DialogHeader>

        <nav aria-label="breadcrumb" className="text-sm text-muted-foreground">
          {crumbs.length > 2 ? (
            <span>
              <button type="button" className="underline" onClick={() => jumpTo(0)}>
                …
              </button>
              {' / '}
              <button type="button" className="font-medium text-foreground underline" onClick={() => jumpTo(crumbs.length - 1)}>
                {crumbs[crumbs.length - 1]!.name}
              </button>
            </span>
          ) : (
            crumbs.map((c, idx) => (
              <span key={c.id}>
                {idx > 0 && ' / '}
                <button
                  type="button"
                  className={idx === crumbs.length - 1 ? 'font-medium text-foreground' : 'underline'}
                  onClick={() => jumpTo(idx)}
                >
                  {c.name}
                </button>
              </span>
            ))
          )}
        </nav>

        <p className="text-xs text-muted-foreground">{CONNECTORS_LABELS.DRIVE_PICKER_SHARED_DRIVES_NOTE}</p>

        <div className="flex-1 overflow-y-auto rounded-md border">
          {loading ? (
            <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {CONNECTORS_LABELS.DRIVE_PICKER_LOADING}
            </div>
          ) : mappedError ? (
            <div className="flex flex-col items-start gap-2 p-4">
              <p className="text-sm text-destructive">{mappedError}</p>
              {isReconnectError && onReconnect ? (
                <Button variant="outline" size="sm" onClick={onReconnect}>
                  {CONNECTORS_LABELS.CONNECTOR_RECONNECT_BUTTON}
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => void load(currentParent)}>
                  {CONNECTORS_LABELS.CONNECTOR_RETRY_BUTTON}
                </Button>
              )}
            </div>
          ) : rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{CONNECTORS_LABELS.DRIVE_PICKER_EMPTY}</p>
          ) : (
            <ul>
              {rows.map((row) => {
                const isSelected = selected.has(row.id);
                const disableCheckbox = atCap && !isSelected;
                return (
                  <li
                    key={row.id}
                    className="flex min-h-11 items-center gap-3 border-b px-3 py-2 last:border-b-0"
                  >
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleSelected(row)}
                      disabled={disableCheckbox}
                      aria-label={row.name}
                    />
                    <button
                      type="button"
                      className="flex min-h-11 flex-1 items-center gap-2 text-left text-sm"
                      onClick={() => openFolder(row)}
                    >
                      <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate" title={row.name}>
                        {row.name}
                      </span>
                      <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {nextPageToken && !loading && !mappedError && (
          <Button variant="ghost" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {CONNECTORS_LABELS.DRIVE_PICKER_LOAD_MORE}
          </Button>
        )}

        <p className="text-xs text-muted-foreground">
          <span>
            {selected.size}/{DRIVE_FOLDER_SELECTION_CAP}
          </span>
          {' — '}
          <span>{CONNECTORS_LABELS.DRIVE_FOLDERS_CAP}</span>
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleDone}>{CONNECTORS_LABELS.DRIVE_PICKER_DONE}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
