#!/usr/bin/env -S npx tsx
/**
 * SCRUM-2483 — ban raw `fetch(` / `undici` in services/worker/src/**.
 *
 * The worker's outbound HTTP must go through the IP-pinned `safeFetch` egress
 * primitive (src/lib/safe-fetch.ts) so SSRF / DNS-rebind / cloud-metadata
 * exfiltration is impossible. This lint flags any bare `fetch(` call or `undici`
 * import in worker source, EXCEPT a reviewed allow-list of callers that are
 * either (a) hard-pinned to a fixed sovereign endpoint we control the hostname
 * of, or (b) already SSRF-reviewed and out of scope for this pass.
 *
 * WARN-FIRST (this PR): findings outside the allow-list are reported as WARNINGS
 * and the lint exits 0. This lets it land WITHOUT walling CI on the ~60 existing
 * egress sites. The WARN→ERROR ratchet is a SEPARATE post-triage PR, landed only
 * after every real egress path is migrated to safeFetch. Set
 * BAN_RAW_FETCH_MODE=error to preview the ratcheted (failing) behaviour locally.
 *
 * ALLOW-LIST RATIONALE (reviewed 2026-07-07):
 *   - chain/utxo-provider.ts, chain/fee-estimator.ts → mempool.space (fixed host,
 *     Bitcoin path, HANDOFF "Bitcoin paths").
 *   - ai/**.ts → Gemini / Vertex / Together / RunPod (fixed provider hosts).
 *   - jobs/*Fetcher.ts + a few named registry jobs → government/registry sources
 *     (fixed .gov / official-registry hosts; no user-controlled URL).
 *   - jobs/chain-maintenance.ts, jobs/check-confirmations.ts → mempool.space chain.
 *   - signatures/pki/*, signatures/timestamp/* → OCSP / CRL / RFC3161 (fixed CA
 *     endpoints derived from certificates, not user input).
 *   - utils/gcp-auth.ts, utils/upstash*, middleware/upstash*, middleware/x402* →
 *     GCP metadata/token + Upstash + x402 facilitator (fixed infra hosts).
 *   - audit/cloud-logging-sink.ts, jobs/bq-export-client.ts → Google APIs (fixed).
 *   - webhooks/delivery.ts, api/v1/webhooks.ts → already guarded by
 *     isPrivateUrlResolved (the ORIGINAL SSRF defense this primitive generalises;
 *     migrating these to safeFetch is tracked separately, out of scope here).
 *   - integrations/grc/adapters.ts, integrations/indexnow.ts → fixed vendor hosts.
 *   - jobs/rule-action-dispatcher.ts, jobs/*-dispatcher.ts, jobs/secret-rotation-
 *     reminder.ts, jobs/treasury-cache.ts, utils/verifyCache.ts,
 *     middleware/x402PaymentGate.ts, ai/embeddings/gemini2.ts → fixed infra hosts,
 *     SSRF-reviewed for this pass.
 *
 * NOT allow-listed (must use safeFetch): anything under src/lib/**, and the
 * credential-source import + provider clients, which take user- or partner-
 * supplied URLs.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_SRC_PREFIX = 'services/worker/src/';

/**
 * Reviewed allow-list. Entries are matched against the worker-src-relative path
 * (i.e. WITHOUT the `services/worker/src/` prefix). An entry ending in `/`
 * matches any file under that directory; an entry ending in `*` matches any
 * file in that directory whose basename starts with the stem; otherwise it is
 * an exact file match.
 */
export const RAW_FETCH_ALLOWLIST: string[] = [
  // The ONE approved undici wrapper — safeFetch IS the primitive that pins the
  // resolved IP; it is definitionally allowed to import undici.
  'lib/safe-fetch.ts',
  // mempool.space + sovereign chain paths (fixed hosts)
  'chain/utxo-provider.ts',
  'chain/fee-estimator.ts',
  'jobs/chain-maintenance.ts',
  'jobs/check-confirmations.ts',
  // AI providers (fixed provider hosts)
  'ai/',
  'api/v1/nessie-query.ts',
  // Government / official-registry job fetchers (fixed .gov/registry hosts)
  'jobs/*Fetcher.ts',
  // Fixed-infra dispatchers / caches / reminders (SSRF-reviewed this pass)
  'jobs/rule-action-dispatcher.ts',
  'jobs/treasury-alert-dispatcher.ts',
  'jobs/treasury-cache.ts',
  'jobs/secret-rotation-reminder.ts',
  'jobs/bq-export-client.ts',
  // OCSP / CRL / RFC3161 (fixed CA endpoints from certs)
  'signatures/pki/',
  'signatures/timestamp/',
  // GCP / Upstash / x402 infra (fixed hosts)
  'utils/gcp-auth.ts',
  'utils/upstashRateLimit.ts',
  'utils/verifyCache.ts',
  'middleware/upstashIdempotency.ts',
  'middleware/x402PaymentGate.ts',
  'audit/cloud-logging-sink.ts',
  // Fixed vendor hosts
  'integrations/grc/adapters.ts',
  'integrations/indexnow.ts',
  // Already guarded by isPrivateUrlResolved (original SSRF defense; migration to
  // safeFetch tracked separately, out of scope for this pass)
  'webhooks/delivery.ts',
  'api/v1/webhooks.ts',
];

export type RawFetchKind = 'fetch' | 'undici';

export interface RawFetchFinding {
  file: string;
  line: number;
  kind: RawFetchKind;
  text: string;
}

