/**
 * App Shell Component
 *
 * Main layout wrapper for authenticated pages.
 * Provides sidebar, glassmorphism header, and atmospheric content area.
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

        {/* Page content with atmospheric background */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden bg-mesh-gradient">
          <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-6 animate-fade-in">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
