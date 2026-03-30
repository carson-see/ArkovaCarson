/**
 * Compliance Badge (CML-01)
 *
 * Displays regulatory compliance controls applicable to a secured credential.
 * Two modes:
 *   - Summary: compact framework pills (SOC 2, GDPR, etc.)
 *   - Expanded: full control details with descriptions
 */

import { useState } from 'react';
import { ShieldCheck, ChevronDown, ChevronUp } from 'lucide-react';
import {
  getComplianceControls,
  getComplianceFrameworks,
  type ComplianceControl,
} from '@/lib/complianceMapping';

interface ComplianceBadgeProps {
  credentialType: string | null | undefined;
  isSecured: boolean;
  /** Show expanded detail view by default */
  defaultExpanded?: boolean;
  /** Compact mode — just framework pills, no expand */
  compact?: boolean;
}

export function ComplianceBadge({
  credentialType,
  isSecured,
  defaultExpanded = false,
  compact = false,
}: Readonly<ComplianceBadgeProps>) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const frameworks = getComplianceFrameworks(credentialType, isSecured);
  const controls = getComplianceControls(credentialType, isSecured);

  if (frameworks.length === 0) return null;

  if (compact) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {frameworks.map(fw => (
          <span
            key={fw}
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground"
          >
            <ShieldCheck className="h-3 w-3" />
            {fw}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <span className="text-sm font-medium">
            Compliance Controls
          </span>
          <span className="text-xs text-muted-foreground">
            {controls.length} controls across {frameworks.length} frameworks
          </span>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {!expanded && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-3">
          {frameworks.map(fw => (
            <span
              key={fw}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground"
            >
              {fw}
            </span>
          ))}
        </div>
      )}

      {expanded && (
        <div className="border-t px-4 py-3 space-y-2">
          {controls.map((control: ComplianceControl) => (
            <div key={control.id} className="flex items-start gap-3 py-1">
              <span
                className={`inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-xs font-medium ${control.color}`}
              >
                {control.label}
              </span>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {control.description}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
