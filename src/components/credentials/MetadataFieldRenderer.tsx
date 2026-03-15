/**
 * Metadata Field Renderer
 *
 * Renders dynamic form fields from a credential template's field schema.
 * Supports text, date, number, and select field types.
 * Used in IssueCredentialForm to capture structured metadata.
 *
 * @see UF-05
 */

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { METADATA_FIELD_LABELS } from '@/lib/copy';
import type { TemplateField } from '@/hooks/useCredentialTemplate';

interface MetadataFieldRendererProps {
  /** Template field definitions */
  fields: TemplateField[];
  /** Current metadata values */
  values: Record<string, string>;
  /** Callback when a field value changes */
  onChange: (key: string, value: string) => void;
  /** Whether fields are disabled */
  disabled?: boolean;
  /** Validation errors by field key */
  errors?: Record<string, string>;
}

export function MetadataFieldRenderer({
  fields,
  values,
  onChange,
  disabled = false,
  errors,
}: Readonly<MetadataFieldRendererProps>) {
  if (fields.length === 0) return null;

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {METADATA_FIELD_LABELS.SECTION_TITLE}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((field) => (
          <MetadataField
            key={field.key}
            field={field}
            value={values[field.key] ?? ''}
            onChange={(v) => onChange(field.key, v)}
            disabled={disabled}
            error={errors?.[field.key]}
          />
        ))}
      </div>
    </div>
  );
}

interface MetadataFieldProps {
  field: TemplateField;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  error?: string;
}

function MetadataField({
  field,
  value,
  onChange,
  disabled,
  error,
}: Readonly<MetadataFieldProps>) {
  const labelId = `metadata-${field.key}`;
  const isRequired = field.required === true;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={labelId} className="text-sm">
        {field.label}
        {isRequired && (
          <span className="text-destructive ml-0.5">
            {METADATA_FIELD_LABELS.REQUIRED_MARKER}
          </span>
        )}
      </Label>

      {field.type === 'select' && field.options ? (
        <Select
          value={value}
          onValueChange={onChange}
          disabled={disabled}
        >
          <SelectTrigger id={labelId}>
            <SelectValue placeholder={METADATA_FIELD_LABELS.SELECT_PLACEHOLDER} />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={labelId}
          type={field.type === 'text' ? 'text' : field.type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={field.label}
          step={field.type === 'number' ? 'any' : undefined}
        />
      )}

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}
