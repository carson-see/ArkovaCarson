import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { SignUpForm } from '../../src/components/auth/SignUpForm';
import { AuthCallbackPage } from '../../src/pages/AuthCallbackPage';
import { AddExistingMemberModal } from '../../src/components/organization/AddExistingMemberModal';
import '../../src/index.css';

// Development-only entry: production components, simulated external Auth in
// Playwright. This fixture never claims real delivery or MFA enforcement.
const callback = new URLSearchParams(window.location.search).get('view') === 'callback';
const member = new URLSearchParams(window.location.search).get('view') === 'member';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MemoryRouter>
      {callback ? <AuthCallbackPage /> : member ? (
        <AddExistingMemberModal
          open
          onOpenChange={() => undefined}
          orgId="11111111-1111-4111-8111-111111111111"
          onMemberAdded={() => undefined}
        />
      ) : (
        <main className="min-h-screen bg-background px-4 py-8">
          <div className="mx-auto w-full max-w-md"><SignUpForm /></div>
        </main>
      )}
    </MemoryRouter>
  </React.StrictMode>,
);
