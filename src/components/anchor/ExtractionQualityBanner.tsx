/**
 * GME-26: Extraction Quality Banner
 *
 * Shows the PII-stripped-fields notice during the extraction review step.
 *
 * BUG-2026-07-17-009 (SCRUM-2910, P0): the fraud-signal section was removed.
 * It rendered the Gemini extraction `fraudSignals` field directly and was NOT
 * gated by ENABLE_FRAUD_DETECTION, so flipping that flag off in prod did not
 * remove the banner. Fraud data must never render in the UI.
 *
 * SCRUM-2914 (Founder UI findings, 2026-07-22): confidence-based warning
 * banners removed — extraction confidence scoring is unreliable and must not
 * be surfaced to users. The stripped-fields notice (PII-stripped / invalid
 * fields removed before anything left the browser) is unaffected.
 */

import { Info } from 'lucide-react';

interface ExtractionQualityBannerProps {
  strippedFields?: string[];
}

export function ExtractionQualityBanner({
  strippedFields,
}: ExtractionQualityBannerProps) {
  const showStrippedFields = strippedFields && strippedFields.length > 0;

  // Nothing to show
  if (!showStrippedFields) {
    return null;
  }

  return (
    <div className="space-y-2">
      {/* Stripped fields */}
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
    </div>
  );
}
