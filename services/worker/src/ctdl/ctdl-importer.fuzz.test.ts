/**
 * SCRUM-2913 — deterministic fuzz/property tests over the REAL CE graph
 * fixture (CTO ruling: fuzz before demo). Seeded PRNG (mulberry32) — NO
 * Date.now(), NO Math.random() — so every run explores the exact same
 * mutation sequence and a failure is reproducible from the iteration index.
 *
 * Properties held over every mutation of the real /graph envelope:
 *  1. The importer NEVER throws except the documented CtdlImportError cases
 *     (structurally-impossible node / node-count cap / invalid envelope JSON).
 *  2. Every emitted record satisfies the module's Zod schema.
 *  3. Cross-@id issuer resolution never infinite-loops — duplicated @ids and
 *     self/mutually-referencing ownedBy cycles terminate (single-lookup design).
 *  4. The MAX_GRAPH_NODES DoS cap still throws.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CtdlImportError,
  ImportedCtdlRecordSchema,
  isCtdlCredentialClass,
  MAX_GRAPH_NODES,
  parseCtdlCredentials,
  parseCtdlDocument,
  type ParseCtdlOptions,
} from './ctdl-importer.js';

const GRAPH_RAW = fs.readFileSync(
  path.join(__dirname, '__fixtures__', 'ce-real-graph-ce-a4c0a549-aed3-4704-ade2-e81a5d76865b.json'),
  'utf-8',
);

const NOW = new Date('2026-07-21T00:00:00.000Z');
const OPTS: ParseCtdlOptions = { now: NOW };
const OPTS_EXPIRY: ParseCtdlOptions = { now: NOW, treatResourceExpiryAsCredentialExpired: true };

// ---------------------------------------------------------------------------
// Deterministic PRNG — mulberry32, fixed seed.
// ---------------------------------------------------------------------------
const FUZZ_SEED = 0x2913c7d1;
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T>(rand: Rand, items: readonly T[]): T => items[Math.floor(rand() * items.length)];
const freshGraph = (): { '@graph': unknown[]; [k: string]: unknown } =>
  JSON.parse(GRAPH_RAW) as { '@graph': unknown[]; [k: string]: unknown };

// Junk values injected at fields the importer touches.
const JUNK_VALUES: readonly unknown[] = [
  null,
  undefined,
  0,
  -1,
  3.14,
  NaN,
  true,
  false,
  '',
  '   ',
  'not-a-date',
  '2026-02-31',
  '2026-2-31T12:00:00Z',
  'ce-xxxx',
  '_:b0',
  [],
  {},
  { '@id': null },
  { '@value': {} },
  [[]],
  [[[['deep']]]],
  { 'en-US': null },
  { 'en-US': { nested: true } },
];

// Every field the importer reads on a node.
const TOUCHED_FIELDS: readonly string[] = [
  '@id',
  '@type',
  'ceterms:name',
  'ceterms:ctid',
  'ceterms:ownedBy',
  'ceterms:dateEffective',
  'ceterms:expirationDate',
  'ceterms:lifecycleStatusType',
  'ceterms:lifeCycleStatusType',
  'ceterms:credentialStatusType',
  'ceterms:subjectWebpage',
  'ceterms:source',
];

function shuffleInPlace(rand: Rand, arr: unknown[]): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** Apply one random mutation to the document. Returns the (mutated) doc. */
function mutate(rand: Rand, doc: { '@graph': unknown[]; [k: string]: unknown }): unknown {
  const graph = doc['@graph'];
  const kind = Math.floor(rand() * 8);
  switch (kind) {
    case 0: // node shuffling
      shuffleInPlace(rand, graph);
      return doc;
    case 1: {
      // junk injection at a touched field of a random node
      const node = pick(rand, graph);
      if (node && typeof node === 'object' && !Array.isArray(node)) {
        (node as Record<string, unknown>)[pick(rand, TOUCHED_FIELDS)] = pick(rand, JUNK_VALUES);
      }
      return doc;
    }
    case 2: {
      // @type promoted to an array (JSON-LD-legal), possibly with junk entries
      const node = pick(rand, graph);
      if (node && typeof node === 'object' && !Array.isArray(node)) {
        const rec = node as Record<string, unknown>;
        rec['@type'] = [rec['@type'], pick(rand, JUNK_VALUES), 'schema:Thing'];
      }
      return doc;
    }
    case 3: {
      // duplicated @ids across nodes
      const a = pick(rand, graph);
      const b = pick(rand, graph);
      if (
        a && b && typeof a === 'object' && typeof b === 'object' &&
        !Array.isArray(a) && !Array.isArray(b)
      ) {
        (b as Record<string, unknown>)['@id'] = (a as Record<string, unknown>)['@id'];
      }
      return doc;
    }
    case 4: {
      // self-referencing / cyclic ownedBy (@id cycles)
      const node = pick(rand, graph);
      if (node && typeof node === 'object' && !Array.isArray(node)) {
        const rec = node as Record<string, unknown>;
        rec['ceterms:ownedBy'] = [rec['@id'] ?? '_:self'];
      }
      // and a two-node mutual cycle via cloned nodes
      graph.push(
        { '@id': '_:cycA', '@type': 'ceterms:Certification', 'ceterms:ownedBy': ['_:cycB'] },
        { '@id': '_:cycB', '@type': 'ceterms:CredentialOrganization', 'ceterms:ownedBy': ['_:cycA'] },
      );
      return doc;
    }
    case 5: {
      // deep nesting where the importer recurses (lang arrays / ownedBy / URLs)
      const node = pick(rand, graph);
      if (node && typeof node === 'object' && !Array.isArray(node)) {
        const rec = node as Record<string, unknown>;
        let nested: unknown = { '@value': 'deep' };
        for (let i = 0; i < 40; i += 1) nested = [nested];
        rec['ceterms:name'] = nested;
        rec['ceterms:subjectWebpage'] = nested;
      }
      return doc;
    }
    case 6: {
      // primitive graph entries (non-object nodes)
      graph.push(pick(rand, JUNK_VALUES));
      return doc;
    }
    default: {
      // envelope-level mutation: @context variants / graph replaced by junk
      const roll = rand();
      if (roll < 0.4) {
        doc['@context'] = [doc['@context'], { ceterms: 'x' }, null];
        return doc;
      }
      if (roll < 0.7) return graph; // bare-array document form
      return pick(rand, JUNK_VALUES); // primitive / null document
    }
  }
}