// Bare `fetch(` not preceded by an identifier char or a `.` (so `deps.fetch(`,
// `obj.fetch(`, `globalThis.fetch(`, `safeFetch(` are all excluded).
const RAW_FETCH_RE = /(^|[^\w.$])fetch\s*\(/;
const UNDICI_IMPORT_RE = /(?:from\s+['"]undici['"]|require\(\s*['"]undici['"]\s*\))/;

function stripLineComment(line: string): string {
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

/**
 * Blank out the contents of quoted string / template literals so a `fetch(` or
 * `undici` mention INSIDE a string is not flagged (only real code is). Replaces
 * the inside of each '…' / "…" / `…` run with spaces, preserving column offsets.
 */
function stripStringLiterals(line: string): string {
  let out = '';
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') {
        out += '  ';
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = undefined;
        out += ch;
      } else {
        out += ' ';
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Scan one file's text for bare `fetch(` / `undici` usage. Skips `//` comments
 * and string-literal contents, and only matches `fetch(` that is a bare global
 * call, not a method call.
 */
export function scanTextForRawFetch(file: string, text: string): RawFetchFinding[] {
  const findings: RawFetchFinding[] = [];
  const lines = text.split(/\r?\n/);

  // Track multi-line /* … */ block-comment state so JSDoc prose that mentions
  // "fetch(" or "undici" is never flagged.
  let inBlockComment = false;

  lines.forEach((rawLine, index) => {
    let working = rawLine;

    // Resolve block-comment state and blank out commented spans on this line.
    if (inBlockComment) {
      const end = working.indexOf('*/');
      if (end === -1) return; // whole line is inside a block comment
      working = ' '.repeat(end + 2) + working.slice(end + 2);
      inBlockComment = false;
    }
    // Handle any block comments that open on this line.
    for (;;) {
      const open = working.indexOf('/*');
      if (open === -1) break;
      const close = working.indexOf('*/', open + 2);
      if (close === -1) {
        working = working.slice(0, open); // rest of line is comment; opens block
        inBlockComment = true;
        break;
      }
      working = working.slice(0, open) + ' '.repeat(close + 2 - open) + working.slice(close + 2);
    }

    const uncommented = stripLineComment(working);
    // `fetch(` inside a string is not a real call — strip string contents first.
    const codeNoStrings = stripStringLiterals(uncommented);

    if (RAW_FETCH_RE.test(codeNoStrings)) {
      findings.push({ file, line: index + 1, kind: 'fetch', text: rawLine.trim() });
    }
    // The undici module specifier IS a string, so match against the
    // comment-stripped-but-string-preserved line.
    if (UNDICI_IMPORT_RE.test(uncommented)) {
      findings.push({ file, line: index + 1, kind: 'undici', text: rawLine.trim() });
    }
  });

  return findings;
}

/**
 * Is a worker-src-relative path on the reviewed allow-list?
 */
export function isAllowlisted(workerRelPath: string): boolean {
  const basename = workerRelPath.slice(workerRelPath.lastIndexOf('/') + 1);
  const dir = workerRelPath.slice(0, workerRelPath.lastIndexOf('/') + 1);

  for (const entry of RAW_FETCH_ALLOWLIST) {
    if (entry.endsWith('/')) {
      // Directory prefix match.
      if (workerRelPath.startsWith(entry)) return true;
    } else if (entry.includes('*')) {
      // Basename glob within a directory, e.g. `jobs/*Fetcher.ts`.
      const entryDir = entry.slice(0, entry.lastIndexOf('/') + 1);
      const pattern = entry.slice(entry.lastIndexOf('/') + 1);
      if (dir === entryDir && matchStar(basename, pattern)) return true;
    } else if (entry === workerRelPath) {
      return true;
    }
  }
  return false;
}

/** Minimal single-`*` glob match on a basename. */
function matchStar(basename: string, pattern: string): boolean {
  const star = pattern.indexOf('*');
  if (star === -1) return basename === pattern;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return basename.startsWith(prefix) && basename.endsWith(suffix) && basename.length >= prefix.length + suffix.length;
}

function listWorkerSrcFiles(repo: string): string[] {
  const out = execFileSync('git', ['ls-files', 'services/worker/src'], { cwd: repo, encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((p) => p.endsWith('.ts'))
    .filter((p) => !p.endsWith('.test.ts'));
}

function main(): void {
  const repo = resolve(import.meta.dirname, '..', '..');
  const mode = process.env.BAN_RAW_FETCH_MODE === 'error' ? 'error' : 'warn';

  const files = listWorkerSrcFiles(repo);
  const offending: RawFetchFinding[] = [];

  for (const file of files) {
    const workerRel = file.slice(WORKER_SRC_PREFIX.length);
    if (isAllowlisted(workerRel)) continue;

    const text = readFileSync(join(repo, file), 'utf8');
    offending.push(...scanTextForRawFetch(file, text));
  }

  if (offending.length === 0) {
    console.log(`✅ ban-raw-fetch-worker: no un-allow-listed raw fetch/undici in ${files.length} worker source file(s).`);
    return;
  }

  const marker = mode === 'error' ? '::error::' : '::warning::';
  console.log(
    `${marker}ban-raw-fetch-worker (SCRUM-2483, mode=${mode}): ${offending.length} raw fetch/undici usage(s) outside the reviewed allow-list. Route worker egress through safeFetch (src/lib/safe-fetch.ts) or add a reviewed allow-list entry with a rationale.`,
  );
  for (const finding of offending) {
    console.log(`  ${finding.file}:${finding.line} [${finding.kind}] → ${finding.text}`);
  }

  if (mode === 'error') {
    process.exit(1);
  }
  // WARN mode: never fail CI. The WARN→ERROR ratchet is a separate PR.
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
