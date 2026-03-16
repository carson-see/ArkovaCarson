/**
 * API Key Scope Display (P4.5-TS-11)
 *
 * Renders scope badges for an API key.
 * Shows which permissions (verify, batch, usage) a key has.
 */

import { Badge } from '@/components/ui/badge';
import { API_KEY_LABELS } from '@/lib/copy';

const SCOPE_CONFIG: Record<string, { label: string; className: string }> = {
  verify: { label: API_KEY_LABELS.SCOPE_VERIFY, className: 'bg-blue-50 text-blue-700 border-blue-200' },
  batch: { label: API_KEY_LABELS.SCOPE_BATCH, className: 'bg-purple-50 text-purple-700 border-purple-200' },
  usage: { label: API_KEY_LABELS.SCOPE_USAGE, className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
};

interface ApiKeyScopeDisplayProps {
  scopes: string[];
  compact?: boolean;
}

export function ApiKeyScopeDisplay({ scopes, compact = false }: ApiKeyScopeDisplayProps) {
  if (compact) {
    return (
      <span className="text-xs text-muted-foreground">
        {scopes.length} scope{scopes.length !== 1 ? 's' : ''}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {scopes.map((scope) => {
        const config = SCOPE_CONFIG[scope];
        return (
          <Badge
            key={scope}
            variant="outline"
            className={`text-[10px] px-1.5 py-0 ${config?.className ?? ''}`}
          >
            {config?.label ?? scope}
          </Badge>
        );
      })}
    </div>
  );
}
