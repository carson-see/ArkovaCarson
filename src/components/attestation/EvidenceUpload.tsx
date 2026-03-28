/**
 * Evidence Upload Component (ATT-06)
 *
 * Attach supporting evidence files to attestations.
 * Files are fingerprinted client-side (SHA-256) — only
 * fingerprint + metadata stored server-side (privacy-first).
 */

import { useState, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Upload,
  FileText,
  X,
  Shield,
  Loader2,
  Check,
} from 'lucide-react';
import { generateFingerprint } from '@/lib/fileHasher';

export interface EvidenceItem {
  file: File;
  fingerprint: string;
  evidenceType: string;
  description: string;
  filename: string;
}

const EVIDENCE_TYPES = [
  { value: 'document', label: 'Document' },
  { value: 'letter', label: 'Letter' },
  { value: 'report', label: 'Report' },
  { value: 'assessment', label: 'Assessment' },
] as const;

interface Props {
  items: EvidenceItem[];
  onChange: (items: EvidenceItem[]) => void;
  maxItems?: number;
  disabled?: boolean;
}

export function EvidenceUpload({ items, onChange, maxItems = 10, disabled }: Props) {
  const [processing, setProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (items.length + files.length > maxItems) return;

    setProcessing(true);
    const newItems: EvidenceItem[] = [];

    for (const file of Array.from(files)) {
      try {
        const fingerprint = await generateFingerprint(file);
        newItems.push({
          file,
          fingerprint,
          evidenceType: 'document',
          description: '',
          filename: file.name,
        });
      } catch {
        // Skip files that fail fingerprinting
      }
    }

    onChange([...items, ...newItems]);
    setProcessing(false);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [items, onChange, maxItems]);

  const removeItem = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
  };

  const updateItem = (index: number, updates: Partial<EvidenceItem>) => {
    onChange(items.map((item, i) => i === index ? { ...item, ...updates } : item));
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!disabled) handleFiles(e.dataTransfer.files);
  }, [disabled, handleFiles]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-semibold">Supporting Evidence</Label>
        <span className="text-xs text-muted-foreground">
          {items.length}/{maxItems} files
        </span>
      </div>

      {/* Drop zone */}
      {items.length < maxItems && (
        <div
          className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
            disabled
              ? 'border-border/30 opacity-50'
              : 'border-[#00d4ff]/20 hover:border-[#00d4ff]/40 cursor-pointer'
          }`}
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => !disabled && fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
            disabled={disabled}
          />
          {processing ? (
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Fingerprinting files...
            </div>
          ) : (
            <div>
              <Upload className="mx-auto h-6 w-6 text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">
                Drop evidence files here or click to browse
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Files are fingerprinted locally. Only the fingerprint is stored.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Evidence list */}
      {items.map((item, i) => (
        <div key={i} className="rounded-lg border border-border/50 p-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <FileText className="h-4 w-4 text-[#00d4ff] shrink-0" />
              <span className="text-sm truncate">{item.filename}</span>
              <div className="flex items-center gap-1 shrink-0">
                <Shield className="h-3 w-3 text-emerald-400" />
                <Check className="h-3 w-3 text-emerald-400" />
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 shrink-0"
              onClick={() => removeItem(i)}
              disabled={disabled}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <Select
              value={item.evidenceType}
              onValueChange={(v) => updateItem(i, { evidenceType: v })}
              disabled={disabled}
            >
              <SelectTrigger className="bg-transparent border-[#00d4ff]/20 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EVIDENCE_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              placeholder="Description (optional)"
              value={item.description}
              onChange={(e) => updateItem(i, { description: e.target.value })}
              className="bg-transparent border-[#00d4ff]/20 h-8 text-xs"
              disabled={disabled}
            />
          </div>

          <code className="text-[10px] font-mono text-muted-foreground break-all block">
            SHA-256: {item.fingerprint}
          </code>
        </div>
      ))}
    </div>
  );
}
