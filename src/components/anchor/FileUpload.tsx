/**
 * File Upload Component
 *
 * Drag-and-drop file upload with fingerprint generation.
 * Files are processed locally - never uploaded to servers.
 */

import { useState, useCallback, useRef } from 'react';
import { Upload, FileText, X, Shield, Loader2, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { generateFingerprint } from '@/lib/fileHasher';

interface FileUploadProps {
  onFileSelect: (file: File, fingerprint: string) => void;
  disabled?: boolean;
}

interface SelectedFile {
  file: File;
  fingerprint: string | null;
  processing: boolean;
}

export function FileUpload({ onFileSelect, disabled }: Readonly<FileUploadProps>) {
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback(async (file: File) => {
    setError(null);
    setSelectedFile({ file, fingerprint: null, processing: true });

    try {
      const fingerprint = await generateFingerprint(file);
      setSelectedFile({ file, fingerprint, processing: false });
      onFileSelect(file, fingerprint);
    } catch {
      setError('Failed to process document. Please try again.');
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

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (disabled) return;

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      processFile(files[0]);
    }
  }, [disabled, processFile]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      processFile(files[0]);
    }
  }, [processFile]);

  const handleRemove = useCallback(() => {
    setSelectedFile(null);
    setError(null);
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, []);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

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
          selectedFile && 'border-solid border-muted'
        )}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
      >
        <input
          ref={inputRef}
          type="file"
          className="absolute inset-0 cursor-pointer opacity-0"
          onChange={handleChange}
          disabled={disabled || !!selectedFile}
        />

        {selectedFile ? (
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
              or click to browse files
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
            <Shield className="h-5 w-5 text-primary mt-0.5 shrink-0" />
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
