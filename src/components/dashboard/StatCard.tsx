/**
 * Stat Card Component
 *
 * Displays a metric with label and optional trend indicator.
 */

import { LucideIcon, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface StatCardProps {
  label: string;
  value: number | string;
  icon: LucideIcon;
  variant?: 'default' | 'success' | 'warning' | 'primary';
  loading?: boolean;
  description?: string;
  onClick?: () => void;
}

const variantStyles = {
  default: {
    iconBg: 'bg-muted',
    iconColor: 'text-muted-foreground',
  },
  primary: {
    iconBg: 'bg-primary/10',
    iconColor: 'text-primary',
  },
  success: {
    iconBg: 'bg-success/10',
    iconColor: 'text-success',
  },
  warning: {
    iconBg: 'bg-warning/10',
    iconColor: 'text-warning',
  },
};

export function StatCard({
  label,
  value,
  icon: Icon,
  variant = 'default',
  loading = false,
  description,
  onClick,
}: Readonly<StatCardProps>) {
  const styles = variantStyles[variant];

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-4">
            <Skeleton className="h-12 w-12 rounded-lg" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-7 w-12" />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card
      className={cn(
        'transition-all border-[#00d4ff]/15 hover:border-[#00d4ff]/30 bg-transparent hover:shadow-[0_0_20px_rgba(0,212,255,0.06)]',
        onClick && 'cursor-pointer'
      )}
      onClick={onClick}
    >
      <CardContent className="p-6">
        <div className="flex items-center gap-4">
          <div
            className={cn(
              'flex h-12 w-12 items-center justify-center rounded-xl',
              styles.iconBg
            )}
          >
            <Icon className={cn('h-6 w-6', styles.iconColor)} />
          </div>
          <div className="flex-1">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {label}
            </p>
            <p className="text-4xl font-black tracking-tighter font-display">
              {value}
            </p>
            {description && (
              <p className="text-xs text-muted-foreground mt-1">
                {description}
              </p>
            )}
          </div>
          {onClick && (
            <ChevronRight className="h-5 w-5 text-muted-foreground/50" />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
