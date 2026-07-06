/**
 * SCRUM-2377 (CE-06a) — claims-review gate, lint half (CLAUDE.md §1.13 R-7).
 *
 * Scans the CTDL/CE production sources (the code whose strings can reach the
 * public CTDL endpoint) for banned overclaim phrases, and verifies the
 * standing default that Credential Engine Registry PUBLISHING stays OFF: no
 * worker source wires a CE Registry write/publish endpoint. The runtime half
 * lives in `ctdl-claims-guard.ts`; the UI-copy half in
 * `src/lib/copy-claims-gate.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROHIBITED_CLAIM_PATTERNS } from './ctdl-claims-guard.js';

const CTDL_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SRC = path.resolve(CTDL_DIR, '..');

/**
 * Production sources on the CTDL/CE output path. Test files are excluded (they
 * legitimately quote the banned phrases as fixtures), and comments are
 * stripped before scanning: the guard documentation deliberately NAMES the
 * banned phrases in prose, but only CODE (i.e. strings that could be emitted)
 * may fail this test. The guard module's patterns are regex sources
 * (`listed\s+in…`), not literal phrases, so an honest scan passes.
 */
function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//');
      return index === -1 ? line : line.slice(0, index);
    })
    .join('\n');
}

function ctdlProductionSources(): string[] {
  const ctdlFiles = fs
    .readdirSync(CTDL_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => path.join(CTDL_DIR, name));
  return [...ctdlFiles, path.join(WORKER_SRC, 'api', 'v1', 'credentials-ctdl.ts')];
}

function walkTsSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') walkTsSources(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('CE-06a claims lint — CTDL/CE output sources carry no overclaim phrases', () => {
  it('sanity: the scan set includes the serializer and the endpoint', () => {
    const sources = ctdlProductionSources();
    expect(sources.some((f) => f.endsWith('ctdl-serializer.ts'))).toBe(true);
    expect(sources.some((f) => f.endsWith('credentials-ctdl.ts'))).toBe(true);
  });

  it('no CTDL/CE production source contains a banned overclaim phrase', () => {
    const offenders: string[] = [];
    for (const file of ctdlProductionSources()) {
      const source = stripComments(fs.readFileSync(file, 'utf-8'));
      for (const pattern of PROHIBITED_CLAIM_PATTERNS) {
        const match = pattern.exec(source);
        if (match) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(`${path.basename(file)}:${line} matches ${String(pattern)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('CE-06a — Credential Engine Registry publishing stays OFF (no write path wired)', () => {
  // The CE "publish path" today is the read-only CTDL projection behind the
  // CE-01 publishability gate (isCtdlPublishableStatus in credentials-ctdl.ts).
  // Extending that gate — NOT building a Registry push — is the standing
  // default. These markers are how a Registry write integration would appear:
  // the CE Registry API hosts and its envelope-publishing endpoints. If a
  // publish integration ever lands, it must arrive flag-gated OFF with explicit
  // CE-06b claims sign-off, and this test updated in the same PR.
  // NOTE: no generic `/envelopes` marker — DocuSign integration code
  // legitimately calls DocuSign's own envelopes API, which has nothing to do
  // with CE Registry envelopes. The CE hosts are the unambiguous signal.
  const REGISTRY_PUBLISH_MARKERS: readonly RegExp[] = [
    /credentialengineregistry\.org/i,
    /sandbox\.credentialengine\.org/i,
    /apps\.credentialengine\.org/i,
    /credentialengine\.org\/(?:registry|publish)/i,
    /registry\/publish/i,
  ];

  it('no worker source references a CE Registry publish endpoint', () => {
    const offenders: string[] = [];
    for (const file of walkTsSources(WORKER_SRC)) {
      const source = fs.readFileSync(file, 'utf-8');
      for (const pattern of REGISTRY_PUBLISH_MARKERS) {
        const match = pattern.exec(source);
        if (match) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(
            `${path.relative(WORKER_SRC, file)}:${line} matches ${String(pattern)}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the CE-01 publishability gate is still the front door of the CTDL route', () => {
    // Extend-don't-fork check: the route must still consult
    // isCtdlPublishableStatus before any body is built.
    const routeSource = fs.readFileSync(
      path.join(WORKER_SRC, 'api', 'v1', 'credentials-ctdl.ts'),
      'utf-8',
    );
    expect(routeSource).toContain('isCtdlPublishableStatus');
    // And the serializer must run the claims-review assert as part of the
    // same fail-closed chain (not a parallel gate).
    const serializerSource = fs.readFileSync(
      path.join(CTDL_DIR, 'ctdl-serializer.ts'),
      'utf-8',
    );
    expect(serializerSource).toContain('assertNoProhibitedClaimInJsonLd');
  });
});
