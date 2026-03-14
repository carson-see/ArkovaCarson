/**
 * Stat Card Component
 *
 * Glass-effect metric cards with gradient accents and hover lift.
 */

import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';

interface StatCardProps {
  label: string;
  value: number | string;
  icon: LucideIcon;
  variant?: 'default' | 'success' | 'warning' | 'primary';
  loading?: boolean;
  description?: string;
}

const variantStyles = {
  default: {
    iconBg: 'bg-muted',
    iconColor: 'text-muted-foreground',
    accentGradient: 'from-muted-foreground/20 to-transparent',
    glowClass: '',
  },
  primary: {
    iconBg: 'bg-primary/10',
    iconColor: 'text-primary',
    accentGradient: 'from-primary/30 to-transparent',
    glowClass: 'hover:shadow-glow-sm',
  },
  success: {
    iconBg: 'bg-success/10',
    iconColor: 'text-success',
    accentGradient: 'from-success/30 to-transparent',
    glowClass: 'hover:shadow-[0_0_0_1px_hsl(160_84%_39%/0.1),0_4px_20px_-4px_hsl(160_84%_39%/0.12)]',
  },
  warning: {
    iconBg: 'bg-warning/10',
    iconColor: 'text-warning',
    accentGradient: 'from-warning/30 to-transparent',
    glowClass: 'hover:shadow-[0_0_0_1px_hsl(38_92%_50%/0.1),0_4px_20px_-4px_hsl(38_92%_50%/0.1)]',
  },
};

export function StatCard({
  label,
  value,
  icon: Icon,
  variant = 'default',
  loading = false,
  description,
}: Readonly<StatCardProps>) {
  const styles = variantStyles[variant];

  if (loading) {
    return (
      <Card className="shadow-card-rest overflow-hidden">
        <CardContent className="p-6">
          <div className="flex items-center gap-4">
            <div className="h-11 w-11 rounded-xl shimmer" />
            <div className="space-y-2.5 flex-1">
              <div className="h-3.5 w-20 rounded shimmer" />
              <div className="h-7 w-14 rounded shimmer" />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn(
      'shadow-card-rest hover:shadow-card-hover transition-all duration-300 ease-out hover:-translate-y-0.5 overflow-hidden relative group',
      styles.glowClass
    )}>
      {/* Top accent line */}
      <div className={cn(
        'absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r opacity-60',
        styles.accentGradient
      )} />

      <CardContent className="p-6">
        <div className="flex items-center gap-4">
          <div
            className={cn(
              'flex h-11 w-11 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-105',
              styles.iconBg
            )}
          >
            <Icon className={cn('h-5 w-5', styles.iconColor)} />
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {label}
            </p>
            <p className="text-2xl font-bold tracking-tight mt-0.5">
              {value}
            </p>
            {description && (
              <p className="text-xs text-muted-foreground mt-1">
                {description}
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