describe('fuzz — mutations of the REAL CE graph fixture (deterministic seed)', () => {
  it('never throws non-CtdlImportError, never emits a schema-violating record, never hangs', () => {
    const rand = mulberry32(FUZZ_SEED);
    const ITERATIONS = 400;
    for (let i = 0; i < ITERATIONS; i += 1) {
      let doc: unknown = freshGraph();
      const mutations = 1 + Math.floor(rand() * 4);
      for (let m = 0; m < mutations; m += 1) {
        if (doc && typeof doc === 'object' && !Array.isArray(doc) && '@graph' in (doc as object)) {
          doc = mutate(rand, doc as { '@graph': unknown[] });
        }
      }
      const options = rand() < 0.5 ? OPTS : OPTS_EXPIRY;
      // Filtered credentials path — never throws on junk-shaped NODES (they
      // are filtered), may still throw documented CtdlImportError (e.g. cap).
      try {
        const records = parseCtdlCredentials(doc, options);
        for (const record of records) {
          const validated = ImportedCtdlRecordSchema.safeParse(record);
          expect(validated.success, `iteration ${i}: schema violation`).toBe(true);
          // Architect cross-review invariant: a record admitted by the
          // credential filter must never be LABELED with a non-credential
          // class (mixed @type arrays must resolve to the credential entry).
          if (record.type !== null) {
            expect(
              isCtdlCredentialClass(record.type),
              `iteration ${i}: non-credential type label ${record.type}`,
            ).toBe(true);
          }
        }
      } catch (error) {
        expect(error, `iteration ${i}: unexpected error type`).toBeInstanceOf(CtdlImportError);
      }
      // Unfiltered path — parseCtdlNode throws CtdlImportError on primitive
      // nodes (documented); anything else is a bug.
      try {
        const records = parseCtdlDocument(doc, options);
        for (const record of records) {
          const validated = ImportedCtdlRecordSchema.safeParse(record);
          expect(validated.success, `iteration ${i}: schema violation (unfiltered)`).toBe(true);
        }
      } catch (error) {
        expect(error, `iteration ${i}: unexpected error type (unfiltered)`).toBeInstanceOf(
          CtdlImportError,
        );
      }
    }
  });

  it('cross-@id resolution terminates on dense duplicate/self-referencing @id cycles', () => {
    // Every node owns every other node by @id, plus itself — worst-case cycle
    // density. The single-lookup design must terminate and emit valid records.
    const ids = Array.from({ length: 50 }, (_, i) => `_:n${i}`);
    const graph = ids.map((id, i) => ({
      '@id': id,
      '@type': 'ceterms:Certification',
      'ceterms:name': { 'en-US': `Node ${i}` },
      'ceterms:ownedBy': [ids[(i + 1) % ids.length], id],
    }));
    // duplicated @ids on top
    graph.push({ ...graph[0], 'ceterms:name': { 'en-US': 'dup' } });
    const records = parseCtdlCredentials({ '@graph': graph }, OPTS);
    expect(records).toHaveLength(51);
    for (const record of records) {
      expect(ImportedCtdlRecordSchema.safeParse(record).success).toBe(true);
      // issuer name resolved from the referenced sibling node — bounded, no loop
      expect(record.issuer?.name).toMatch(/^(Node \d+|dup)$/);
    }
  });

  it('the MAX_GRAPH_NODES DoS cap still throws on both entry-points', () => {
    const nodes = Array.from({ length: MAX_GRAPH_NODES + 1 }, () => ({
      '@type': 'ceterms:Certification',
    }));
    expect(() => parseCtdlCredentials({ '@graph': nodes }, OPTS)).toThrow(CtdlImportError);
    expect(() => parseCtdlDocument({ '@graph': nodes }, OPTS)).toThrow(CtdlImportError);
  });
});
