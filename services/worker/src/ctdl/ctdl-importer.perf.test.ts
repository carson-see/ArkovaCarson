/**
 * Performance tripwire for the CTDL importer parse path (SCRUM-2913 follow-up).
 *
 * Goal: a REGRESSION tripwire + a recorded baseline — NOT a flaky
 * micro-benchmark. Assertions are deliberately generous (CI machines vary
 * wildly); they exist to catch an accidental O(n^2) or a pathological blowup,
 * not to police single-digit-millisecond drift. Measured timings are logged via
 * the test reporter (console) so the baseline is visible in CI output.
 *
 * Synthetic input is generated deterministically by node index (NEVER
 * Math.random) so runs are reproducible and diffable.
 */
import { describe, expect, it } from 'vitest';
import { parseCtdlDocument, parseCtdlNode, type ImportedCtdlRecord } from './ctdl-importer.js';

const NOW = new Date('2026-07-20T00:00:00Z');

// Deterministic CE-shaped CTID from an index (matches the importer's CTID_PATTERN).
function ctidFor(index: number): string {
  const a = index.toString(16).padStart(8, '0').slice(-8);
  const b = index.toString(16).padStart(12, '0').slice(-12);
  return `ce-${a}-0000-4000-8000-${b}`;
}

// A single synthetic credential node, varied by index. Exercises every parse
// branch: language-map name, ownedBy array w/ nested org, dates, an
// expiration that alternates past/future by index, subjectWebpage + source.
function syntheticNode(index: number): Record<string, unknown> {
  const past = index % 2 === 0;
  return {
    '@id': `https://credentialengineregistry.org/resources/${ctidFor(index)}`,
    '@type': index % 3 === 0 ? 'ceterms:License' : 'ceterms:Certificate',
    'ceterms:ctid': ctidFor(index),
    'ceterms:name': {
      fr: `Titre ${index}`,
      es: `Titulo ${index}`,
      'en-US': `Credential ${index}`,
    },
    'ceterms:dateEffective': `20${(10 + (index % 15)).toString().padStart(2, '0')}-03-01`,
    'ceterms:expirationDate': past ? '2021-01-01' : '2099-01-01',
    'ceterms:lifecycleStatusType': 'lifecycle:Active',
    'ceterms:subjectWebpage': `https://issuer.example.org/creds/${index}`,
    'ceterms:ownedBy': [
      {
        '@id': `https://credentialengineregistry.org/resources/org-${index}`,
        '@type': 'ceterms:Organization',
        'ceterms:ctid': ctidFor(1_000_000 + index),
        'ceterms:name': { 'en-US': `Issuer Org ${index}` },
      },
    ],
  };
}

function syntheticGraph(count: number): { '@graph': Record<string, unknown>[] } {
  const nodes: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i += 1) nodes.push(syntheticNode(i));
  return { '@graph': nodes };
}

// Best-of-N wall-clock (min is the stablest estimator for CPU-bound work — it
// filters GC / scheduler jitter). The doc is built ONCE outside the timing loop
// so we measure parsing, not fixture construction.
function timeParse(count: number, runs = 3): { ms: number; records: ImportedCtdlRecord[] } {
  const doc = syntheticGraph(count);
  // Warm-up (JIT + first-run allocation) — not timed.
  parseCtdlDocument(doc, { now: NOW });
  let best = Number.POSITIVE_INFINITY;
  let records: ImportedCtdlRecord[] = [];
  for (let r = 0; r < runs; r += 1) {
    const start = performance.now();
    records = parseCtdlDocument(doc, { now: NOW });
    best = Math.min(best, performance.now() - start);
  }
  return { ms: best, records };
}

describe('CTDL importer — parse performance', () => {
  it('parses 1,000 nodes correctly and well under the time bound', () => {
    const { ms, records } = timeParse(1_000);
    console.log(`[perf] parse 1,000 nodes: ${ms.toFixed(2)}ms (best of 3)`);

    expect(records).toHaveLength(1_000);
    // Correctness at scale: SCRUM-2599 override + provenance still hold per node.
    expect(records[0]!.status).toBe('expired'); // even index -> past expiry
    expect(records[1]!.status).toBe('active'); // odd index -> future expiry
    expect(records[0]!.name).toBe('Credential 0');
    expect(records[0]!.registryUrl).toBe(
      `https://credentialengineregistry.org/resources/${ctidFor(0)}`,
    );
    expect(records[0]!.sourceUrl).toBe('https://issuer.example.org/creds/0');

    // Generous tripwire: 1k nodes must parse in < 500ms on this machine.
    expect(ms).toBeLessThan(500);
  });

  it('parses 5,000 nodes under the time bound and roughly linearly vs 1,000', () => {
    const small = timeParse(1_000);
    const large = timeParse(5_000);
    const ratio = large.ms / Math.max(small.ms, 0.01);
    console.log(
      `[perf] parse 5,000 nodes: ${large.ms.toFixed(2)}ms (best of 3); ` +
        `1k=${small.ms.toFixed(2)}ms; 5k/1k time ratio=${ratio.toFixed(2)} (node ratio=5.0)`,
    );

    expect(large.records).toHaveLength(5_000);
    // Generous tripwire: 5k nodes must parse in < 2.5s on this machine.
    expect(large.ms).toBeLessThan(2_500);

    // Rough-linearity guard: 5x the nodes should be nowhere near quadratic. An
    // O(n) path lands ~5x; we allow up to 15x for timer noise + GC on small
    // absolute numbers. O(n^2) would be ~25x and trips this.
    // Only assert the ratio when the 1k baseline is large enough to be a
    // meaningful denominator (sub-ms baselines make the ratio pure noise).
    if (small.ms >= 1) {
      expect(ratio).toBeLessThan(15);
    }
  });

  it('handles a worst-case / deeply-nested language-map node without pathological cost', () => {
    // A name that is a long array of @value objects with the English entry LAST
    // (forces the resolver to scan the whole array), plus a wide language map on
    // the issuer — the adversarial shape for resolveCtdlLangString.
    const bigNameArray = Array.from({ length: 2_000 }, (_unused, i) => ({
      '@value': `alt-${i}`,
      '@language': `zz-${i}`,
    }));
    bigNameArray.push({ '@value': 'The English Name', '@language': 'en-US' });

    const wideLangMap: Record<string, string> = {};
    for (let i = 0; i < 2_000; i += 1) wideLangMap[`zz-${i}`] = `org-alt-${i}`;
    wideLangMap['en'] = 'The English Org';

    const node = {
      '@type': 'ceterms:License',
      'ceterms:name': bigNameArray,
      'ceterms:ctid': ctidFor(42),
      'ceterms:ownedBy': [{ '@id': 'https://x.example.org/o', 'ceterms:name': wideLangMap }],
    };

    parseCtdlNode(node, { now: NOW }); // warm-up
    const start = performance.now();
    const rec = parseCtdlNode(node, { now: NOW });
    const ms = performance.now() - start;
    console.log(`[perf] worst-case language-map node: ${ms.toFixed(2)}ms`);

    expect(rec.name).toBe('The English Name');
    expect(rec.issuer?.name).toBe('The English Org');
    // A single node — even adversarial — must resolve in well under 100ms.
    expect(ms).toBeLessThan(100);
  });
});
