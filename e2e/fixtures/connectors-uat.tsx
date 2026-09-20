/**
 * UAT screenshot fixture for the Connectors page (SPEC-CONNECTORS §6).
 *
 * Real ConnectorsPage + its real child components; only the auth/profile
 * hooks, the Supabase `org_integrations` reads, and `workerFetch` are
 * mocked, via `?scenario=` — same isolation technique as
 * `e2e/fixtures/secure-dialog-layout.tsx`. Drive is mocked, not the app.
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ConnectorsPage } from '../../src/pages/ConnectorsPage';
import '../../src/index.css';

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/organization/connectors']}>
    <ConnectorsPage />
  </MemoryRouter>,
);
