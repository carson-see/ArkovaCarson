/**
 * OrgAvatar — Organization logo with initials fallback.
 *
 * Displays the organization logo if available, otherwise shows a two-letter
 * initials avatar derived from the organization's display name.
 *
 * @see MVP-13 (SCRUM-483)
 */

import { Building2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface OrgAvatarProps {
  logoUrl?: string | null;
  displayName?: string | null;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE_CLASSES = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-14 w-14 text-lg',
  lg: 'h-28 w-28 text-3xl',
} as const;

const ICON_SIZES = {
  sm: 'h-4 w-4',
  md: 'h-7 w-7',
  lg: 'h-14 w-14',
} as const;

/** Extract up to 2 initials from a display name. */
function getInitials(name: string | null | undefined): string {
  if (!name) return '';
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function OrgAvatar({ logoUrl, displayName, size = 'md', className }: Readonly<OrgAvatarProps>) {
  const sizeClass = SIZE_CLASSES[size];
  const iconSize = ICON_SIZES[size];
  const initials = getInitials(displayName);

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg bg-card overflow-hidden',
        sizeClass,
        className,
      )}
    >
      {logoUrl ? (
        <img
          src={logoUrl}
          alt={displayName ? `${displayName} logo` : 'Organization logo'}
          className="h-full w-full object-cover"
        />
      ) : initials ? (
        <span className="font-semibold text-primary select-none">{initials}</span>
      ) : (
        <Building2 className={cn('text-primary', iconSize)} />
      )}
    </div>
  );
}
