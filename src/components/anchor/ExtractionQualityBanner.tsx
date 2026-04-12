/**
 * GME-26: Extraction Quality Banner
 *
 * Shows confidence-based warning banners and fraud signals prominently
 * during the extraction review step. Helps users understand when
 * extraction results may need manual verification.
 */

import { AlertTriangle, ShieldAlert, Info } from 'lucide-react';

interface ExtractionQualityBannerProps {
  confidence: number;
  fraudSignals: string[];
  strippedFields?: string[];
}

export function ExtractionQualityBanner({
  confidence,
  fraudSignals,
  strippedFields,
}: ExtractionQualityBannerProps) {
  const showConfidenceWarning = confidence < 0.5;
  const showFraudSignals = fraudSignals.length > 0;
  const showStrippedFields = strippedFields && strippedFields.length > 0;

  // Nothing to show
  if (!showConfidenceWarning && !showFraudSignals && !showStrippedFields) {
    return null;
  }

  return (
    <div className="space-y-2">
      {/* Confidence warning */}
      {showConfidenceWarning && confidence < 0.3 && (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
          <ShieldAlert className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
          <div className="space-y-0.5 min-w-0">
            <p className="text-sm font-medium text-red-700 dark:text-red-300">
              Extraction may be unreliable
            </p>
            <p className="text-xs text-red-600/80 dark:text-red-400/80">
              Confidence is very low ({Math.round(confidence * 100)}%). Manual review recommended before finalizing.
            </p>
          </div>
        </div>
      )}

      {showConfidenceWarning && confidence >= 0.3 && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
          <div className="space-y-0.5 min-w-0">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
              Low confidence extraction
            </p>
            <p className="text-xs text-amber-600/80 dark:text-amber-400/80">
              Confidence is {Math.round(confidence * 100)}%. Please verify the extracted fields are accurate.
            </p>
          </div>
        </div>
      )}

      {/* Fraud signals */}
      {showFraudSignals && (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
          <ShieldAlert className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
          <div className="space-y-1 min-w-0">
            <p className="text-sm font-medium text-red-700 dark:text-red-300">
              Fraud signal{fraudSignals.length > 1 ? 's' : ''} detected
            </p>
            <ul className="text-xs text-red-600/80 dark:text-red-400/80 space-y-0.5">
              {fraudSignals.map((signal) => (
                <li key={signal} className="flex items-start gap-1.5">
                  <span className="shrink-0 mt-1">&#x2022;</span>
                  <span>{signal}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Stripped fields */}
      {showStrippedFields && (
        <div className="flex items-start gap-3 rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
          <Info className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
          <div className="space-y-0.5 min-w-0">
            <p className="text-sm font-medium text-blue-700 dark:text-blue-300">
              Invalid fields removed
            </p>
            <p className="text-xs text-blue-600/80 dark:text-blue-400/80">
              The following fields were not valid for this credential type and were removed:{' '}
              {strippedFields!.map((f, i) => (
                <span key={f}>
                  <code className="bg-blue-500/10 px-1 rounded text-[10px]">{f}</code>
                  {i < strippedFields!.length - 1 ? ', ' : ''}
                </span>
              ))}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
