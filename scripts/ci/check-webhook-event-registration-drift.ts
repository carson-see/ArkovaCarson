#!/usr/bin/env tsx
/**
 * CI guard: webhook event REGISTRATION drift detector (DI-775 / SCRUM-3538).
 *
 * WHY THIS EXISTS
 *
 * `PAYLOAD_SCHEMAS_BY_EVENT_TYPE` in
 * `services/worker/src/webhooks/payload-schemas.ts` is the single source of
 * truth for the outbound webhook event set: `VALID_WEBHOOK_EVENTS` is derived
 * from its keys, so the moment a schema is registered there the CRUD API
 * accepts subscriptions to it and `dispatchWebhookEvent` validates against it.
 * Every other list of event ids in this repo is a hand-maintained MIRROR.
 *
 * That mirror has now drifted three times, in both directions:
 *
 *   SCRUM-1794  `anchor.submitted` / `anchor.batch_secured` — dispatched for
 *               months while the CRUD allowlist rejected subscriptions.
 *   BUG-002     `compliance.document_expiring` — emitted by the expiry cron
 *               while unregistered, so every dispatch matched zero endpoints
 *               AND the payload skipped schema validation entirely (it was
 *               shipping the internal `anchor_id`, CLAUDE.md §6).
 *   DI-775      `anchor.superseded` — registered and really dispatched from
 *               `services/worker/src/api/anchor-lineage.ts`, while the UI
 *               picker, the event catalog, `copy.ts`, the typed SDK union,
 *               the Zapier constant and the public docs all omitted it. Orgs
 *               were sent an event no surface let them subscribe to.
 *
 * Each of those was fixed by hand-editing the mirrors and pinning them in
 * per-surface tests. A pinned list only fails when someone edits THAT surface
 * and forgets its own pin; nothing fails when the worker map grows and the
 * mirrors stay still — which is the direction all three incidents actually
 * travelled. Two of those pins (`packages/sdk`, `integrations/zapier`) are in
 * package suites that PR CI does not even run: `Publish SDK` runs the SDK
 * tests only on an `sdk-v*` tag, and no workflow runs the Zapier tests at all.
 *
 * This check is the ratchet that keys off the source of truth instead. Its
 * test lives beside it and is picked up by the root vitest `scripts/**` glob,
 * so it runs inside the already-required `Tests` job — no workflow wiring and
 * no per-package runner needed.
 *
 * FAIL CLOSED. A region that cannot be located, or that yields no ids, is a
 * VIOLATION, not a skip. A guard that goes quiet when it can no longer see the
 * thing it guards is worse than no guard, because it also removes the reason
 * to look.
 *
 * Usage: tsx scripts/ci/check-webhook-event-registration-drift.ts
 * Exit 0 = every surface mirrors the worker allowlist. Exit 1 = drift.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** Canonical: the keys of the worker's payload-schema map, in declaration order. */
export const CANONICAL_SURFACE = {
  file: 'services/worker/src/webhooks/payload-schemas.ts',
  description: 'Worker PAYLOAD_SCHEMAS_BY_EVENT_TYPE (source of truth)',
  region: /PAYLOAD_SCHEMAS_BY_EVENT_TYPE\s*=\s*\{([\s\S]*?)\n\}\s*as\s*const/,
  style: 'quoted' as SurfaceStyle,
  ordered: true,
};

export type SurfaceStyle = 'quoted' | 'md-table-row';

export interface SurfaceSpec {
  file: string;
  description: string;
  /** Captures the text span that holds the ids. Group 1 is the span. */
  region: RegExp;
  /**
   * `quoted` — `'anchor.secured'` in a TS literal.
   * `md-table-row` — the first cell of a markdown table row. Deliberately NOT
   * "any backticked id in the section": the guide's prose cross-references
   * events inside other rows' cells, and counting those would let an event
   * that is merely MENTIONED pass as an event that is DOCUMENTED.
   */
  style: SurfaceStyle;
  /**
   * True when the surface's own pinned test compares with `toEqual` on an
   * array, so a reordering is a real failure there and should be reported
   * here too. Markdown groups events by family for readability, so the docs
   * surface is compared as a set.
   */
  ordered: boolean;
}

