/**
 * Sidebar Navigation Component
 *
 * Professional sidebar with navigation links.
 */

import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  FileText,
  Building2,
  Settings,
  HelpCircle,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ArkovaLogo } from '@/components/layout/ArkovaLogo';
import { ROUTES } from '@/lib/routes';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '@/components/ui/tooltip';

interface NavItem {
  label: string;
  icon: React.ElementType;
  to: string;
}

const mainNavItems: NavItem[] = [
  { label: 'Dashboard', icon: LayoutDashboard, to: ROUTES.DASHBOARD },
  { label: 'My Records', icon: FileText, to: ROUTES.RECORDS },
  { label: 'Organization', icon: Building2, to: ROUTES.ORGANIZATION },
];

const secondaryNavItems: NavItem[] = [
  { label: 'Settings', icon: Settings, to: ROUTES.SETTINGS },
  { label: 'Help', icon: HelpCircle, to: ROUTES.HELP },
];

interface SidebarProps {
  className?: string;
}

export function Sidebar({ className }: Readonly<SidebarProps>) {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          'flex flex-col border-r bg-sidebar transition-all duration-300',
          collapsed ? 'w-16' : 'w-64',
          className
        )}
      >
        {/* Logo */}
        <div className={cn(
          'flex h-16 items-center border-b px-4',
          collapsed ? 'justify-center' : 'gap-3'
        )}>
          <ArkovaLogo size={36} />
          {!collapsed && (
            <span className="text-lg font-semibold text-sidebar-foreground">
              Arkova
            </span>
          )}
        </div>

        {/* Main Navigation */}
        <nav className="flex-1 space-y-1 p-3">
          {mainNavItems.map((item) => (
            <SidebarNavLink
              key={item.label}
              item={item}
              collapsed={collapsed}
              active={location.pathname === item.to || location.pathname.startsWith(item.to + '/')}
            />
          ))}
        </nav>

        <Separator className="mx-3" />

        {/* Secondary Navigation */}
        <nav className="space-y-1 p-3">
          {secondaryNavItems.map((item) => (
            <SidebarNavLink
              key={item.label}
              item={item}
              collapsed={collapsed}
              active={location.pathname === item.to || location.pathname.startsWith(item.to + '/')}
            />
          ))}
        </nav>

        {/* Collapse Toggle */}
        <div className="border-t p-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCollapsed(!collapsed)}
            className={cn(
              'w-full justify-center',
              !collapsed && 'justify-start'
            )}
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <>
                <ChevronLeft className="h-4 w-4 mr-2" />
                <span>Collapse</span>
              </>
            )}
          </Button>
        </div>
      </aside>
    </TooltipProvider>
  );
}

interface SidebarNavLinkProps {
  item: NavItem;
  collapsed: boolean;
  active: boolean;
}

function SidebarNavLink({ item, collapsed, active }: Readonly<SidebarNavLinkProps>) {
  const Icon = item.icon;

  const link = (
    <Link
      to={item.to}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        collapsed && 'justify-center px-2'
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span>{item.label}</span>}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">
          {item.label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return link;
}
