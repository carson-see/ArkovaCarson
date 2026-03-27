/**
 * Sidebar Navigation Component
 *
 * Radically simplified sidebar (Session 10):
 * - Max 5 items: Dashboard, Documents, Organization, Search, Settings
 * - Billing/Help/Developers moved to Header user dropdown
 * - Admin section behind collapsible toggle, only for platform admins
 *
 * @see MVP-07, Session 10 Sprint A
 */

import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  FileText,
  Building2,
  Settings,
  ChevronLeft,
  ChevronRight,
  X,
  Search,
  Landmark,
  Moon,
  Sun,
  Monitor,
  BarChart3,
  Activity,
  Database,
  DollarSign,
  ChevronDown,
  ChevronUp,
  Code2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ArkovaLogo } from '@/components/layout/ArkovaLogo';
import { ROUTES } from '@/lib/routes';
import { NAV_LABELS, NAV_POLISH_LABELS } from '@/lib/copy';
import { Button } from '@/components/ui/button';
import { useTheme, type Theme } from '@/hooks/useTheme';
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
  { label: NAV_LABELS.DASHBOARD, icon: LayoutDashboard, to: ROUTES.DASHBOARD },
  { label: NAV_LABELS.DOCUMENTS, icon: FileText, to: ROUTES.DOCUMENTS },
  { label: NAV_LABELS.ORGANIZATION, icon: Building2, to: ROUTES.ORGANIZATIONS },
  { label: NAV_LABELS.SEARCH, icon: Search, to: ROUTES.SEARCH },
  { label: 'Developers', icon: Code2, to: ROUTES.DEVELOPERS },
  { label: NAV_LABELS.SETTINGS, icon: Settings, to: ROUTES.SETTINGS },
];

import { isPlatformAdmin as checkPlatformAdmin } from '@/lib/platform';

const adminNavItems: NavItem[] = [
  { label: 'Overview', icon: BarChart3, to: ROUTES.ADMIN_OVERVIEW },
  { label: 'System Health', icon: Activity, to: ROUTES.ADMIN_HEALTH },
  { label: NAV_LABELS.TREASURY, icon: Landmark, to: ROUTES.ADMIN_TREASURY },
  { label: 'Pipeline', icon: Database, to: ROUTES.ADMIN_PIPELINE },
  { label: 'Organizations', icon: Building2, to: ROUTES.ADMIN_ORGANIZATIONS },
  { label: 'Payments', icon: DollarSign, to: ROUTES.ADMIN_PAYMENTS },
];

// ---------------------------------------------------------------------------
// Theme Toggle (MVP-12)
// ---------------------------------------------------------------------------

const THEME_CYCLE: Theme[] = ['light', 'dark', 'system'];
const THEME_ICONS: Record<Theme, React.ElementType> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};
const THEME_LABEL: Record<Theme, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

function ThemeToggle({ collapsed }: Readonly<{ collapsed: boolean }>) {
  const { theme, setTheme } = useTheme();

  const cycleTheme = () => {
    const idx = THEME_CYCLE.indexOf(theme);
    const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
    setTheme(next);
  };

  const Icon = THEME_ICONS[theme];

  const button = (
    <Button
      variant="ghost"
      size="sm"
      onClick={cycleTheme}
      className={cn(
        'w-full justify-center',
        !collapsed && 'justify-start'
      )}
      aria-label={`Theme: ${THEME_LABEL[theme]}. Click to cycle.`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="ml-2">{THEME_LABEL[theme]}</span>}
    </Button>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right">
          Theme: {THEME_LABEL[theme]}
        </TooltipContent>
      </Tooltip>
    );
  }

  return button;
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

interface SidebarProps {
  className?: string;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  orgName?: string | null;
  userEmail?: string | null;
}

