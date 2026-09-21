import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FolderSidebar } from '../../src/components/folders/FolderSidebar';
import { MoveToFolderDialog } from '../../src/components/folders/MoveToFolderDialog';
import { FolderFormDialog } from '../../src/components/folders/FolderFormDialog';
import type { Folder } from '../../src/hooks/useFolders';
import '../../src/index.css';

const folders: Folder[] = [
  { id: 'legal', name: 'Legal', ownerScope: 'ORG', createdAt: '', connectorProvider: 'google_drive' },
  { id: 'signed', name: 'Signed agreements with a deliberately long destination name', ownerScope: 'ORG', parentFolderId: 'legal', createdAt: '', connectorProvider: 'docusign' },
  { id: 'private', name: 'Private workspace', ownerScope: 'USER', contextOrgId: 'org-child', createdAt: '' },
];

function Fixture() {
  const [selected, setSelected] = useState('ALL');
  const [moveOpen, setMoveOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  return <main className="mx-auto max-w-5xl p-4 sm:p-8 space-y-5">
    <h1 className="text-2xl font-semibold">Folder workspace</h1>
    <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
      <FolderSidebar folders={folders} loading={false} selected={selected} onSelect={setSelected}
        onNewFolder={(_parent, _scope, contextual) => { if (contextual) setFormOpen(true); }} canCreateOrg canCreateContextual onRename={() => undefined} onDelete={() => undefined}/>
      <section className="rounded-lg border p-4 min-w-0">
        <p className="truncate">Selected: {selected}</p>
        <button className="mt-4 rounded-md bg-primary px-4 py-2 text-primary-foreground" onClick={() => setMoveOpen(true)}>Move 2 records</button>
      </section>
    </div>
    <MoveToFolderDialog open={moveOpen} onOpenChange={setMoveOpen} folders={folders} currentFolderId={null} onSelect={async () => false}/>
    <FolderFormDialog open={formOpen} onOpenChange={setFormOpen} mode="create" privacyDescription="You and authorized organization or platform administrators can access this folder." onSubmit={async () => undefined}/>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
