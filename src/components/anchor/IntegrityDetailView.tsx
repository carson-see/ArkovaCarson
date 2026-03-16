/**
 * IntegrityDetailView (P8-S8)
 *
 * Full breakdown view for an integrity score.
 * Shows overall score, breakdown bars, flags, and details.
 *
 * Design: "Nordic Vault" glass card with staggered animations.
 */

import { Shield, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { IntegrityScoreBadge } from './IntegrityScoreBadge';
import type { IntegrityScore } from '@/hooks/useIntegrityScore';

interface IntegrityDetailViewProps {
  score: IntegrityScore;
  onClose?: () => void;
}

const BREAKDOWN_LABELS: Record<string, string> = {
  metadataCompleteness: 'Metadata Completeness',
  extractionConfidence: 'Extraction Confidence',
  issuerVerification: 'Issuer Verification',
  duplicateCheck: 'Duplicate Check',
  temporalConsistency: 'Temporal Consistency',
};

const FLAG_LABELS: Record<string, string> = {
  missing_issued_date: 'Missing issue date',
  future_issued_date: 'Issue date is in the future',
  very_old_credential: 'Credential is over 50 years old',
  expiry_before_issued: 'Expiry date is before issue date',
  duplicate_fingerprint: 'Duplicate document fingerprint found',
  issuer_not_in_registry: 'Issuer not found in registry',
  missing_issuer: 'Missing issuer information',
  anchor_not_found: 'Record not found',
};

function getBarColor(value: number): string {
  if (value >= 80) return 'bg-green-500';
  if (value >= 60) return 'bg-amber-500';
  if (value >= 40) return 'bg-orange-500';
  return 'bg-red-500';
}

export function IntegrityDetailView({ score, onClose }: IntegrityDetailViewProps) {
  const breakdownEntries = [
    { key: 'metadataCompleteness', value: score.metadataCompleteness },
    { key: 'extractionConfidence', value: score.extractionConfidence },
    { key: 'issuerVerification', value: score.issuerVerification },
    { key: 'duplicateCheck', value: score.duplicateCheck },
    { key: 'temporalConsistency', value: score.temporalConsistency },
  ];

  return (
    <div className="glass-card rounded-xl p-6 animate-in-view space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-gradient-to-br from-primary/15 to-primary/5">
            <Shield className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-sm">Integrity Analysis</h3>
            <p className="text-xs text-muted-foreground">
              Computed {new Date(score.computedAt).toLocaleDateString()}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <IntegrityScoreBadge score={score.overallScore} level={score.level} />
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground p-1 rounded"
            >
              <XCircle className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Score breakdown bars */}
      <div className="space-y-3">
        {breakdownEntries.map((entry, index) => (
          <div key={entry.key} className={`stagger-${Math.min(index + 1, 8)}`}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-muted-foreground">
                {BREAKDOWN_LABELS[entry.key] ?? entry.key}
              </span>
              <span className="text-xs font-mono">{entry.value}/100</span>
            </div>
            <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${getBarColor(entry.value)}`}
                style={{ width: `${entry.value}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Flags */}
      {score.flags.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Flags
          </h4>
          <div className="space-y-1.5">
            {score.flags.map((flag) => (
              <div
                key={flag}
                className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 rounded-md px-3 py-1.5 border border-amber-200"
              >
                <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                <span>{FLAG_LABELS[flag] ?? flag}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No flags — all good */}
      {score.flags.length === 0 && score.overallScore >= 80 && (
        <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 rounded-md px-3 py-1.5 border border-green-200">
          <CheckCircle2 className="h-3.5 w-3.5" />
          <span>No integrity issues detected</span>
        </div>
      )}
    </div>
  );
}
