/**
 * Header Component
 *
 * Glassmorphism top bar with refined user menu.
 */

import { LogOut, User, Settings, ChevronDown } from 'lucide-react';
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
  const displayName = profile?.full_name || user?.email || 'User';
  const initials = getInitials(displayName);

  return (
    <header className="flex h-14 items-center justify-between border-b glass-header px-6 sticky top-0 z-10">
      {/* Page title area - can be dynamic */}
      <div>
        <h1 className="text-sm font-semibold text-foreground tracking-tight">Dashboard</h1>
      </div>

      {/* User menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="flex items-center gap-2.5 px-2 h-9 rounded-full hover:bg-muted/80 transition-all duration-200">
            {profileLoading ? (
              <>
                <Skeleton className="h-7 w-7 rounded-full" />
                <Skeleton className="h-3.5 w-20" />
              </>
            ) : (
              <>
                <Avatar className="h-7 w-7 ring-2 ring-primary/10">
                  <AvatarImage src={profile?.avatar_url || undefined} alt={displayName} />
                  <AvatarFallback className="bg-gradient-to-br from-primary/20 to-primary/5 text-primary text-[0.65rem] font-semibold">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <span className="hidden text-sm font-medium md:inline-block">
                  {displayName}
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/60" />
              </>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 animate-scale-in">
          <DropdownMenuLabel>
            <div className="flex flex-col space-y-1">
              <p className="text-sm font-medium">{displayName}</p>
              {user?.email && (
                <p className="text-xs text-muted-foreground font-normal">{user.email}</p>
              )}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="gap-2.5">
            <User className="h-4 w-4 text-muted-foreground" />
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem className="gap-2.5">
            <Settings className="h-4 w-4 text-muted-foreground" />
            Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={onSignOut}
            className="text-destructive focus:text-destructive gap-2.5"
          >
            <LogOut className="h-4 w-4" />
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
