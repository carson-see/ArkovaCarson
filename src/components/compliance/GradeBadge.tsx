/**
 * Grade Badge (NCE-10)
 *
 * Displays A/B/C/D/F grade as a color-coded badge.
 */

import { Badge } from '@/components/ui/badge';

interface GradeBadgeProps {
  grade: string;
  className?: string;
}

const VARIANTS: Record<string, string> = {
  A: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300',
  B: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300',
  C: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300',
  D: 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300',
  F: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300',
};

export function GradeBadge({ grade, className }: GradeBadgeProps) {
  return (
    <Badge variant="outline" className={`${VARIANTS[grade] ?? VARIANTS.F} font-semibold ${className ?? ''}`}>
      {grade}
    </Badge>
  );
}
