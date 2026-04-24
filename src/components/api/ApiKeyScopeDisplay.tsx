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
  'verify:batch': { label: API_KEY_LABELS.SCOPE_BATCH, className: 'bg-violet-50 text-violet-700 border-violet-200' },
  'usage:read': { label: API_KEY_LABELS.SCOPE_USAGE, className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  'read:search': { label: API_KEY_LABELS.SCOPE_READ_SEARCH, className: 'bg-sky-50 text-sky-700 border-sky-200' },
  'read:records': { label: API_KEY_LABELS.SCOPE_READ_RECORDS, className: 'bg-teal-50 text-teal-700 border-teal-200' },
  'read:orgs': { label: API_KEY_LABELS.SCOPE_READ_ORGS, className: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
  'write:anchors': { label: API_KEY_LABELS.SCOPE_WRITE_ANCHORS, className: 'bg-amber-50 text-amber-700 border-amber-200' },
  'admin:rules': { label: API_KEY_LABELS.SCOPE_ADMIN_RULES, className: 'bg-rose-50 text-rose-700 border-rose-200' },
  batch: { label: API_KEY_LABELS.SCOPE_BATCH, className: 'bg-violet-50 text-violet-700 border-violet-200' },
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
