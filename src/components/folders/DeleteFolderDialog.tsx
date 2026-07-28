/**
 * Delete Folder Dialog (SCRUM-2940)
 *
 * Confirms deleting a folder. Per the DB contract (migration 0365,
 * `anchors.folder_id ... ON DELETE SET NULL`), deleting a folder never
 * deletes its records — they fall back to Unfiled. The copy must say so
 * (`FOLDER_LABELS.DELETE_CONFIRM`) so the user isn't afraid to organize.
 */

import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { FOLDER_LABELS } from '@/lib/copy';

interface DeleteFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderName: string;
  onConfirm: () => Promise<void>;
}

export function DeleteFolderDialog({
  open,
  onOpenChange,
  folderName,
  onConfirm,
}: Readonly<DeleteFolderDialogProps>) {
  const [loading, setLoading] = useState(false);

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!loading) onOpenChange(next);
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <AlertDialogTitle>{FOLDER_LABELS.DELETE_TITLE}</AlertDialogTitle>
          </div>
          <AlertDialogDescription>
            {FOLDER_LABELS.DELETE_CONFIRM(folderName)}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>{FOLDER_LABELS.CANCEL}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={loading}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {FOLDER_LABELS.DELETE_TITLE}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
