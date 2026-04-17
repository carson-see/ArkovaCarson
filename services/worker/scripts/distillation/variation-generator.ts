/**
 * NVI-07 — Query-template variation generator (SCRUM-811).
 *
 * Expands a QueryTemplate into every cartesian product of its fact slots.
 * The generator is DETERMINISTIC so runs reproduce exactly — two maintainers
 * running the same template + slots get the same variation ids + order.
 */

import type { QueryTemplate, VariationQuery } from './types';

/** Render `{slot}` placeholders in `template` using `slotValues`. */
export function renderTemplate(template: string, slotValues: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    const v = slotValues[name];
    if (v === undefined) throw new Error(`unfilled slot "${name}" in template`);
    return v;
  });
}

/**
 * Cartesian product of slot value arrays — `cartesianSlots({a:[1,2], b:[x,y]})`
 * yields `[{a:1,b:x},{a:1,b:y},{a:2,b:x},{a:2,b:y}]`. Deterministic order.
 */
export function cartesianSlots(slots: Record<string, string[]>): Record<string, string>[] {
  const keys = Object.keys(slots).sort();
  if (keys.length === 0) return [{}];
  let acc: Record<string, string>[] = [{}];
  for (const k of keys) {
    const next: Record<string, string>[] = [];
    for (const combo of acc) {
      for (const v of slots[k]) next.push({ ...combo, [k]: v });
    }
    acc = next;
  }
  return acc;
}

function variationId(templateId: string, slotValues: Record<string, string>): string {
  const keys = Object.keys(slotValues).sort();
  const suffix = keys.map((k) => `${k}=${slotValues[k]}`).join('::');
  return suffix ? `${templateId}::${suffix}` : templateId;
}

/** Expand a single template into one VariationQuery per cartesian combo. */
export function expandTemplate(t: QueryTemplate): VariationQuery[] {
  const combos = cartesianSlots(t.slots);
  return combos.map((slotValues) => ({
    templateId: t.id,
    id: variationId(t.id, slotValues),
    query: renderTemplate(t.template, slotValues),
    slotValues,
    expectedSources: [...t.expectedSources],
    category: t.category,
  }));
}

/** Expand a list of templates. Deterministic concatenation. */
export function expandTemplates(templates: QueryTemplate[]): VariationQuery[] {
  const out: VariationQuery[] = [];
  for (const t of templates) out.push(...expandTemplate(t));
  return out;
}