export const MIRROR_SURFACES: SurfaceSpec[] = [
  {
    file: 'src/components/webhooks/WebhookSettings.tsx',
    description: 'Dashboard subscription picker (AVAILABLE_EVENTS)',
    region: /export const AVAILABLE_EVENTS\s*=\s*\[([\s\S]*?)\n\];/,
    style: 'quoted',
    ordered: true,
  },
  {
    file: 'src/components/webhooks/WebhookEventCatalog.tsx',
    description: 'Event catalog payload/live data (CATALOG_DATA)',
    region: /const CATALOG_DATA[^=]*=\s*\{([\s\S]*?)\n\};/,
    style: 'quoted',
    ordered: true,
  },
  {
    file: 'src/lib/copy.ts',
    description: 'UI copy descriptions (WEBHOOK_EVENT_DESCRIPTIONS)',
    region: /export const WEBHOOK_EVENT_DESCRIPTIONS[^=]*=\s*\{([\s\S]*?)\n\};/,
    style: 'quoted',
    ordered: true,
  },
  {
    file: 'packages/sdk/src/types.ts',
    description: 'TypeScript SDK union (WebhookEventType)',
    region: /export type WebhookEventType\s*=([\s\S]*?);/,
    style: 'quoted',
    ordered: true,
  },
  {
    file: 'integrations/zapier/src/constants.ts',
    description: 'Zapier/Make mirror constant (VALID_EVENTS)',
    region: /export const VALID_EVENTS\s*=\s*\[([\s\S]*?)\n\]\s*as\s*const;/,
    style: 'quoted',
    ordered: true,
  },
  {
    file: 'docs/api/webhooks.md',
    description: 'Public webhook guide event tables',
    // Whole file; the row extractor does the narrowing.
    region: /([\s\S]+)/,
    style: 'md-table-row',
    ordered: false,
  },
];

export interface SurfaceReading {
  file: string;
  description: string;
  ordered: boolean;
  /** Ids in source order, deduplicated. Empty when the region did not resolve. */
  ids: string[];
  /** Set when the region could not be located — reported as a fail-closed violation. */
  unresolved?: string;
}

export interface RegistrationDrift {
  file: string;
  description: string;
  missing: string[];
  extra: string[];
  /** Same members, different order (only reported for order-sensitive surfaces). */
  misordered: boolean;
  /** The ids actually read from the surface, for the diagnostic. */
  actual: string[];
  unresolved?: string;
}

/**
 * Drop `//` line comments and `/* *\/` blocks before extracting ids.
 *
 * Every one of these surfaces carries prose explaining WHY an event is listed,
 * and that prose names other event ids. Without this, a comment mentioning an
 * id would register as a listing and the guard would pass a surface that never
 * actually offers the event.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Matches a complete event id and nothing else — `family.event_name`. */
const QUOTED_ID_RE = /'([a-z][a-z_]*\.[a-z][a-z_]*)'/g;
/** First cell of a markdown table row: `| \`anchor.secured\` | … |`. */
const MD_TABLE_ROW_ID_RE = /^\|\s*`([a-z][a-z_]*\.[a-z][a-z_]*)`\s*\|/gm;

