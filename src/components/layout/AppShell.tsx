/**
 * App Shell Component
 *
 * Main layout wrapper for authenticated pages.
 * Provides consistent sidebar, header, and content area.
 * Responsive: hamburger menu on mobile (<md).
 *
 * @see MVP-07
 */

import { useState, useCallback } from 'react';
import { Menu, ShieldCheck } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { Button } from '@/components/ui/button';
import { useAuditorMode } from '@/hooks/useAuditorMode';
import { ERROR_BOUNDARY_LABELS } from '@/lib/copy';

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
  orgName?: string | null;
}

export function AppShell({
  children,
  user,
  profile,
  profileLoading,
  onSignOut,
  orgName,
}: Readonly<AppShellProps>) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { isAuditorMode } = useAuditorMode();

  const handleCloseMobile = useCallback(() => {
    setMobileOpen(false);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Skip to main content — keyboard accessibility (AUDIT-09) */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground focus:shadow-lg focus:outline-none"
      >
        {ERROR_BOUNDARY_LABELS.SKIP_TO_CONTENT}
      </a>

      {/* Sidebar */}
      <Sidebar
        mobileOpen={mobileOpen}
        onMobileClose={handleCloseMobile}
        orgName={orgName}
        userEmail={user?.email}
      />

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header with mobile hamburger */}
        <div className="flex h-14 items-center border-b border-white/[0.06] bg-[#0c1219] px-4 md:px-6">
          {/* Mobile hamburger */}
          <Button
            variant="ghost"
            size="sm"
            className="mr-2 md:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </Button>

          <div className="flex-1">
            <Header
              user={user}
              profile={profile}
              profileLoading={profileLoading}
              onSignOut={onSignOut}
            />
          </div>
        </div>

        {/* VAI-04: Auditor mode banner */}
        {isAuditorMode && (
          <div className="flex items-center gap-2 px-4 py-1.5 bg-[#00d4ff]/10 border-b border-[#00d4ff]/20 text-xs text-[#00d4ff]">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span className="font-medium">Auditor Mode</span>
            <span className="text-[#00d4ff]/60">— Read-only compliance view. Write actions are hidden.</span>
          </div>
        )}

        {/* Page content with atmospheric background */}
        <main id="main-content" className="flex-1 overflow-y-auto overflow-x-hidden bg-mesh-gradient">
          <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-4 md:py-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
