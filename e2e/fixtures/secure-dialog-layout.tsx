/** Isolated layout entry: real dialog/children/CSS, external boundaries mocked by Playwright. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { SecureDocumentDialog } from '../../src/components/anchor/SecureDocumentDialog';
import '../../src/index.css';

function Fixture() {
  const [open, setOpen] = useState(true);
  return <MemoryRouter><SecureDocumentDialog open={open} onOpenChange={setOpen} /></MemoryRouter>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
