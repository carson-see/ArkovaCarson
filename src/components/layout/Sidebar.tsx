/**
 * Sidebar Navigation Component
 *
 * Dark, atmospheric sidebar with glow active states and refined typography.
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
          'flex flex-col sidebar-gradient border-r border-sidebar-border transition-all duration-300 ease-out',
          collapsed ? 'w-16' : 'w-64',
          className
        )}
      >
        {/* Logo area */}
        <div className={cn(
          'flex h-16 items-center border-b border-sidebar-border',
          collapsed ? 'justify-center px-2' : 'gap-3 px-5'
        )}>
          <ArkovaLogo size={collapsed ? 28 : 32} />
          {!collapsed && (
            <span className="text-lg font-semibold tracking-tight text-white">
              Arkova
            </span>
          )}
        </div>

        {/* Main Navigation */}
        <nav className="flex-1 space-y-1 px-3 pt-5 pb-3">
          {!collapsed && (
            <p className="text-[0.625rem] font-medium uppercase tracking-[0.1em] text-sidebar-foreground/40 mb-3 px-3">
              Navigation
            </p>
          )}
          {mainNavItems.map((item) => (
            <SidebarNavLink
              key={item.label}
              item={item}
              collapsed={collapsed}
              active={location.pathname === item.to || location.pathname.startsWith(item.to + '/')}
            />
          ))}
        </nav>

        {/* Separator with subtle gradient */}
        <div className="mx-4 h-px bg-gradient-to-r from-transparent via-sidebar-border to-transparent" />

        {/* Secondary Navigation */}
        <nav className="space-y-1 px-3 py-4">
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
        <div className="border-t border-sidebar-border p-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCollapsed(!collapsed)}
            className={cn(
              'w-full text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-all duration-200',
              collapsed ? 'justify-center' : 'justify-start'
            )}
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <>
                <ChevronLeft className="h-4 w-4 mr-2" />
                <span className="text-sm">Collapse</span>
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
        'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200',
        active
          ? 'bg-sidebar-accent text-white nav-glow'
          : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground',
        collapsed && 'justify-center px-2'
      )}
    >
      <Icon className={cn(
        'h-[18px] w-[18px] shrink-0 transition-colors duration-200',
        active ? 'text-arkova-steel' : 'text-sidebar-foreground/50 group-hover:text-sidebar-foreground/80'
      )} />
      {!collapsed && <span>{item.label}</span>}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right" className="font-medium">
          {item.label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return link;
}
