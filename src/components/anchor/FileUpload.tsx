/**
 * File Upload Component
 *
 * Drag-and-drop file upload with fingerprint generation.
 * Files are processed locally - never uploaded to servers.
 *
 * W2 / F1 (founder ruling 2026-07-28): a single spreadsheet (.csv/.xlsx/.xls/
 * .tsv) is ambiguous — it could be a list of records to import (row mode,
 * the original bulk-issuance intent — kept, unchanged) or one non-credential
 * file to secure as a document (new). Rather than silently routing every
 * spreadsheet to bulk mode, a single spreadsheet file pauses on an explicit
 * mode-choice step; the user picks, and only then does the file continue
 * down the matching path. A multi-file drop (mixed batch) is untouched by
 * this change and still routes straight to bulk mode — see isBulkUploadFile.
 */

import { useState, useCallback, useRef } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Upload, FileText, FileSpreadsheet, X, Loader2, Lock, List } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { generateFingerprint } from '@/lib/fileHasher';
import { SPREADSHEET_MODE_LABELS } from '@/lib/copy';

/** Check if a file is a bulk upload format (CSV/XLSX) */
export function isBulkUploadFile(file: File): boolean {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  return ['csv', 'xlsx', 'xls', 'tsv'].includes(ext)
    || file.type === 'text/csv'
    || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || file.type === 'application/vnd.ms-excel';
}

/** Check if a file is a JSON file (potential attestation) */
export function isJsonFile(file: File): boolean {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  return ext === 'json' || file.type === 'application/json';
}