export function Sidebar({ className, mobileOpen, onMobileClose, orgName, userEmail }: Readonly<SidebarProps>) {
  const isPlatformAdmin = checkPlatformAdmin(userEmail);
  const [collapsed, setCollapsed] = useState(false);
  const [adminExpanded, setAdminExpanded] = useState(false);
  const location = useLocation();

  // Close mobile sidebar on navigation
  useEffect(() => {
    if (mobileOpen && onMobileClose) {
      onMobileClose();
    }
    // Only trigger on pathname change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // Check if any admin route is active to auto-expand
  const isAdminActive = adminNavItems.some(
    (item) => location.pathname === item.to || location.pathname.startsWith(item.to + '/')
  );

  const isNavActive = (item: NavItem) => {
    if (item.to === ROUTES.DOCUMENTS) {
      // Documents tab should be active for /documents, /records, /my-credentials, /attestations
      return location.pathname === ROUTES.DOCUMENTS
        || location.pathname.startsWith(ROUTES.DOCUMENTS + '/')
        || location.pathname === ROUTES.RECORDS
        || location.pathname.startsWith(ROUTES.RECORDS + '/')
        || location.pathname === ROUTES.MY_CREDENTIALS
        || location.pathname === ROUTES.ATTESTATIONS;
    }
    return location.pathname === item.to || location.pathname.startsWith(item.to + '/');
  };

  const sidebarContent = (
    <aside
      className={cn(
        'flex h-full flex-col bg-[#0d141b] border-r border-white/5 transition-all duration-300',
        collapsed ? 'w-16' : 'w-64',
        className
      )}
    >
      {/* Logo + close button (mobile) */}
      <div className={cn(
        'flex h-16 items-center border-b border-white/5 px-4',
        collapsed ? 'justify-center' : 'justify-between'
      )}>
        <Link
          to={ROUTES.SEARCH}
          className={cn(
            'flex items-center rounded-lg transition-colors hover:opacity-80',
            !collapsed && 'gap-3'
          )}
          aria-label="Arkova — go to search"
        >
          <ArkovaLogo size={36} />
          {!collapsed && (
            <span className="text-lg font-semibold text-[#dce3ed]">
              Arkova
            </span>
          )}
        </Link>
        {/* Mobile close button */}
        {mobileOpen && onMobileClose && !collapsed && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onMobileClose}
            className="md:hidden shrink-0"
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Org context (UF-09) */}
      {orgName && !collapsed && (
        <div className="px-4 py-2 border-b border-white/5">
          <p className="font-mono text-[10px] font-medium uppercase tracking-widest text-[#859398]">
            {NAV_POLISH_LABELS.MANAGING_ORG}
          </p>
          <p className="text-sm font-medium text-[#dce3ed] truncate">
            {orgName}
          </p>
        </div>
      )}

      {/* Scrollable nav area */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Main Navigation — max 5 items */}
        <nav className="space-y-1 p-3">
          {mainNavItems.map((item) => (
            <SidebarNavLink
              key={item.label}
              item={item}
              collapsed={collapsed}
              active={isNavActive(item)}
            />
          ))}

          {/* Admin section — collapsible toggle, platform admins only */}
          {isPlatformAdmin && (
            <>
              {!collapsed ? (
                <button
                  onClick={() => setAdminExpanded(!adminExpanded)}
                  className="flex w-full items-center justify-between px-3 pt-4 pb-1 font-mono text-[10px] font-medium uppercase tracking-widest text-[#859398] hover:text-[#bbc9cf] transition-colors"
                >
                  <span>Admin</span>
                  {adminExpanded || isAdminActive ? (
                    <ChevronUp className="h-3 w-3" />
                  ) : (
                    <ChevronDown className="h-3 w-3" />
                  )}
                </button>
              ) : (
                <div className="my-2 border-t border-white/5" />
              )}
              {(adminExpanded || isAdminActive || collapsed) && adminNavItems.map((item) => (
                <SidebarNavLink
                  key={item.label}
                  item={item}
                  collapsed={collapsed}
                  active={location.pathname === item.to || location.pathname.startsWith(item.to + '/')}
                />
              ))}
            </>
          )}
        </nav>
      </div>

      {/* Theme Toggle + Collapse */}
      <div className="border-t border-white/5 p-3 space-y-1">
        <ThemeToggle collapsed={collapsed} />
        {/* Collapse button — desktop only (mobile uses overlay) */}
        <div className="hidden md:block">
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
                <span>{NAV_POLISH_LABELS.COLLAPSE}</span>
              </>
            )}
          </Button>
        </div>
      </div>
    </aside>
  );

  return (
    <TooltipProvider delayDuration={0}>
      {/* Desktop sidebar — hidden on mobile */}
      <div className="hidden md:flex">
        {sidebarContent}
      </div>

      {/* Mobile overlay sidebar */}
      {mobileOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/50 md:hidden"
            onClick={onMobileClose}
            aria-hidden="true"
          />
          {/* Sidebar panel — full height with overflow scroll for short screens */}
          <div className="fixed inset-y-0 left-0 z-50 md:hidden overflow-y-auto">
            {sidebarContent}
          </div>
        </>
      )}
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
        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all',
        active
          ? 'border-l-4 border-[#00d4ff] bg-[#192028] text-[#00d4ff] rounded-l-none'
          : 'border-l-4 border-transparent text-[#bbc9cf] hover:bg-[#192028]/50 hover:text-[#dce3ed]',
        collapsed && 'justify-center px-2 border-l-0'
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
