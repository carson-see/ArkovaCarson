/**
 * App Shell Component
 *
 * Main layout wrapper for authenticated pages.
 * Provides consistent sidebar, header, and content area.
 */

import { Sidebar } from './Sidebar';
import { Header } from './Header';

interface AppShellProps {
  children: React.ReactNode;
  user?: {
    email?: string;
  } | null;
  profile?: {
    full_name?: string | null;
    avatar_url?: string | null;
  } | null;
  profileLoading?: boolean;
  onSignOut: () => void;
}

export function AppShell({
  children,
  user,
  profile,
  profileLoading,
  onSignOut,
}: Readonly<AppShellProps>) {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <Sidebar />

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <Header
          user={user}
          profile={profile}
          profileLoading={profileLoading}
          onSignOut={onSignOut}
        />

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          <div className="container py-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
