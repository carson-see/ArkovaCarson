/**
 * S3-B no-Arkova-network guarantee — TRANSPORT-LAYER enforcement.
 *
 * The CI job already blackholes arkova hosts at the /etc/hosts level; this
 * suite enforces the same guarantee INSIDE the process: `globalThis.fetch` is
 * replaced by a lockdown transport that THROWS for every host except one
 * allowlisted mock independent node (`mock-node.invalid`). Arkova hosts
 * (*.arkova.{io,ai,com,app,dev}), Supabase (*.supabase.co), and every other
 * host are hard-blocked and recorded.
 *
 * Under that lockdown:
 *   1. every VALID fixture still verifies fully — proving the verifier needs
 *      nothing but the proof packet + ONE independent node;
 *   2. an Arkova --rpc is refused up front (endpoint guard, zero fetches);
 *   3. a sneaky Arkova/Supabase base URL at the transport level degrades to
 *      NOT VERIFIED (never a silent fallback to another host);
 *   4. every self-contained packet field is present on valid fixtures — a
 *      missing field is named (a missing field is a SCHEMA BUG);
 *   5. a mechanical source audit: no HTTP client imports, no fetch usage
 *      outside the injectable Esplora transport, no Arkova/Supabase URL
 *      string literals anywhere in either verifier package.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEsploraFetch, confirmInclusion } from '@arkova/verifier';
import { verifyProof } from '../src/verify.js';
import { main } from '../src/cli.js';
import {
  loadManifest,
  loadSyntheticFixtures,
  loadAdversarialFixtures,
  loadProof08,
  resolveManifestEntry,
  FIXTURES_DIR,
} from './helpers.js';
import type { VerifierFixture } from '../src/types.js';

const ALLOWED_HOST = 'mock-node.invalid';

interface Lockdown {
  blocked: string[];
  served: string[];
  install(fixture?: VerifierFixture): void;
}

/**
 * Install a lockdown `globalThis.fetch`: throws on ANY host except the
 * allowlisted mock node, which serves the fixture's canned Esplora responses.
 */
function makeLockdown(): Lockdown {
  const state: Lockdown = {
    blocked: [],
    served: [],
    install(fixture?: VerifierFixture) {
      const responses = fixture?.node ?? {};
      vi.stubGlobal('fetch', async (input: unknown) => {
        const url = new URL(String(input));
        if (url.hostname !== ALLOWED_HOST) {
          state.blocked.push(url.hostname);
          throw new Error(`network lockdown: refusing egress to ${url.hostname}`);
        }
        state.served.push(url.pathname);
        if (!(url.pathname in responses)) {
          return { ok: false, status: 404, text: async () => 'not found' };
        }
        const value = responses[url.pathname];
        const raw = typeof value === 'string' ? value : JSON.stringify(value);
        return { ok: true, status: 200, text: async () => raw };
      });
    },
  };
  return state;
}

const manifest = loadManifest();
const validEntries = manifest.fixtures.filter((f) => f.expected.verdict === 'VERIFIED');

describe('no-Arkova-network: every VALID fixture verifies under full transport lockdown', () => {
  let lockdown: Lockdown;
  beforeEach(() => {
    lockdown = makeLockdown();
  });
  afterEach(() => vi.unstubAllGlobals());

  for (const entry of validEntries) {
    it(`${entry.id} [${entry.mode}] passes with only ${ALLOWED_HOST} reachable`, async () => {
      const fixture = resolveManifestEntry(entry);
      lockdown.install(fixture);
      const report = await verifyProof(fixture.packet, {
        chain:
          entry.mode === 'chain' && fixture.node
            ? { label: ALLOWED_HOST, fetch: createEsploraFetch(`http://${ALLOWED_HOST}`) }
            : undefined,
        signedBundle: entry.mode === 'signature' ? fixture.signedBundle : undefined,
        publishedKeys: entry.mode === 'signature' ? fixture.publishedKeys : undefined,
      });
      expect(report.ok, `${entry.id} must verify fully offline`).toBe(true);
      expect(lockdown.blocked, 'no non-allowlisted host may be contacted').toEqual([]);
      if (entry.mode === 'chain') {
        expect(lockdown.served.length, 'the chain path must actually exercise the mock node').toBeGreaterThan(0);
      }
    });
  }

  it('the full CLI path (main) verifies a packet end-to-end under lockdown', async () => {
    const fixture = loadSyntheticFixtures().find((f) => f.name === 'odd-leaf-pass')!;
    lockdown.install(fixture);
    const dir = mkdtempSync(join(tmpdir(), 'arkova-lockdown-'));
    const path = join(dir, 'p.json');
    writeFileSync(path, JSON.stringify(fixture.packet));
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const code = await main([path, '--rpc', `http://${ALLOWED_HOST}`]);
      expect(code).toBe(0);
      expect(lockdown.blocked).toEqual([]);
    } finally {
      out.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an Arkova --rpc is refused BEFORE any network attempt (endpoint guard)', async () => {
    const fixture = loadSyntheticFixtures().find((f) => f.name === 'odd-leaf-pass')!;
    lockdown.install(fixture);
    const dir = mkdtempSync(join(tmpdir(), 'arkova-lockdown-'));
    const path = join(dir, 'p.json');
    writeFileSync(path, JSON.stringify(fixture.packet));
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      for (const rpc of ['https://api.arkova.io', 'https://edge.arkova.dev', 'https://app.arkova.ai']) {
        const code = await main([path, '--rpc', rpc]);
        expect(code, `${rpc} must be refused`).toBe(2);
      }
      expect(lockdown.blocked, 'guard must fire before any fetch').toEqual([]);
      expect(lockdown.served).toEqual([]);
    } finally {
      out.mockRestore();
      err.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a non-allowlisted base URL at the transport level degrades to NOT VERIFIED — never a fallback', async () => {
    lockdown.install();
    for (const base of ['https://blockstream.info/api', 'https://something.supabase.co', 'https://api.arkova.io']) {
      const result = await confirmInclusion(
        { txId: 'ab'.repeat(32), expectedMerkleRoot: 'cd'.repeat(32), blockHeight: 1 },
        { fetch: createEsploraFetch(base) },
      );
      expect(result.confirmed).toBe(false);
      expect(result.status).toBe('tx_not_found');
    }
    // The lockdown actually intercepted the attempts (proof the stub is live)…
    expect(lockdown.blocked).toContain('api.arkova.io');
    expect(lockdown.blocked).toContain('something.supabase.co');
    // …and nothing was served from anywhere else.
    expect(lockdown.served).toEqual([]);
  });
});

