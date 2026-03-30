/**
 * AIFieldSuggestions (P8-S5)
 *
 * Displays AI-extracted credential fields with confidence badges
 * and accept/reject/edit controls per field.
 *
 * Constitution 4A: This component only displays server-returned metadata.
 * No document bytes or raw OCR text are rendered or stored.
 *
 * Design: "Nordic Vault" aesthetic with glass cards and stagger animations.
 */

import { useState } from 'react';
import { Check, X, Pencil, Sparkles, AlertTriangle, ArrowUp, ArrowDown } from 'lucide-react';
import type { ExtractionField, ExtractionProgress } from '../../lib/aiExtraction';

interface AIFieldSuggestionsProps {
  fields: ExtractionField[];
  overallConfidence: number;
  creditsRemaining: number;
  progress?: ExtractionProgress;
  onFieldAccept: (key: string, value: string) => void;
  onFieldReject: (key: string) => void;
  onFieldEdit: (key: string, value: string) => void;
  onAcceptAll: (fields: ExtractionField[]) => void;
  onReorder?: (fields: ExtractionField[]) => void;
}

const FIELD_LABELS: Record<string, string> = {
  credentialType: 'Credential Type',
  issuerName: 'Issuer',
  recipientIdentifier: 'Recipient',
  issuedDate: 'Issue Date',
  expiryDate: 'Expiry Date',
  fieldOfStudy: 'Field of Study',
  degreeLevel: 'Degree Level',
  licenseNumber: 'License / ID Number',
  accreditingBody: 'Accrediting Body',
  jurisdiction: 'Jurisdiction',
  // CLE fields
  creditHours: 'Credit Hours',
  creditType: 'Credit Type',
  barNumber: 'Bar Number',
  activityNumber: 'Activity Number',
  providerName: 'Provider',
  approvedBy: 'Approved By',
};

function getConfidenceColor(confidence: number): string {
  if (confidence >= 0.8) return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
  if (confidence >= 0.5) return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
  return 'text-[#00d4ff] bg-[#00d4ff]/10 border-[#00d4ff]/20';
}

function getConfidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return 'Auto-detected';
  if (confidence >= 0.5) return 'Best guess';
  return 'Needs review';
}

export function AIFieldSuggestions({
  fields,
  overallConfidence,
  creditsRemaining: _creditsRemaining,
  progress,
  onFieldAccept,
  onFieldReject,
  onFieldEdit,
  onAcceptAll,
  onReorder,
}: AIFieldSuggestionsProps) {
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  // Show progress bar during extraction
  if (progress && progress.stage !== 'complete') {
    return (
      <div className="glass-card rounded-xl p-6 animate-in-view">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-xl bg-gradient-to-br from-primary/15 to-primary/5">
            <Sparkles className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-sm">AI Analysis</h3>
            <p className="text-xs text-muted-foreground">{progress.message}</p>
          </div>
        </div>

        <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-300"
            style={{ width: `${progress.progress}%` }}
          />
        </div>

        {progress.stage === 'error' && (
          <div className="mt-3 flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            <span>{progress.message}</span>
          </div>
        )}
      </div>
    );
  }

  if (fields.length === 0) return null;

  const suggestedFields = fields.filter((f) => f.status === 'suggested');

  const handleStartEdit = (field: ExtractionField) => {
    setEditingField(field.key);
    setEditValue(field.value);
  };

  const handleSaveEdit = (key: string) => {
    onFieldEdit(key, editValue);
    setEditingField(null);
    setEditValue('');
  };

  const handleCancelEdit = () => {
    setEditingField(null);
    setEditValue('');
  };

  return (
    <div className="glass-card rounded-xl p-6 animate-in-view space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-gradient-to-br from-primary/15 to-primary/5">
            <Sparkles className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-sm">AI Suggestions</h3>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-xs font-medium border ${getConfidenceColor(overallConfidence)}`}
              >
                {getConfidenceLabel(overallConfidence)} ({Math.round(overallConfidence * 100)}%)
              </span>
            </div>
          </div>
        </div>

        {suggestedFields.length > 0 && (
          <button
            type="button"
            onClick={() => onAcceptAll(suggestedFields)}
            className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
          >
            Accept all ({suggestedFields.length})
          </button>
        )}
      </div>

      {/* Field list */}
      <div className="space-y-2">
        {fields.map((field, index) => (
          <div
            key={field.key}
            className={`flex items-center justify-between rounded-lg border p-3 transition-all stagger-${Math.min(index + 1, 8)} ${
              field.status === 'accepted'
                ? 'border-green-200 bg-green-50/50'
                : field.status === 'rejected'
                  ? 'border-muted bg-muted/30 opacity-50'
                  : field.status === 'edited'
                    ? 'border-blue-200 bg-blue-50/50'
                    : 'border-border'
            }`}
          >
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
                {FIELD_LABELS[field.key] ?? field.key}
              </div>

              {/* Per-field confidence indicator (Design Audit #6) */}
              <div className="flex items-center gap-1.5 mb-1">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    field.confidence >= 0.8 ? 'bg-emerald-500' :
                    field.confidence >= 0.5 ? 'bg-amber-500' :
                    'bg-red-500'
                  }`}
                  title={`AI confidence: ${Math.round(field.confidence * 100)}%`}
                />
                <span className="text-[10px] text-muted-foreground">
                  {Math.round(field.confidence * 100)}% confidence
                </span>
              </div>

              {editingField === field.key ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    className="flex-1 text-sm border rounded px-2 py-1 bg-background"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => handleSaveEdit(field.key)}
                    className="p-1 text-green-600 hover:bg-green-50 rounded"
                    title="Save"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelEdit}
                    className="p-1 text-muted-foreground hover:bg-muted/50 rounded"
                    title="Cancel"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div className="text-sm font-medium truncate">{field.value}</div>
              )}
            </div>

            {/* Reorder controls (Design Audit #18) */}
            {onReorder && editingField !== field.key && (
              <div className="flex flex-col gap-0.5 ml-2">
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => {
                    const reordered = [...fields];
                    [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]];
                    onReorder(reordered);
                  }}
                  className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 rounded"
                  title="Move up"
                >
                  <ArrowUp className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  disabled={index === fields.length - 1}
                  onClick={() => {
                    const reordered = [...fields];
                    [reordered[index], reordered[index + 1]] = [reordered[index + 1], reordered[index]];
                    onReorder(reordered);
                  }}
                  className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 rounded"
                  title="Move down"
                >
                  <ArrowDown className="h-3 w-3" />
                </button>
              </div>
            )}

            {editingField !== field.key && field.status === 'suggested' && (
              <div className="flex items-center gap-1 ml-3">
                <button
                  type="button"
                  onClick={() => onFieldAccept(field.key, field.value)}
                  className="p-1.5 text-green-600 hover:bg-green-50 rounded-md transition-colors"
                  title="Accept"
                >
                  <Check className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => handleStartEdit(field)}
                  className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-md transition-colors"
                  title="Edit"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onFieldReject(field.key)}
                  className="p-1.5 text-muted-foreground hover:bg-muted/50 rounded-md transition-colors"
                  title="Reject"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            {field.status === 'accepted' && (
              <span className="text-xs font-medium text-green-600 ml-3">Accepted</span>
            )}
            {field.status === 'rejected' && (
              <span className="text-xs font-medium text-muted-foreground ml-3">Rejected</span>
            )}
            {field.status === 'edited' && (
              <span className="text-xs font-medium text-blue-600 ml-3">Edited</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
