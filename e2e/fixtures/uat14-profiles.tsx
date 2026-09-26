import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PublicProfilePage } from '../../src/pages/PublicProfilePage';
import { IssuerRegistryPage } from '../../src/pages/IssuerRegistryPage';
import { SettingsPage } from '../../src/pages/SettingsPage';
import { OrgProfilePage } from '../../src/pages/OrgProfilePage';
import '../../src/index.css';
const view = new URLSearchParams(location.search).get('view');
const initial = view === 'org' ? '/issuer/33333333-3333-4333-8333-333333333333'
  : view === 'settings' ? '/settings'
    : view === 'org-editor' ? '/organizations/33333333-3333-4333-8333-333333333333'
      : '/profile/person-public';
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[initial]}><Routes><Route path="/profile/:profileId" element={<PublicProfilePage />} /><Route path="/issuer/:orgId" element={<IssuerRegistryPage />} /><Route path="/settings" element={<SettingsPage />} /><Route path="/organizations/:orgId" element={<OrgProfilePage />} /></Routes></MemoryRouter></QueryClientProvider>);