describe('field completeness — a missing self-contained field is a SCHEMA BUG', () => {
  const ANCHORED_FIELDS = [
    'fingerprint',
    'merkle_root',
    'merkle_proof',
    'merkle_index',
    'leaf_count',
    'tx_id',
    'block_height',
    'block_timestamp',
    'op_return_payload',
  ] as const;

  const anchored = manifest.fixtures.filter(
    (f) => f.expected.verdict === 'VERIFIED' && f.mode === 'chain',
  );
  for (const entry of anchored) {
    it(`${entry.id}: every self-contained field is present and non-null`, () => {
      const packet = resolveManifestEntry(entry).packet as unknown as Record<string, unknown>;
      const missing = ANCHORED_FIELDS.filter((k) => packet[k] == null);
      expect(missing, `SCHEMA BUG in ${entry.id}: missing self-contained field(s) ${missing.join(', ')}`).toEqual([]);
    });
  }

  it('the PROOF-08 archival signed-bundle payload also carries block_hash, block_header and proof_schema_version', () => {
    const payload = loadProof08().signed_bundle.valid_bundle.payload as Record<string, unknown>;
    const required = [...ANCHORED_FIELDS, 'block_hash', 'block_header', 'proof_schema_version'];
    const missing = required.filter((k) => payload[k] == null);
    expect(missing, `SCHEMA BUG in PROOF-08 signed bundle: missing ${missing.join(', ')}`).toEqual([]);
  });

  it('adversarial valid packets declare proof_schema_version explicitly', () => {
    for (const name of ['adv-valid-even-tree-pass', 'adv-valid-metadata-suffix-pass']) {
      const f = loadAdversarialFixtures().find((x) => x.name === name)!;
      expect(f.packet.proof_schema_version, `${name} must pin its schema version`).toBe(1);
    }
  });
});

describe('code audit — the verifier packages contain NO Arkova client or fallback fetch path', () => {
  const PKG_ROOT = join(FIXTURES_DIR, '..');
  const SRC_DIRS = [join(PKG_ROOT, 'src'), join(PKG_ROOT, '..', 'verifier', 'src')];

  function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...tsFiles(p));
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p);
    }
    return out;
  }

  const files = SRC_DIRS.flatMap(tsFiles);

  it('audits a non-trivial source surface', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it('imports no HTTP client library anywhere', () => {
    const FORBIDDEN_IMPORT = /from\s+['"](node:https?|https?|axios|undici|node-fetch|got|ky|@supabase\/[^'"]*|@arkova\/(?!verifier)[^'"]*)['"]/;
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), `forbidden HTTP-client import in ${file}`).not.toMatch(FORBIDDEN_IMPORT);
    }
  });

  it('references globalThis.fetch ONLY inside the injectable Esplora transport', () => {
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      if (file.endsWith('independent-node.ts')) continue; // createEsploraFetch owns it
      expect(src, `direct fetch usage in ${file}`).not.toMatch(/globalThis\.fetch/);
    }
  });

  it('contains no Arkova or Supabase URL string literal (no fallback endpoint can exist)', () => {
    const FORBIDDEN_URL = /['"`]https?:\/\/[^'"`]*(arkova|supabase|getblock)[^'"`]*['"`]/i;
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), `forbidden endpoint literal in ${file}`).not.toMatch(FORBIDDEN_URL);
    }
  });

  it('the ONLY default endpoint literal is the independent Esplora node in the endpoint guard', () => {
    const URL_LITERAL = /['"`]https?:\/\/[^'"`]+['"`]/g;
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      // Strip comments — the audit targets executable string literals.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const hits = code.match(URL_LITERAL) ?? [];
      if (file.endsWith('independent-endpoint.ts')) {
        expect(hits).toEqual(["'https://blockstream.info/api'"]);
      } else {
        expect(hits, `unexpected endpoint literal in ${file}: ${hits.join(', ')}`).toEqual([]);
      }
    }
  });
});