/** Parse a JSON file and check if it's an attestation document */
export async function parseAttestationFile(file: File): Promise<AttestationUpload | null> {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    // Check for attestation markers
    if (data.document_type === 'attestation' || data.attestation_type || (data.claims && data.attester)) {
      return {
        attestation_type: data.attestation_type ?? data.type ?? 'VERIFICATION',
        subject_type: data.subject?.type ?? data.subject_type ?? 'credential',
        subject_identifier: data.subject?.identifier ?? data.subject_identifier ?? data.subject ?? '',
        attester_name: data.attester?.name ?? data.attester_name ?? '',
        attester_type: data.attester?.type ?? data.attester_type ?? 'INSTITUTION',
        attester_title: data.attester?.title ?? data.attester_title ?? null,
        claims: (data.claims ?? []).map((c: { claim?: string; evidence?: string; text?: string }) => ({
          claim: c.claim ?? c.text ?? '',
          evidence: c.evidence,
        })),
        summary: data.summary ?? data.description ?? null,
        jurisdiction: data.jurisdiction ?? null,
        expires_at: data.expires_at ?? null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export interface AttestationUpload {
  attestation_type: string;
  subject_type: string;
  subject_identifier: string;
  attester_name: string;
  attester_type: string;
  attester_title: string | null;
  claims: Array<{ claim: string; evidence?: string }>;
  summary: string | null;
  jurisdiction: string | null;
  expires_at: string | null;
}

interface FileUploadProps {
  onFileSelect: (file: File, fingerprint: string) => void;
  /** Called when a bulk upload file (CSV/XLSX) or multiple files are detected */
  onBulkDetected?: (files: File[]) => void;
  /** Called when a JSON attestation file is detected */
  onAttestationDetected?: (data: AttestationUpload) => void;
  disabled?: boolean;
}

interface SelectedFile {
  file: File;
  fingerprint: string | null;
  processing: boolean;
}

export function FileUpload({ onFileSelect, onBulkDetected, onAttestationDetected, disabled }: Readonly<FileUploadProps>) {
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  // W2 / F1: a single spreadsheet file waiting on an explicit document-vs-
  // records choice. Non-null only between "single spreadsheet dropped" and
  // "user picked a mode" — never persisted, never remembered across drops.
  const [pendingModeFile, setPendingModeFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback(async (file: File) => {
    setError(null);
    setSelectedFile({ file, fingerprint: null, processing: true });

    try {
      // Check crypto.subtle availability first (requires secure context)
      if (!globalThis.crypto?.subtle) {
        throw new Error('Secure context required — crypto.subtle is unavailable. Please ensure you are using HTTPS.');
      }
      const fingerprint = await generateFingerprint(file);
      setSelectedFile({ file, fingerprint, processing: false });
      onFileSelect(file, fingerprint);
    } catch (err) {
      console.error('[FileUpload] Failed to process document:', err);
      setError(`Failed to process document: ${err instanceof Error ? err.message : 'Unknown error'}. Please try again.`);
      setSelectedFile(null);
    }
  }, [onFileSelect]);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  /**
   * Shared dispatch for a drop or file-input selection. W2 / F1: a LONE
   * spreadsheet file pauses on the mode-choice step instead of being routed
   * straight to bulk mode — a mixed/multi-file drop (W1's surface) is
   * untouched and still goes straight to bulk mode, same as before.
   */
  const dispatchFiles = useCallback((files: File[]) => {
    if (files.length > 1) {
      onBulkDetected?.(files);
      return;
    }
    const [file] = files;
    if (isBulkUploadFile(file)) {
      setPendingModeFile(file);
      return;
    }
    if (isJsonFile(file) && onAttestationDetected) {
      parseAttestationFile(file).then((att) => {
        if (att) { onAttestationDetected(att); } else { processFile(file); }
      });
      return;
    }
    processFile(file);
  }, [processFile, onBulkDetected, onAttestationDetected]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (disabled) return;

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      dispatchFiles(Array.from(files));
    }
  }, [disabled, dispatchFiles]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      dispatchFiles(Array.from(files));
    }
  }, [dispatchFiles]);

  const handleRemove = useCallback(() => {
    setSelectedFile(null);
    setError(null);
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, []);

  /** W2 / F1: user picked "Import as a list of records" for the pending spreadsheet. */
  const handleChooseRecords = useCallback(() => {
    if (!pendingModeFile) return;
    onBulkDetected?.([pendingModeFile]);
    setPendingModeFile(null);
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, [pendingModeFile, onBulkDetected]);

  /** W2 / F1: user picked "Secure this file as a document" — normal single-doc path. */
  const handleChooseDocument = useCallback(() => {
    if (!pendingModeFile) return;
    const file = pendingModeFile;
    setPendingModeFile(null);
    void processFile(file);
  }, [pendingModeFile, processFile]);

  /** W2 / F1: back out of the mode choice and let the user pick a different file. */
  const handleChooseDifferentFile = useCallback(() => {
    setPendingModeFile(null);
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, []);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // The file input is a full-bleed overlay (see below); it must be inert both
  // when the caller disables the control and once a file is chosen.
  const inputInert = disabled || !!selectedFile || !!pendingModeFile;

  return (
    <div className="space-y-4">
      {/* Privacy notice - file never leaves device */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 rounded-md px-3 py-2">
        <Lock className="h-3 w-3" />
        <span>File never leaves your device</span>
      </div>

      {/* Drop zone */}
      <div
        role="button"
        tabIndex={0}
        className={cn(
          'relative rounded-lg border-2 border-dashed p-8 transition-colors',
          dragActive
            ? 'border-primary bg-primary/5'
            : 'border-muted-foreground/25 hover:border-muted-foreground/50',
          disabled && 'cursor-not-allowed opacity-50',
          (selectedFile || pendingModeFile) && 'border-solid border-muted'
        )}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
      >
        {/*
          Full-bleed overlay so a click anywhere in the drop zone opens the
          picker. `disabled` alone does NOT take an element out of hit-testing
          (computed `pointer-events` stays `auto`), and because this input is
          positioned while the content below is not, it paints on top
          regardless of DOM order (CSS 2.1 Appendix E) — so while inert it
          would still swallow clicks meant for that content. Dropping it out of
          hit-testing whenever it is inert keeps the selected-file controls,
          and anything added to this drop zone later, clickable by default.
        */}
        <input
          ref={inputRef}
          type="file"
          multiple
          className={cn(
            'absolute inset-0 cursor-pointer opacity-0',
            inputInert && 'pointer-events-none'
          )}
          onChange={handleChange}
          disabled={inputInert}
        />

        {pendingModeFile ? (
          // relative + z-10: the always-present drop-zone `<input>` is
          // position:absolute, which CSS paints ABOVE non-positioned content
          // regardless of DOM order (positioned descendants paint after
          // in-flow ones — CSS2.1 Appendix E). Without promoting this block
          // into its own stacking position, the (disabled, but still
          // hit-test-eligible) input silently swallows clicks on the mode
          // buttons in a real browser, even though it never surfaces in
          // jsdom-based tests (fireEvent.click bypasses hit-testing).
          <div className="relative z-10 space-y-4" data-testid="spreadsheet-mode-choice">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 shrink-0">
                <FileSpreadsheet className="h-6 w-6 text-primary" />
              </div>
              <div className="flex-1 min-w-0 text-left">
                <p className="text-sm font-medium truncate">{pendingModeFile.name}</p>
                <p className="text-xs text-muted-foreground">
                  {SPREADSHEET_MODE_LABELS.FILE_SIZE_LABEL}: {formatFileSize(pendingModeFile.size)}
                </p>
              </div>
            </div>

            <div className="text-left">
              <p className="text-sm font-medium text-foreground">{SPREADSHEET_MODE_LABELS.TITLE}</p>
              <p className="text-xs text-muted-foreground mt-1">{SPREADSHEET_MODE_LABELS.DESCRIPTION}</p>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={handleChooseRecords}
                disabled={disabled}
                className="flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="spreadsheet-mode-records"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <List className="h-4 w-4 text-primary shrink-0" />
                  {SPREADSHEET_MODE_LABELS.RECORDS_OPTION}
                </span>
                <span className="text-xs text-muted-foreground">{SPREADSHEET_MODE_LABELS.RECORDS_HINT}</span>
              </button>
              <button
                type="button"
                onClick={handleChooseDocument}
                disabled={disabled}
                className="flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="spreadsheet-mode-document"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <FileText className="h-4 w-4 text-primary shrink-0" />
                  {SPREADSHEET_MODE_LABELS.DOCUMENT_OPTION}
                </span>
                <span className="text-xs text-muted-foreground">{SPREADSHEET_MODE_LABELS.DOCUMENT_HINT}</span>
              </button>
            </div>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleChooseDifferentFile}
              disabled={disabled}
            >
              {SPREADSHEET_MODE_LABELS.CHOOSE_DIFFERENT_FILE}
            </Button>
          </div>
        ) : selectedFile ? (
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
              <FileText className="h-6 w-6 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {selectedFile.file.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatFileSize(selectedFile.file.size)}
              </p>
            </div>
            {selectedFile.processing ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={handleRemove}
                disabled={disabled}
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Remove file</span>
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-4">
              <Upload className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground mb-1">
              Drag and drop your document here
            </p>
            <p className="text-xs text-muted-foreground mb-4">
              Single document, CSV/XLSX for bulk upload, or multiple files
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
            >
              Select Document
            </Button>
          </div>
        )}
      </div>

      {/* Fingerprint display */}
      {selectedFile?.fingerprint && (
        <div className="rounded-lg border bg-muted/50 p-4">
          <div className="flex items-start gap-3">
            <ArkovaIcon className="h-5 w-5 text-primary mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium mb-1">Document Fingerprint</p>
              <p className="text-xs text-muted-foreground font-mono break-all">
                {selectedFile.fingerprint}
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                This unique fingerprint identifies your document. Your file never leaves your device.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Error display */}
      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}
