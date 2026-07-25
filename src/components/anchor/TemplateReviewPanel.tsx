/**
 * TemplateReviewPanel (AI-03 MVP — SCRUM-2383)
 *
 * Review/correct step for AI-extracted credential fields:
 *  - Renders every extracted field; ALL fields are editable.
 *  - Low-confidence fields are visually flagged and REQUIRE explicit
 *    acknowledgment ("This is correct") or correction (an edit) before the
 *    parent flow may proceed — reported via `onReviewStateChange`.
 *  - Gated by ENABLE_AI_EXTRACTION: flag off → the panel renders NOTHING and
 *    reports review-complete so the flow is never blocked (absent, not broken).
 *
 * Privacy (Constitution §1.6 / 4A): this component only displays
 * server-returned, PII-stripped metadata. It renders no document bytes and
 * emits NO telemetry containing field values (locked by test).
 */

import { useEffect, useMemo, useState } from 'react';
import { Check, Pencil, ShieldCheck, Sparkles, TriangleAlert, X } from 'lucide-react';
import { isAIExtractionEnabled } from '@/lib/switchboard';
import { TEMPLATE_REVIEW_LABELS } from '@/lib/copy';
import type { ExtractionField } from '../../lib/aiExtraction';

/**
 * Fields below this confidence require acknowledgment or correction before the
 * review is complete. Matches the existing "Auto-detected" boundary used by
 * the confidence badges elsewhere in the extraction flow.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.8;

const FIELD_LABELS: Record<string, string> = {
  credentialType: 'Document Type',
  issuerName: 'Issuer',
  recipientIdentifier: 'Recipient',
  issuedDate: 'Issue Date',
  expiryDate: 'Expiry Date',
  fieldOfStudy: 'Field of Study',
  degreeLevel: 'Degree Level',
  licenseNumber: 'License / ID Number',
  accreditingBody: 'Accrediting Body',
  jurisdiction: 'Jurisdiction',
  creditHours: 'Credit Hours',
  creditType: 'Credit Type',
  barNumber: 'Bar Number',
  activityNumber: 'Activity Number',
  courseId: 'Course ID',
  providerName: 'Provider',
  approvedBy: 'Approved By',
  deliveryMethod: 'Delivery Method',
  ethicsHours: 'Ethics Hours',
};

function labelForField(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

interface TemplateReviewPanelProps {
  fields: ExtractionField[];
  overallConfidence: number;
  /** Propagates a corrected value upstream (marks the field `edited`). */
  onFieldEdit: (key: string, value: string) => void;
  /**
   * Reports whether the review requirement is satisfied: true when every
   * low-confidence field has been acknowledged or corrected (or when the
   * panel is disabled by flag / has nothing to review).
   */
  onReviewStateChange: (complete: boolean) => void;
  lowConfidenceThreshold?: number;
}

