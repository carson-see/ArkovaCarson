# agents.md — components/folders
_Last updated: 2026-07-27_

## What This Folder Contains

The UI for SCRUM-2940 (Folders). PR #1657 shipped only the data layer
(`src/hooks/useFolders.ts`, `folders` table, `anchors.folder_id` — migrations
0365/0366) with **zero** consumer: `git grep -l "useFolders" -- src/` returned
only the hook's own file. This folder is the missing consumer, wired into
`MyRecordsPage.tsx`.

## Key Files
- `FolderSidebar.tsx` — the filter list: "All Records", "Unfiled", then the
  caller's folders (from `useFolders().folders`). Each folder row carries a
  rename/delete actions menu. `New Folder` affordance opens the create dialog.
  Selection is a `FolderSelection = 'ALL' | 'UNFILED' | <folder id>` union —
  callers translate `'UNFILED'` to a `folder_id IS NULL` filter themselves.
- `FolderFormDialog.tsx` — shared create/rename dialog (`mode: 'create' |
  'rename'`). Both flows only ever collect a single name, so one dialog
  handles both rather than two near-duplicates (mirrors
  `src/components/organization/CreateOrgDialog.tsx`). Detects a Postgres
  `23505` (unique-violation — the `idx_folders_user_name_unique` /
  `idx_folders_org_name_unique` case-insensitive per-owner index from
  migration 0365) and shows `FOLDER_LABELS.ERR_DUPLICATE_NAME` instead of a
  generic error; any other rejection shows the generic create/rename error.
  The caller's `onSubmit` must reject (not swallow) on failure so this inline
  error path fires — see `MyRecordsPage.handleFolderSubmit`.
- `DeleteFolderDialog.tsx` — confirms deletion. Copy explicitly states
  records fall back to Unfiled and are **not** deleted
  (`FOLDER_LABELS.DELETE_CONFIRM`) — this matches the actual DB behavior
  (`anchors.folder_id ... ON DELETE SET NULL`, migration 0365). Do not change
  this copy to imply record deletion.
- `MoveToFolderDialog.tsx` — per-record folder-assignment picker. Selecting a
  row immediately calls `onSelect` (no separate Save step) with the folder id,
  or `null` for "Unfiled". Marks the record's current folder with
  `aria-pressed`/a check icon.
- `index.ts` — barrel exports (`FolderSidebar`, `FolderFormDialog`,
  `DeleteFolderDialog`, `MoveToFolderDialog`, `FolderSelection` type).

## Dependencies
- `@/hooks/useFolders` — `Folder` type + the create/rename/delete/assign
  mutations. This folder never talks to Supabase directly.
- `@/lib/copy` (`FOLDER_LABELS`) — every user-visible string. Do not hardcode
  folder copy in JSX (CLAUDE.md §1.3, `npm run lint:copy`).
- `@/components/ui/dialog`, `@/components/ui/alert-dialog`,
  `@/components/ui/dropdown-menu` — existing shadcn/ui primitives, matched to
  the patterns in `src/components/organization/CreateOrgDialog.tsx` and
  `src/components/organization/RevokeDialog.tsx`.

## Do / Don't Rules
- DO: Keep all folder mutations flowing through `useFolders()` — never a raw
  `supabase.from('folders')` call from a component.
- DO: Let `FolderFormDialog`'s `onSubmit` promise reject on failure so the
  inline duplicate-name/generic error renders; don't swallow errors before
  they reach the dialog.
- DO NOT: Reintroduce a "delete removes records" implication anywhere in
  folder copy — the DB contract is un-file, never delete.
- DO NOT: Test `DropdownMenu` trigger→item flows with plain `fireEvent.click`
  in jsdom — the click does not open the Radix menu (`aria-expanded` stays
  `false`). Use `@testing-library/user-event`'s `userEvent.setup()` +
  `await user.click(...)` instead (see `FolderSidebar.test.tsx`).

## Recent Changes
- 2026-07-27 SCRUM-2940 (founder escalation — PR #1657 shipped folders data
  layer with no UI): created this folder (`FolderSidebar`, `FolderFormDialog`,
  `DeleteFolderDialog`, `MoveToFolderDialog`) and wired it into
  `src/pages/MyRecordsPage.tsx` — folder filter sidebar, create/rename/delete,
  and per-record "Move to folder" / "Remove from folder" actions. Extended
  `useAnchors` (`src/hooks/useAnchors.ts`) to select+map `folder_id` →
  `Record.folderId` (additive, did not restructure the hook). See
  `src/pages/agents.md` and `src/hooks/agents.md` for the consumer-side notes.
