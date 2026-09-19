import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { OrgProfilePage } from '../../src/pages/OrgProfilePage';
import { AnchorQueuePage } from '../../src/pages/AnchorQueuePage';
import '../../src/index.css';

const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={['/organizations/22222222-2222-4222-8222-222222222222']}>
      <Routes>
        <Route path="/organizations/:orgId" element={<OrgProfilePage />} />
        <Route path="/organization/queue" element={<AnchorQueuePage />} />
        <Route path="*" element={<p data-testid="navigated-route">Queue route reached</p>} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);