export function TemplateReviewPanel({
  fields,
  overallConfidence,
  onFieldEdit,
  onReviewStateChange,
  lowConfidenceThreshold = LOW_CONFIDENCE_THRESHOLD,
}: TemplateReviewPanelProps) {
  // null = flag unresolved (render nothing yet; do not block or unblock)
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  useEffect(() => {
    let cancelled = false;
    isAIExtractionEnabled()
      .then((value) => {
        if (!cancelled) setEnabled(value);
      })
      .catch(() => {
        // Fail closed for the PANEL (no UI), fail open for the FLOW (never
        // block securing a document because a flag read failed).
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const needsReview = useMemo(
    () =>
      fields.filter(
        (field) =>
          field.confidence < lowConfidenceThreshold &&
          field.status !== 'edited' &&
          field.status !== 'rejected' &&
          !acknowledged.has(field.key),
      ),
    [fields, lowConfidenceThreshold, acknowledged],
  );

  const reviewComplete = needsReview.length === 0;

  useEffect(() => {
    if (enabled === null) return; // flag unresolved — report nothing yet
    // Flag off → panel absent → review never blocks.
    onReviewStateChange(enabled ? reviewComplete : true);
  }, [enabled, reviewComplete, onReviewStateChange]);

  if (!enabled) return null;
  if (fields.length === 0) return null;

  const startEdit = (field: ExtractionField) => {
    setEditingKey(field.key);
    setEditValue(field.value);
  };

  const saveEdit = (key: string) => {
    onFieldEdit(key, editValue);
    setEditingKey(null);
    setEditValue('');
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setEditValue('');
  };

  const acknowledge = (key: string) => {
    setAcknowledged((prev) => new Set(prev).add(key));
  };

  return (
    <div className="glass-card rounded-xl p-6 space-y-4" data-testid="template-review-panel">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-xl bg-gradient-to-br from-primary/15 to-primary/5">
          <Sparkles className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h3 className="font-semibold text-sm">{TEMPLATE_REVIEW_LABELS.TITLE}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{TEMPLATE_REVIEW_LABELS.SUBTITLE}</p>
        </div>
      </div>

      {/* Field list */}
      <div className="space-y-2">
        {fields.map((field) => {
          const isLowConfidence =
            field.confidence < lowConfidenceThreshold && field.status !== 'edited';
          const isAcknowledged = acknowledged.has(field.key);
          const isPending = isLowConfidence && !isAcknowledged && field.status !== 'rejected';
          const isEditing = editingKey === field.key;

          return (
            <div
              key={field.key}
              data-testid={`review-field-${field.key}`}
              className={`rounded-lg border p-3 transition-all ${
                isPending
                  ? 'border-amber-400/60 bg-amber-500/5'
                  : field.status === 'edited'
                    ? 'border-blue-200 bg-blue-50/50'
                    : 'border-border'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {labelForField(field.key)}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {Math.round(field.confidence * 100)}%
                    </span>
                    {isPending && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium border text-amber-500 bg-amber-500/10 border-amber-500/20">
                        <TriangleAlert className="h-3 w-3" />
                        {TEMPLATE_REVIEW_LABELS.LOW_CONFIDENCE_BADGE}
                      </span>
                    )}
                    {field.status === 'edited' && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium border text-blue-500 bg-blue-500/10 border-blue-500/20">
                        {TEMPLATE_REVIEW_LABELS.EDITED_BADGE}
                      </span>
                    )}
                    {isLowConfidence && isAcknowledged && field.status !== 'edited' && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium border text-emerald-500 bg-emerald-500/10 border-emerald-500/20">
                        <ShieldCheck className="h-3 w-3" />
                        {TEMPLATE_REVIEW_LABELS.ACKNOWLEDGED_LABEL}
                      </span>
                    )}
                  </div>

                  {isEditing ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        data-testid={`review-input-${field.key}`}
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="flex-1 text-sm border rounded px-2 py-1 bg-background"
                        autoFocus
                      />
                      <button
                        type="button"
                        data-testid={`review-save-${field.key}`}
                        onClick={() => saveEdit(field.key)}
                        className="p-1 text-green-600 hover:bg-green-50 rounded"
                        title={TEMPLATE_REVIEW_LABELS.SAVE}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        data-testid={`review-cancel-${field.key}`}
                        onClick={cancelEdit}
                        className="p-1 text-muted-foreground hover:bg-muted/50 rounded"
                        title={TEMPLATE_REVIEW_LABELS.CANCEL}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div className="text-sm font-medium truncate">{field.value}</div>
                  )}
                </div>

                {!isEditing && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    {isPending && (
                      <button
                        type="button"
                        data-testid={`review-ack-${field.key}`}
                        onClick={() => acknowledge(field.key)}
                        className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-md border border-amber-500/40 text-amber-600 hover:bg-amber-500/10 transition-colors"
                      >
                        <Check className="h-3.5 w-3.5" />
                        {TEMPLATE_REVIEW_LABELS.ACKNOWLEDGE_LABEL}
                      </button>
                    )}
                    <button
                      type="button"
                      data-testid={`review-edit-${field.key}`}
                      onClick={() => startEdit(field)}
                      className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-md transition-colors"
                      title={TEMPLATE_REVIEW_LABELS.EDIT}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Review-state notice */}
      <div
        data-testid="template-review-notice"
        className={`flex items-center gap-2 text-xs ${
          reviewComplete ? 'text-emerald-500' : 'text-amber-500'
        }`}
      >
        {reviewComplete ? (
          <ShieldCheck className="h-3.5 w-3.5" />
        ) : (
          <TriangleAlert className="h-3.5 w-3.5" />
        )}
        <span>
          {reviewComplete
            ? TEMPLATE_REVIEW_LABELS.ALL_REVIEWED_NOTICE
            : TEMPLATE_REVIEW_LABELS.REVIEW_REQUIRED_NOTICE}
        </span>
        <span className="text-muted-foreground ml-auto">
          {Math.round(overallConfidence * 100)}%
        </span>
      </div>
    </div>
  );
}