export function extractEventIds(regionText: string, style: SurfaceStyle): string[] {
  const source = style === 'quoted' ? stripComments(regionText) : regionText;
  const pattern = style === 'quoted' ? QUOTED_ID_RE : MD_TABLE_ROW_ID_RE;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function readSurface(spec: SurfaceSpec, root = ROOT): SurfaceReading {
  const base = { file: spec.file, description: spec.description, ordered: spec.ordered };
  let content: string;
  try {
    content = readFileSync(resolve(root, spec.file), 'utf-8');
  } catch {
    return { ...base, ids: [], unresolved: 'file could not be read' };
  }
  const match = spec.region.exec(content);
  if (!match?.[1]) {
    return { ...base, ids: [], unresolved: 'declaration not found — was it renamed or reformatted?' };
  }
  const ids = extractEventIds(match[1], spec.style);
  if (ids.length === 0) {
    return { ...base, ids, unresolved: 'declaration found but no event ids parsed out of it' };
  }
  return { ...base, ids };
}

/**
 * Compare every mirror against the canonical list. Pure — the caller supplies
 * the readings, so the collector is testable without touching the filesystem.
 */
export function collectRegistrationDrift(params: {
  canonical: SurfaceReading;
  mirrors: SurfaceReading[];
}): RegistrationDrift[] {
  const { canonical, mirrors } = params;

  if (canonical.unresolved) {
    return [
      {
        file: canonical.file,
        description: canonical.description,
        missing: [],
        extra: [],
        misordered: false,
        actual: [],
        unresolved: canonical.unresolved,
      },
    ];
  }

  const canonicalSet = new Set(canonical.ids);

  return mirrors.flatMap((mirror) => {
    if (mirror.unresolved) {
      return [
        {
          file: mirror.file,
          description: mirror.description,
          missing: [],
          extra: [],
          misordered: false,
          actual: [],
          unresolved: mirror.unresolved,
        },
      ];
    }

    const mirrorSet = new Set(mirror.ids);
    const missing = canonical.ids.filter((id) => !mirrorSet.has(id));
    const extra = mirror.ids.filter((id) => !canonicalSet.has(id));
    const misordered =
      mirror.ordered &&
      missing.length === 0 &&
      extra.length === 0 &&
      mirror.ids.join(',') !== canonical.ids.join(',');

    if (missing.length === 0 && extra.length === 0 && !misordered) return [];
    return [
      {
        file: mirror.file,
        description: mirror.description,
        missing,
        extra,
        misordered,
        actual: mirror.ids,
      },
    ];
  });
}

export function readAllSurfaces(root = ROOT): {
  canonical: SurfaceReading;
  mirrors: SurfaceReading[];
} {
  return {
    canonical: readSurface(CANONICAL_SURFACE, root),
    mirrors: MIRROR_SURFACES.map((spec) => readSurface(spec, root)),
  };
}

export function checkWebhookEventRegistrationDrift(root = ROOT): number {
  const { canonical, mirrors } = readAllSurfaces(root);
  const violations = collectRegistrationDrift({ canonical, mirrors });

  if (violations.length === 0) {
    console.log(
      `All ${mirrors.length} webhook registration surfaces mirror the worker allowlist (${canonical.ids.length} event types).`,
    );
    return 0;
  }

  for (const v of violations) {
    console.error(`\nDRIFT in ${v.description} (${v.file}):`);
    if (v.unresolved) console.error(`  Could not verify: ${v.unresolved}`);
    if (v.missing.length > 0) console.error(`  Missing: ${v.missing.join(', ')}`);
    if (v.extra.length > 0) console.error(`  Extra:   ${v.extra.join(', ')}`);
    if (v.misordered) {
      console.error(`  Order differs from the worker declaration order.`);
      console.error(`    expected: ${canonical.ids.join(', ')}`);
      console.error(`    actual:   ${v.actual.join(', ')}`);
    }
  }

  console.error(
    `\n${violations.length} webhook registration surface(s) drifted from PAYLOAD_SCHEMAS_BY_EVENT_TYPE.`,
  );
  console.error(
    'Fix: registering a schema in services/worker/src/webhooks/payload-schemas.ts makes the event',
  );
  console.error(
    'subscribable and dispatchable immediately — update every mirror listed above in the same PR.',
  );
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(checkWebhookEventRegistrationDrift());
}
