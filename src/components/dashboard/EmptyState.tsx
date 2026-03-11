/**
 * Empty State Component
 *
 * Displays a friendly empty state with optional action.
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
    <div className="flex flex-col items-center justify-center py-16 px-4">
      {/* Illustration */}
      <div className="relative mb-6">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted">
          <FileText className="h-10 w-10 text-muted-foreground" />
        </div>
        {/* Decorative elements */}
        <div className="absolute -right-1 -top-1 h-4 w-4 rounded-full bg-primary/20" />
        <div className="absolute -bottom-2 -left-2 h-3 w-3 rounded-full bg-primary/10" />
      </div>

      {/* Content */}
      <h3 className="text-lg font-semibold text-foreground text-center">
        {title}
      </h3>
      <p className="mt-2 text-sm text-muted-foreground text-center max-w-sm">
        {description}
      </p>

      {/* Action */}
      {actionLabel && onAction && (
        <Button onClick={onAction} className="mt-6">
          <Plus className="mr-2 h-4 w-4" />
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
