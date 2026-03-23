/**
 * Header Component
 *
 * Top navigation bar with user menu.
 * Session 10: Billing/Help/Developers moved from sidebar to user dropdown.
 */

import { useLocation, useNavigate } from 'react-router-dom';
import { LogOut, User, Settings, ChevronDown, CreditCard, HelpCircle, Code2, Info } from 'lucide-react';
import { Breadcrumbs } from './Breadcrumbs';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { ROUTES } from '@/lib/routes';
import { NAV_LABELS, BILLING_LABELS, MY_CREDENTIALS_LABELS, DOCUMENTS_PAGE_LABELS } from '@/lib/copy';

/** Map pathname to a display title for the header */
function getPageTitle(pathname: string): string {
  if (pathname === ROUTES.DASHBOARD) return NAV_LABELS.DASHBOARD;
  if (pathname === ROUTES.DOCUMENTS || pathname.startsWith('/documents')) return DOCUMENTS_PAGE_LABELS.PAGE_TITLE;
  if (pathname === ROUTES.RECORDS || pathname.startsWith('/records/')) return NAV_LABELS.MY_RECORDS;
  if (pathname === ROUTES.ORGANIZATION) return NAV_LABELS.ORGANIZATION;
  if (pathname === ROUTES.ORGANIZATIONS || pathname.startsWith('/organizations/')) return NAV_LABELS.ORGANIZATION;
  if (pathname === ROUTES.SETTINGS || pathname.startsWith('/settings/')) return NAV_LABELS.SETTINGS;
  if (pathname === ROUTES.HELP) return NAV_LABELS.HELP;
  if (pathname === ROUTES.BILLING || pathname.startsWith('/billing/')) return BILLING_LABELS.PAGE_TITLE;
  if (pathname === ROUTES.MY_CREDENTIALS) return MY_CREDENTIALS_LABELS.PAGE_TITLE;
  if (pathname === ROUTES.ATTESTATIONS) return 'Attestations';
  return NAV_LABELS.DASHBOARD;
}

interface HeaderProps {
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

export function Header({ user, profile, profileLoading, onSignOut }: Readonly<HeaderProps>) {
  const location = useLocation();
  const navigate = useNavigate();
  const displayName = profile?.full_name || user?.email || 'User';
  const initials = getInitials(displayName);
  const pageTitle = getPageTitle(location.pathname);

  return (
    <header className="flex h-full w-full items-center justify-between bg-background">
      {/* Page title + breadcrumbs */}
      <div className="min-w-0">
        <Breadcrumbs />
        <h1 className="text-lg font-semibold text-foreground">{pageTitle}</h1>
      </div>

      {/* User menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="flex items-center gap-2 px-2">
            {profileLoading ? (
              <>
                <Skeleton className="h-8 w-8 rounded-full" />
                <Skeleton className="h-4 w-24" />
              </>
            ) : (
              <>
                <Avatar className="h-8 w-8">
                  <AvatarImage src={profile?.avatar_url || undefined} alt={displayName} />
                  <AvatarFallback className="bg-primary/10 text-primary text-xs">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <span className="hidden text-sm font-medium md:inline-block">
                  {displayName}
                </span>
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              </>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>
            <div className="flex flex-col space-y-1">
              <p className="text-sm font-medium">{displayName}</p>
              {user?.email && (
                <p className="text-xs text-muted-foreground">{user.email}</p>
              )}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => navigate(ROUTES.SETTINGS)}>
            <User className="mr-2 h-4 w-4" />
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate(ROUTES.SETTINGS)}>
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => navigate(ROUTES.BILLING)}>
            <CreditCard className="mr-2 h-4 w-4" />
            Billing & Plans
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate(ROUTES.HELP)}>
            <HelpCircle className="mr-2 h-4 w-4" />
            Help
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate(ROUTES.DEVELOPERS)}>
            <Code2 className="mr-2 h-4 w-4" />
            Developers
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate(ROUTES.ABOUT)}>
            <Info className="mr-2 h-4 w-4" />
            About Arkova
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={onSignOut}
            className="text-destructive focus:text-destructive"
          >
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

function getInitials(name: string): string {
  const parts = name.split(/[\s@]+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}
