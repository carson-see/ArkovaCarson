/**
 * Empty State Component
 *
 * Atmospheric empty state with floating decorative particles and bold CTA.
 */

import { FileText, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface EmptyStateProps {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: Readonly<EmptyStateProps>) {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-4">
      {/* Illustration with floating particles */}
      <div className="relative mb-8">
        {/* Background glow */}
        <div className="absolute inset-0 scale-[2] bg-primary/[0.04] rounded-full blur-2xl" />

        {/* Main icon container */}
        <div className="relative flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/10 to-primary/5 ring-1 ring-primary/10">
          <FileText className="h-9 w-9 text-primary/60" />
        </div>

        {/* Floating particles */}
        <div className="absolute -right-3 -top-2 h-3 w-3 rounded-full bg-primary/25 animate-float" />
        <div className="absolute -bottom-3 -left-4 h-2 w-2 rounded-full bg-success/25 animate-float-delayed" />
        <div className="absolute top-1 -left-5 h-1.5 w-1.5 rounded-full bg-accent/30 animate-float-slow" />
      </div>

      {/* Content */}
      <h3 className="text-heading-sm font-semibold text-foreground text-center tracking-tight">
        {title}
      </h3>
      <p className="mt-2.5 text-sm text-muted-foreground text-center max-w-xs leading-relaxed">
        {description}
      </p>

      {/* Action */}
      {actionLabel && onAction && (
        <Button
          onClick={onAction}
          className="mt-8 shadow-glow-sm hover:shadow-glow-md transition-all duration-300"
          size="lg"
        >
          <Plus className="mr-2 h-4 w-4" />
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
