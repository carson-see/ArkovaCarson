/**
 * SCRUM-2377 (CE-06a) — claims-review gate, lint half (CLAUDE.md §1.13 R-7).
 *
 * Scans the CTDL/CE production sources (the code whose strings can reach the
 * public CTDL endpoint) for banned overclaim phrases, and verifies the
 * standing default that Credential Engine Registry PUBLISHING stays OFF: no
 * TS source in this repo wires a CE Registry write/publish endpoint. The
 * runtime half lives in `ctdl-claims-guard.ts`; the UI-copy half in
 * `src/lib/copy-claims-gate.test.ts` (which imports the same pattern array —
 * single shared source).
 *
 * HONEST COVERAGE SCOPE (round-1 review finding 2): the publish-path tripwire
 * walks the TypeScript sources of `services/worker/src`, `services/worker/
 * scripts`, and `services/edge/src` in THIS repo checkout. It cannot see:
 * anything outside the repo (deployed Cloud Run revisions, Cloudflare
 * dashboard-configured edge behavior, operator shell history), non-TS tooling,
 * or dynamically-composed URLs that carry no recognizable marker. It is a
 * tripwire against a publish integration LANDING IN CODE, not a proof that no
 * publish call can ever be made from Arkova infrastructure.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROHIBITED_CLAIM_PATTERNS } from './ctdl-claims-guard.js';
import { stripTsComments } from './strip-ts-comments.js';

const CTDL_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SRC = path.resolve(CTDL_DIR, '..');
const WORKER_ROOT = path.resolve(WORKER_SRC, '..');
const WORKER_SCRIPTS = path.join(WORKER_ROOT, 'scripts');
const EDGE_SRC = path.resolve(WORKER_ROOT, '..', 'edge', 'src');

/**
 * Production sources on the CTDL/CE output path. Test files are excluded (they
 * legitimately quote the banned phrases as fixtures), and comments are
 * stripped before scanning — via the string-aware `stripTsComments` (round-1
 * review finding 6: a naive per-line `indexOf('//')` truncated at the `//` in
 * URL string literals, blinding the scan to anything after `https://` on a
 * line). The guard documentation deliberately NAMES the banned phrases in
 * prose, but only CODE (i.e. strings that could be emitted) may fail this
 * test. The guard module's patterns are regex sources (`listed\s+in…`), not
 * literal phrases, so an honest scan passes.
 */
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
      const source = stripTsComments(fs.readFileSync(file, 'utf-8'));
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
  // default. These markers are how a Registry write integration would appear.
  // If a publish integration ever lands, it must arrive flag-gated OFF with
  // explicit CE-06b claims sign-off, and this test updated in the same PR.

  // WRITE-shaped markers: publish/envelope identifiers and paths. Apply to
  // EVERY scanned file with no exceptions — even read-only CE tooling must
  // never grow a write shape.
  // NOTE: no generic `/envelopes` marker — DocuSign integration code
  // legitimately calls DocuSign's own envelopes API, which has nothing to do
  // with CE Registry envelopes. CE Registry writes are envelope POSTs against
  // a CE host, so the envelope markers here are Registry-/CE-scoped.
  const REGISTRY_WRITE_MARKERS: readonly RegExp[] = [
    /registry\/publish/i,
    /publishToRegistry/i,
    /registryPublish/i,
    /publish[_-]registry/i,
    /registry[_-]publish/i,
    /registry[_-]?envelopes?/i,
    /credential[-_]?engine\w*[^\n]{0,60}\/envelopes/i,
  ];

  // INTEGRATION-surface markers: CE Registry hosts + the env-var configuration
  // shape any CE Registry integration needs (round-1 review finding 2 — the
  // original host-only list missed an integration wired through env config).
  const REGISTRY_INTEGRATION_MARKERS: readonly RegExp[] = [
    /credentialengineregistry\.org/i,
    /sandbox\.credentialengine\.org/i,
    /apps\.credentialengine\.org/i,
    /credentialengine\.org\/(?:registry|publish)/i,
    /CE_REGISTRY\w*_(?:URL|API|ENDPOINT|KEY)/,
  ];

  // The ONE sanctioned read-only CE tool: the SCRUM-2376 (CE-05) Secret-Manager
  // smoke script. Its header documents that it issues GET-only Registry calls
  // and never writes; it legitimately carries the sandbox host and the
  // CE_REGISTRY_BASE_URL env var, so it is exempt from the INTEGRATION markers
  // — but still fully subject to the WRITE markers above.
  const READ_ONLY_CE_TOOLING_ALLOWLIST = new Set([
    path.join(WORKER_SCRIPTS, 'ops', 'ce-secret-manager-smoke.ts'),
    // SCRUM-2913 — the CTDL IMPORTER (`ctdl-importer.ts`) is a read/consume
    // path: it parses CTDL documents that a caller FETCHED from the CE Registry
    // and builds a read-only provenance link (`registryUrl`) from the injected
    // registry base. It carries the registry host solely to construct that link;
    // it issues no Registry calls and never writes/publishes. Exempt from the
    // INTEGRATION (host) markers, still fully subject to the WRITE markers above.
    path.join(WORKER_SRC, 'ctdl', 'ctdl-importer.ts'),
    // SCRUM-2913 (Lane 2 wiring) — `credential-source-import.ts` is the
    // generic CSI-03 credential-source importer (GET-only, arbitrary
    // caller-supplied URL). It stamps `registry_url` / `ce_envelope_sha256`
    // provenance ONLY when the URL it already fetched (read-only, single GET,
    // never a write) happens to resolve to the real CE Registry host — it
    // never writes to the Registry. Exempt from the INTEGRATION (host)
    // markers for that host-comparison logic; still fully subject to the
    // WRITE markers above.
    path.join(WORKER_SRC, 'lib', 'credential-source-import.ts'),
  ]);

  function scanRoots(): string[] {
    const roots = [WORKER_SRC, WORKER_SCRIPTS, EDGE_SRC].filter((dir) => fs.existsSync(dir));
    return roots.flatMap((dir) => walkTsSources(dir));
  }

  it('sanity: the scan reaches worker src, worker scripts, and the edge worker src', () => {
    // If a root vanishes/moves, fail loudly instead of silently narrowing coverage.
    expect(fs.existsSync(WORKER_SRC)).toBe(true);
    expect(fs.existsSync(WORKER_SCRIPTS)).toBe(true);
    expect(fs.existsSync(EDGE_SRC)).toBe(true);
    const files = scanRoots();
    expect(files.some((f) => f.startsWith(WORKER_SRC))).toBe(true);
    expect(files.some((f) => f.startsWith(WORKER_SCRIPTS))).toBe(true);
    expect(files.some((f) => f.startsWith(EDGE_SRC))).toBe(true);
  });

  it('tripwire self-test: the marker set catches publish-integration shapes (round-1 bypasses)', () => {
    const allMarkers = [...REGISTRY_WRITE_MARKERS, ...REGISTRY_INTEGRATION_MARKERS];
    const fixtures = [
      'process.env.CE_REGISTRY_PUBLISH_URL',
      'process.env.CE_REGISTRY_API_KEY',
      'await publishToRegistry(body)',
      'const registryPublishClient = makeClient()',
      'POST registry_envelopes',
      'fetch(`https://credentialengineregistry.org/envelopes`)',
      'const CREDENTIAL_ENGINE_BASE = base; // then POST `${CREDENTIAL_ENGINE_BASE}/envelopes`',
    ];
    for (const fixture of fixtures) {
      expect(
        allMarkers.some((pattern) => pattern.test(fixture)),
        `expected a marker to catch: ${fixture}`,
      ).toBe(true);
    }
  });

  it('no repo TS source (worker src+scripts, edge src) references a CE Registry publish endpoint', () => {
    const offenders: string[] = [];
    for (const file of scanRoots()) {
      const source = fs.readFileSync(file, 'utf-8');
      const patterns = READ_ONLY_CE_TOOLING_ALLOWLIST.has(file)
        ? REGISTRY_WRITE_MARKERS
        : [...REGISTRY_WRITE_MARKERS, ...REGISTRY_INTEGRATION_MARKERS];
      for (const pattern of patterns) {
        const match = pattern.exec(source);
        if (match) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(
            `${path.relative(WORKER_ROOT, file)}:${line} matches ${String(pattern)}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every read-only CE allowlist entry still exists and still declares its read-only contract', () => {
    // If an allow-listed file moves or its read-only contract statement
    // disappears, the allowlist must be re-reviewed rather than silently
    // dangling. Held to EVERY entry (not just the first) so a newly exempted
    // file cannot skip the contract that justifies its exemption.
    const entries = [...READ_ONLY_CE_TOOLING_ALLOWLIST];
    expect(entries.length).toBeGreaterThan(0);
    for (const entryPath of entries) {
      expect(fs.existsSync(entryPath), `${entryPath} missing`).toBe(true);
      const source = fs.readFileSync(entryPath, 'utf-8');
      expect(source, entryPath).toMatch(/GET-only|READ-ONLY/i);
      expect(source, entryPath).toContain('never writes to the Registry');
    }
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
