/**
 * Folder Sidebar (SCRUM-2940)
 *
 * Filter list for My Records: "All Records", "Unfiled", then the caller's
 * folders. Each folder row carries a rename/delete actions menu. This is the
 * missing UI half of `useFolders` — PR #1657 shipped the data layer with no
 * consumer (`useFolders` had zero importers outside its own file).
 */

import { MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { FOLDER_LABELS } from '@/lib/copy';
import type { Folder } from '@/hooks/useFolders';

/** Sentinel selection values alongside a real folder id. */
export type FolderSelection = 'ALL' | 'UNFILED' | string;

interface FolderSidebarProps {
  folders: Folder[];
  loading: boolean;
  selected: FolderSelection;
  onSelect: (selection: FolderSelection) => void;
  onNewFolder: () => void;
  onRename: (folder: Folder) => void;
  onDelete: (folder: Folder) => void;
}

export function FolderSidebar({
  folders,
  loading,
  selected,
  onSelect,
  onNewFolder,
  onRename,
  onDelete,
}: Readonly<FolderSidebarProps>) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          {FOLDER_LABELS.NAV_TITLE}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={onNewFolder}
          aria-label={FOLDER_LABELS.NEW_FOLDER}
        >
          <Plus className="h-4 w-4 mr-1" />
          {FOLDER_LABELS.NEW_FOLDER}
        </Button>
      </div>

      <nav aria-label={FOLDER_LABELS.NAV_TITLE} className="flex flex-col gap-0.5">
        <SidebarButton
          label={FOLDER_LABELS.ALL_RECORDS}
          active={selected === 'ALL'}
          onClick={() => onSelect('ALL')}
        />
        <SidebarButton
          label={FOLDER_LABELS.UNFILED}
          active={selected === 'UNFILED'}
          onClick={() => onSelect('UNFILED')}
        />

        <Separator className="my-2" />

        {loading ? (
          <div className="space-y-2 px-1" data-testid="folder-sidebar-loading">
            {Array.from({ length: 3 }).map((_, idx) => (
              <Skeleton key={`folder-skeleton-${idx}`} className="h-8 w-full rounded-md" />
            ))}
          </div>
        ) : folders.length === 0 ? (
          <div className="px-2 py-3">
            <p className="text-sm font-medium">{FOLDER_LABELS.EMPTY_TITLE}</p>
            <p className="text-xs text-muted-foreground mt-1">{FOLDER_LABELS.EMPTY_BODY}</p>
          </div>
        ) : (
          folders.map((folder) => (
            <div key={folder.id} className="group flex items-center gap-1">
              <SidebarButton
                label={folder.name}
                active={selected === folder.id}
                onClick={() => onSelect(folder.id)}
                className="flex-1"
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100"
                    aria-label={`${folder.name} actions`}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onRename(folder)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    {FOLDER_LABELS.RENAME_TITLE}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => onDelete(folder)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {FOLDER_LABELS.DELETE_TITLE}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))
        )}
      </nav>
    </div>
  );
}

interface SidebarButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
  className?: string;
}

function SidebarButton({ label, active, onClick, className }: Readonly<SidebarButtonProps>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'w-full truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors',
        'hover:bg-muted',
        active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground',
        className,
      )}
    >
      {label}
    </button>
  );
}
