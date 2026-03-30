/**
 * Template-Aware Field Mapper
 *
 * Maps AI extraction output fields to template-defined field schemas.
 * After AI extraction, this utility:
 *   1. Fetches the matched template's field schema
 *   2. Maps extracted field keys to template field keys
 *   3. Applies template labels (human-friendly names)
 *   4. Orders fields according to template definition
 *   5. Flags missing required fields
 *
 * @see 0136_system_template_field_schemas.sql
 */

import { supabase } from './supabase';
import type { ExtractionField } from './aiExtraction';

export interface TemplateFieldSchema {
  key: string;
  label: string;
  type: 'text' | 'date' | 'number' | 'select';
  required?: boolean;
  options?: string[];
}

export interface TemplateMappingResult {
  /** Fields mapped and ordered by template schema */
  mappedFields: ExtractionField[];
  /** Extra fields from extraction that aren't in the template */
  unmappedFields: ExtractionField[];
  /** Template field keys that had no extraction match */
  missingRequired: string[];
  /** The template name used */
  templateName: string | null;
}

/**
 * Fetch template field schema for a given credential type.
 * Tries system templates first, then falls back to org templates.
 */
export async function fetchTemplateSchema(
  credentialType: string,
  orgId?: string | null,
): Promise<{ name: string; fields: TemplateFieldSchema[] } | null> {
  // Try system template first
  const { data: systemTemplate } = await supabase
    .from('credential_templates')
    .select('name, default_metadata')
    .eq('is_system', true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .eq('credential_type', credentialType as any)
    .limit(1)
    .maybeSingle();

  if (systemTemplate?.default_metadata) {
    const fields = parseFieldsFromMetadata(systemTemplate.default_metadata);
    if (fields.length > 0) {
      return { name: systemTemplate.name, fields };
    }
  }

  // Fallback: org template
  if (orgId) {
    const { data: orgTemplate } = await supabase
      .from('credential_templates')
      .select('name, default_metadata')
      .eq('org_id', orgId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .eq('credential_type', credentialType as any)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (orgTemplate?.default_metadata) {
      const fields = parseFieldsFromMetadata(orgTemplate.default_metadata);
      if (fields.length > 0) {
        return { name: orgTemplate.name, fields };
      }
    }
  }

  return null;
}

/**
 * Parse template field schema from default_metadata JSON.
 * Handles both array format (new) and object format (CLE templates).
 */
function parseFieldsFromMetadata(metadata: unknown): TemplateFieldSchema[] {
  if (!metadata || typeof metadata !== 'object') return [];

  const meta = metadata as Record<string, unknown>;
  const fields = meta.fields;

  if (!fields) return [];

  // Array format: [{key, label, type, required}, ...]
  if (Array.isArray(fields)) {
    return fields
      .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null && typeof (f as Record<string, unknown>).key === 'string')
      .map(f => ({
        key: f.key as string,
        label: (f.label as string) ?? f.key as string,
        type: (f.type as TemplateFieldSchema['type']) ?? 'text',
        required: f.required === true,
        options: Array.isArray(f.options) ? f.options as string[] : undefined,
      }));
  }

  // Object format (CLE templates): {field_key: {type, label, required}, ...}
  if (typeof fields === 'object') {
    return Object.entries(fields as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'object' && v !== null)
      .map(([key, v]) => {
        const def = v as Record<string, unknown>;
        return {
          key,
          label: (def.label as string) ?? key,
          type: (def.type as TemplateFieldSchema['type']) ?? 'text',
          required: def.required === true,
          options: Array.isArray(def.options) ? def.options as string[] : undefined,
        };
      });
  }

  return [];
}

/**
 * Map AI extraction fields to a template's field schema.
 *
 * - Reorders fields to match template order
 * - Applies template labels
 * - Separates unmapped fields (extras from AI)
 * - Reports missing required fields
 */
export function mapFieldsToTemplate(
  extractedFields: ExtractionField[],
  templateFields: TemplateFieldSchema[],
): Omit<TemplateMappingResult, 'templateName'> {
  const templateKeySet = new Set(templateFields.map(f => f.key));
  const extractedMap = new Map(extractedFields.map(f => [f.key, f]));

  // Map template fields in order
  const mappedFields: ExtractionField[] = [];
  const missingRequired: string[] = [];

  for (const tf of templateFields) {
    const extracted = extractedMap.get(tf.key);
    if (extracted) {
      mappedFields.push(extracted);
      extractedMap.delete(tf.key);
    } else if (tf.required) {
      missingRequired.push(tf.key);
    }
  }

  // Remaining extraction fields not in the template
  const unmappedFields: ExtractionField[] = [];
  for (const [key, field] of extractedMap) {
    // Skip internal fields like credentialType and fraudSignals
    if (key === 'credentialType' || key === 'fraudSignals') continue;
    if (!templateKeySet.has(key)) {
      unmappedFields.push(field);
    }
  }

  return { mappedFields, unmappedFields, missingRequired };
}

/**
 * Full pipeline: fetch template + map fields.
 * Returns mapped fields or the original fields if no template found.
 */
export async function applyTemplate(
  extractedFields: ExtractionField[],
  credentialType: string,
  orgId?: string | null,
): Promise<TemplateMappingResult> {
  const schema = await fetchTemplateSchema(credentialType, orgId);

  if (!schema) {
    // No template — return fields as-is
    return {
      mappedFields: extractedFields.filter(f => f.key !== 'credentialType' && f.key !== 'fraudSignals'),
      unmappedFields: [],
      missingRequired: [],
      templateName: null,
    };
  }

  const result = mapFieldsToTemplate(extractedFields, schema.fields);
  return { ...result, templateName: schema.name };
}
