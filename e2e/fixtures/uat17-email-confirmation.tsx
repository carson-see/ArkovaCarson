import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { SignUpForm } from '../../src/components/auth/SignUpForm';
import { AuthCallbackPage } from '../../src/pages/AuthCallbackPage';
import '../../src/index.css';

// Development-only entry: production components, simulated external Auth in
// Playwright. This fixture never claims real delivery or MFA enforcement.
const callback = new URLSearchParams(window.location.search).get('view') === 'callback';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MemoryRouter>
      {callback ? <AuthCallbackPage /> : (
        <main className="min-h-screen bg-background px-4 py-8">
          <div className="mx-auto w-full max-w-md"><SignUpForm /></div>
        </main>
      )}
    </MemoryRouter>
  </React.StrictMode>,
);
