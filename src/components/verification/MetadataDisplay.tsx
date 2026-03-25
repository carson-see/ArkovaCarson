/**
 * Enhanced Metadata Display
 *
 * Renders credential metadata in a structured key-value format.
 * Formats dates, URLs (as links), and emails (as mailto links).
 * Uses template schema for field labels when available.
 *
 * @see MVP-18
 */

import { cn } from '@/lib/utils';
import { sanitizeHref } from '@/lib/urlValidator';
import type { TemplateFieldDefinition } from '@/components/credentials/TemplateSchemaBuilder';

interface MetadataDisplayProps {
  metadata: Record<string, string | number | boolean | null>;
  schema?: TemplateFieldDefinition[];
  className?: string;
}

/**
 * Determine if a string looks like a date (ISO format or common date patterns).
 */
function isDateValue(value: string): boolean {
  // ISO date (YYYY-MM-DD) or datetime
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    const parsed = new Date(value);
    return !isNaN(parsed.getTime());
  }
  return false;
}

/**
 * Determine if a string is a URL.
 */
function isUrlValue(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Determine if a string looks like an email.
 */
function isEmailValue(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Format a date string for display.
 */
function formatDate(value: string): string {
  const date = new Date(value);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Convert a snake_case or camelCase key to a readable label.
 */
function keyToLabel(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Get label for a field key, preferring schema labels.
 */
function getFieldLabel(
  key: string,
  schema?: TemplateFieldDefinition[]
): string {
  if (schema) {
    const fieldDef = schema.find(
      (f) => f.name === key || f.id === key || f.name.toLowerCase().replace(/\s+/g, '_') === key
    );
    if (fieldDef) return fieldDef.name;
  }
  return keyToLabel(key);
}

/**
 * Get the field type hint from schema.
 */
function getFieldType(
  key: string,
  schema?: TemplateFieldDefinition[]
): TemplateFieldDefinition['type'] | null {
  if (!schema) return null;
  const fieldDef = schema.find(
    (f) => f.name === key || f.id === key || f.name.toLowerCase().replace(/\s+/g, '_') === key
  );
  return fieldDef?.type ?? null;
}

function renderValue(
  value: string | number | boolean | null,
  fieldType: TemplateFieldDefinition['type'] | null
): JSX.Element {
  if (value === null || value === undefined || value === '') {
    return (
      <span className="text-muted-foreground/60 italic text-sm">
        Not provided
      </span>
    );
  }

  const strValue = typeof value === 'object' ? JSON.stringify(value) : String(value);

  // Schema-driven formatting
  if (fieldType === 'url' || (fieldType === null && isUrlValue(strValue))) {
    return (
      <a
        href={sanitizeHref(strValue)}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-sm text-primary hover:underline break-all"
      >
        {strValue}
      </a>
    );
  }

  if (fieldType === 'email' || (fieldType === null && isEmailValue(strValue))) {
    return (
      <a
        href={`mailto:${strValue}`}
        className="font-mono text-sm text-primary hover:underline"
      >
        {strValue}
      </a>
    );
  }

  if (fieldType === 'date' || (fieldType === null && isDateValue(strValue))) {
    return (
      <span className="font-mono text-sm">{formatDate(strValue)}</span>
    );
  }

  if (typeof value === 'boolean') {
    return (
      <span className="font-mono text-sm">{value ? 'Yes' : 'No'}</span>
    );
  }

  return <span className="font-mono text-sm">{strValue}</span>;
}

export function MetadataDisplay({
  metadata,
  schema,
  className,
}: Readonly<MetadataDisplayProps>) {
  const entries = Object.entries(metadata);

  if (entries.length === 0) {
    return (
      <div className={cn('text-sm text-muted-foreground py-3', className)}>
        No metadata
      </div>
    );
  }

  return (
    <div className={cn('space-y-2', className)}>
      {entries.map(([key, value]) => {
        const label = getFieldLabel(key, schema);
        const fieldType = getFieldType(key, schema);

        return (
          <div
            key={key}
            className="flex flex-col gap-0.5 py-1.5 border-b border-border/50 last:border-0"
          >
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {label}
            </dt>
            <dd>{renderValue(value, fieldType)}</dd>
          </div>
        );
      })}
    </div>
  );
}
