/**
 * Folder Form Dialog (SCRUM-2940)
 *
 * Shared create/rename dialog for a folder. Both flows only ever collect a
 * single name field, so one dialog handles both via `mode` rather than two
 * near-duplicate components. Mirrors the shape of
 * `src/components/organization/CreateOrgDialog.tsx`.
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FOLDER_LABELS } from '@/lib/copy';

interface SupabaseLikeError {
  code?: string;
  message?: string;
}

function isDuplicateNameError(err: unknown): boolean {
  const e = err as SupabaseLikeError | undefined;
  if (!e) return false;
  if (e.code === '23505') return true;
  return (e.message ?? '').toLowerCase().includes('duplicate key');
}

interface FolderFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'rename';
  initialName?: string;
  onSubmit: (name: string) => Promise<void>;
}

export function FolderFormDialog({
  open,
  onOpenChange,
  mode,
  initialName = '',
  onSubmit,
}: Readonly<FolderFormDialogProps>) {
  const [name, setName] = useState(initialName);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset local state whenever the dialog is (re)opened for a new target.
  // Adjusting state during render (rather than in a useEffect) on an
  // open-transition is the pattern React recommends for "resetting state
  // when a prop changes" — no extra render/effect round-trip.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setName(initialName);
      setError(null);
    }
  }

  const trimmed = name.trim();
  const unchanged = mode === 'rename' && trimmed === initialName.trim();
  const disabled = loading || trimmed.length === 0 || unchanged;

  const handleOpenChange = (next: boolean) => {
    if (loading) return;
    onOpenChange(next);
  };

  const handleSubmit = async () => {
    if (disabled) return;
    setLoading(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onOpenChange(false);
    } catch (err) {
      setError(
        isDuplicateNameError(err)
          ? FOLDER_LABELS.ERR_DUPLICATE_NAME
          : mode === 'create'
            ? FOLDER_LABELS.ERR_CREATE
            : FOLDER_LABELS.ERR_RENAME,
      );
    } finally {
      setLoading(false);
    }
  };

  const title = mode === 'create' ? FOLDER_LABELS.CREATE_TITLE : FOLDER_LABELS.RENAME_TITLE;
  const submitLabel = mode === 'create' ? FOLDER_LABELS.CREATE : FOLDER_LABELS.SAVE;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">{title}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="folder-name">{FOLDER_LABELS.NAME_LABEL}</Label>
            <Input
              id="folder-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={FOLDER_LABELS.NAME_PLACEHOLDER}
              disabled={loading}
              autoFocus
              maxLength={100}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !disabled) {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            {FOLDER_LABELS.CANCEL}
          </Button>
          <Button onClick={handleSubmit} disabled={disabled}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
