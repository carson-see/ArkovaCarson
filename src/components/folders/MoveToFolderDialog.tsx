/**
 * Move to Folder Dialog (SCRUM-2940)
 *
 * Per-record folder assignment picker. Lists "Unfiled" plus every folder the
 * caller owns; selecting a row immediately assigns the record (no separate
 * Save step — this mirrors a single-choice picker, not a form). Passing
 * `null` back to `useFolders().assignRecord` moves the record back to
 * Unfiled, matching the DB's nullable `anchors.folder_id` contract.
 */

import { useState } from 'react';
import { Check, FolderClosed, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { FOLDER_LABELS } from '@/lib/copy';
import type { Folder } from '@/hooks/useFolders';

interface MoveToFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folders: Folder[];
  currentFolderId: string | null;
  onSelect: (folderId: string | null) => Promise<void>;
}

export function MoveToFolderDialog({
  open,
  onOpenChange,
  folders,
  currentFolderId,
  onSelect,
}: Readonly<MoveToFolderDialogProps>) {
  const [pendingId, setPendingId] = useState<string | null | undefined>(undefined);

  const handleOpenChange = (next: boolean) => {
    if (pendingId !== undefined) return;
    onOpenChange(next);
  };

  const handleSelect = async (folderId: string | null) => {
    if (pendingId !== undefined) return;
    setPendingId(folderId);
    try {
      await onSelect(folderId);
      onOpenChange(false);
    } finally {
      setPendingId(undefined);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{FOLDER_LABELS.ASSIGN_TITLE}</DialogTitle>
          <DialogDescription className="sr-only">{FOLDER_LABELS.ASSIGN_TITLE}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1 py-2 max-h-80 overflow-y-auto">
          <FolderRow
            label={FOLDER_LABELS.UNFILED}
            selected={currentFolderId === null}
            loading={pendingId === null}
            disabled={pendingId !== undefined}
            onClick={() => handleSelect(null)}
          />

          {folders.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm font-medium">{FOLDER_LABELS.EMPTY_TITLE}</p>
              <p className="text-xs text-muted-foreground mt-1">{FOLDER_LABELS.EMPTY_BODY}</p>
            </div>
          ) : (
            folders.map((folder) => (
              <FolderRow
                key={folder.id}
                label={folder.name}
                selected={currentFolderId === folder.id}
                loading={pendingId === folder.id}
                disabled={pendingId !== undefined}
                onClick={() => handleSelect(folder.id)}
              />
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface FolderRowProps {
  label: string;
  selected: boolean;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}

function FolderRow({ label, selected, loading, disabled, onClick }: Readonly<FolderRowProps>) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
        'hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60',
        selected && 'bg-muted font-medium',
      )}
    >
      <FolderClosed className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{label}</span>
      {loading ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
      ) : (
        selected && <Check className="h-4 w-4 shrink-0" />
      )}
    </button>
  );
}
