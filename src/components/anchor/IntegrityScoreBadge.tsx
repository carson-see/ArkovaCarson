/**
 * IntegrityScoreBadge (P8-S8)
 *
 * Displays an integrity score as a colored badge (green/amber/red)
 * with an optional detail popover showing the breakdown.
 *
 * Design: "Nordic Vault" aesthetic — glass card, gradient badges.
 */

import { Shield, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import type { IntegrityLevel } from '@/hooks/useIntegrityScore';

interface IntegrityScoreBadgeProps {
  score: number;
  level: IntegrityLevel;
  compact?: boolean;
  showScore?: boolean;
  onClick?: () => void;
}

const LEVEL_CONFIG: Record<IntegrityLevel, {
  color: string;
  bg: string;
  border: string;
  icon: typeof ShieldCheck;
  label: string;
}> = {
  HIGH: {
    color: 'text-green-700',
    bg: 'bg-green-50',
    border: 'border-green-200',
    icon: ShieldCheck,
    label: 'High Integrity',
  },
  MEDIUM: {
    color: 'text-amber-700',
    bg: 'bg-amber-50',
    border: 'border-amber-200',
    icon: Shield,
    label: 'Medium Integrity',
  },
  LOW: {
    color: 'text-orange-700',
    bg: 'bg-orange-50',
    border: 'border-orange-200',
    icon: ShieldQuestion,
    label: 'Low Integrity',
  },
  FLAGGED: {
    color: 'text-red-700',
    bg: 'bg-red-50',
    border: 'border-red-200',
    icon: ShieldAlert,
    label: 'Flagged',
  },
};

export function IntegrityScoreBadge({
  score,
  level,
  compact = false,
  showScore = true,
  onClick,
}: IntegrityScoreBadgeProps) {
  const config = LEVEL_CONFIG[level];
  const Icon = config.icon;

  if (compact) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs font-medium border ${config.color} ${config.bg} ${config.border} transition-colors hover:opacity-80`}
        title={`${config.label}: ${score}/100`}
      >
        <Icon className="h-3 w-3" />
        {showScore && <span>{score}</span>}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border ${config.color} ${config.bg} ${config.border} transition-all hover:shadow-sm`}
    >
      <Icon className="h-4 w-4" />
      <span>{config.label}</span>
      {showScore && (
        <span className="font-mono text-xs opacity-75">{score}/100</span>
      )}
    </button>
  );
}
