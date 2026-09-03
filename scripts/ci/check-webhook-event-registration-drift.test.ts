import { describe, expect, it } from 'vitest';
import {
  CANONICAL_SURFACE,
  MIRROR_SURFACES,
  collectRegistrationDrift,
  extractEventIds,
  readAllSurfaces,
  readSurface,
  stripComments,
  type SurfaceReading,
} from './check-webhook-event-registration-drift.js';

function reading(
  file: string,
  ids: string[],
  opts: { ordered?: boolean; unresolved?: string } = {},
): SurfaceReading {
  return {
    file,
    description: file,
    ordered: opts.ordered ?? true,
    ids,
    ...(opts.unresolved ? { unresolved: opts.unresolved } : {}),
  };
}

const CANON = ['anchor.secured', 'anchor.superseded', 'compliance.document_expiring'];

describe('check-webhook-event-registration-drift — extraction', () => {
  it('reads quoted ids in declaration order and deduplicates', () => {
    expect(
      extractEventIds(
        `
        'anchor.secured': Schema,
        'anchor.superseded': Schema,
        'anchor.secured': Schema,
      `,
        'quoted',
      ),
    ).toEqual(['anchor.secured', 'anchor.superseded']);
  });

  it('does NOT count an id that only appears in a comment', () => {
    // This is the failure mode that makes a text-based guard useless: every
    // one of these surfaces documents WHY an event is listed, naming other
    // events while doing so.
    const region = `
      { id: 'anchor.secured', label: 'Anchor Secured' },
      // DI-775: 'anchor.superseded' is dispatched by the worker but is not
      // offered here yet.
      /* also pending: 'compliance.document_expiring' */
    `;
    expect(extractEventIds(region, 'quoted')).toEqual(['anchor.secured']);
  });

  it('strips block and line comments without eating real code', () => {
    expect(stripComments("a /* x */ b // y\n'anchor.secured'")).toContain("'anchor.secured'");
    expect(stripComments("// 'anchor.secured'\n")).not.toContain('anchor.secured');
  });

  it('counts a markdown event only when it is a table row, not a prose mention', () => {
    const doc = [
      '| Event | Fired When | Status |',
      '|---|---|---|',
      '| `anchor.secured` | Confirmed on the network | Stable |',
      '| `anchor.expired` | Advance warning fires before `anchor.superseded` | Stable |',
      '',
      'See `compliance.document_expiring` for the advance-warning event.',
    ].join('\n');

    expect(extractEventIds(doc, 'md-table-row')).toEqual(['anchor.secured', 'anchor.expired']);
  });
});

describe('check-webhook-event-registration-drift — collector', () => {
  const canonical = reading('worker', CANON);

  it('passes when a mirror matches exactly', () => {
    expect(
      collectRegistrationDrift({ canonical, mirrors: [reading('mirror', [...CANON])] }),
    ).toEqual([]);
  });

  it('flags a mirror that is missing an event the worker registered (the DI-775 direction)', () => {
    const drift = collectRegistrationDrift({
      canonical,
      mirrors: [reading('mirror', ['anchor.secured', 'compliance.document_expiring'])],
    });
    expect(drift).toHaveLength(1);
    expect(drift[0].missing).toEqual(['anchor.superseded']);
    expect(drift[0].extra).toEqual([]);
  });

  it('flags EVERY mirror when the worker map grows — the direction the pinned per-surface tests miss', () => {
    const grown = reading('worker', [...CANON, 'anchor.rekeyed']);
    const drift = collectRegistrationDrift({
      canonical: grown,
      mirrors: [reading('a', [...CANON]), reading('b', [...CANON]), reading('c', [...CANON])],
    });
    expect(drift.map((d) => d.file)).toEqual(['a', 'b', 'c']);
    for (const d of drift) expect(d.missing).toEqual(['anchor.rekeyed']);
  });

  it('flags a mirror advertising an event the worker never registered', () => {
    const drift = collectRegistrationDrift({
      canonical,
      mirrors: [reading('mirror', [...CANON, 'anchor.imaginary'])],
    });
    expect(drift[0].extra).toEqual(['anchor.imaginary']);
  });

  it('flags reordering only for order-sensitive surfaces', () => {
    const shuffled = ['anchor.superseded', 'anchor.secured', 'compliance.document_expiring'];

    const ordered = collectRegistrationDrift({
      canonical,
      mirrors: [reading('ordered', shuffled, { ordered: true })],
    });
    expect(ordered).toHaveLength(1);
    expect(ordered[0].misordered).toBe(true);

    const unordered = collectRegistrationDrift({
      canonical,
      mirrors: [reading('docs', shuffled, { ordered: false })],
    });
    expect(unordered).toEqual([]);
  });

  it('fails CLOSED when a mirror region cannot be resolved', () => {
    const drift = collectRegistrationDrift({
      canonical,
      mirrors: [reading('renamed', [], { unresolved: 'declaration not found' })],
    });
    expect(drift).toHaveLength(1);
    expect(drift[0].unresolved).toBe('declaration not found');
  });

  it('fails CLOSED when the canonical source itself cannot be resolved', () => {
    const drift = collectRegistrationDrift({
      canonical: reading('worker', [], { unresolved: 'declaration not found' }),
      mirrors: [reading('mirror', [...CANON])],
    });
    expect(drift).toHaveLength(1);
    expect(drift[0].file).toBe('worker');
  });
});

describe('check-webhook-event-registration-drift — live repository', () => {
  it('resolves the worker allowlist and finds anchor.superseded in it', () => {
    const canonical = readSurface(CANONICAL_SURFACE);
    expect(canonical.unresolved).toBeUndefined();
    expect(canonical.ids).toContain('anchor.superseded');
    expect(canonical.ids.length).toBeGreaterThanOrEqual(10);
  });

  it.each(MIRROR_SURFACES.map((s) => [s.file, s] as const))(
    'resolves the %s registration surface',
    (_file, spec) => {
      const surface = readSurface(spec);
      expect(surface.unresolved).toBeUndefined();
      expect(surface.ids.length).toBeGreaterThan(0);
    },
  );

  /**
   * The gate itself. Registering a schema in
   * `services/worker/src/webhooks/payload-schemas.ts` makes the event
   * subscribable and dispatchable immediately, so any surface that has not
   * caught up is a shipped bug — SCRUM-1794, BUG-002 and DI-775 in turn.
   */
  it('every registration surface mirrors the worker allowlist', () => {
    const drift = collectRegistrationDrift(readAllSurfaces());
    expect(drift).toEqual([]);
  });
});
