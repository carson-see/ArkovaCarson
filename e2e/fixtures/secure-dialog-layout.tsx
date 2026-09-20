/** Isolated layout entry: real dialog/children/CSS, external boundaries mocked by Playwright. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { SecureDocumentDialog } from '../../src/components/anchor/SecureDocumentDialog';
import '../../src/index.css';

function Fixture() {
  const [open, setOpen] = useState(true);
  const childContext = ['selected-child', 'child-instant', 'member-zero'].includes(window.__layout.scenario);
  return (
    <MemoryRouter>
      <SecureDocumentDialog
        open={open}
        onOpenChange={setOpen}
        orgId={childContext ? 'b4444444-4444-4444-8444-444444444444' : undefined}
      />
    </MemoryRouter>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
