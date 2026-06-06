/**
 * SCRUM-2245 (HARDEN-1-B) — guard against `.rpc(...).catch(...)`.
 *
 * A Supabase PostgREST RPC builder is a *thenable*, not a Promise: it has
 * `.then(onOk, onErr)` but NO `.catch`. Calling `.catch()` on it throws
 * "rpc(...).catch is not a function" (Sentry FRONTEND-1/4/5), surfacing as an
 * unhandled rejection. The safe form is `await`, `.then(onOk, onErr)`, or a
 * try/catch around `await`.
 *
 * This is a cheap static guard: it walks the frontend `src/` tree and fails if
 * any source calls `.catch(` directly on a `.rpc(...)` builder. The behavioral
 * regression lives in src/pages/PipelineAdminPage.test.tsx.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_DIR = path.resolve(__dirname, '..');
const SOURCE_EXT = new Set(['.ts', '.tsx']);

// Detect `.rpc(...)` whose chain reaches `.catch(` within the SAME expression.
// We scan from each `.rpc(` and look at the immediately following chain; a `;`,
// `await`, `fetch(`, or a `.then(` (the safe two-arg form replaces `.catch`)
// ends the window. Newlines are allowed so `.rpc('x')\n  .catch(` is caught,
// but an unrelated `.catch(` on a later `fetch()` is not, because the statement
// boundary (`;` / `await`) between them closes the window.
const STATEMENT_BREAK = /[;{}]|\bawait\b|\bfetch\s*\(|\.then\s*\(/;

function hasRpcCatch(text: string): boolean {
  let idx = text.indexOf('.rpc(');
  while (idx !== -1) {
    // Walk forward from the end of `.rpc(` to its matching close paren, then
    // continue along the chain until a statement break or `.catch(`.
    let depth = 0;
    let i = idx + '.rpc'.length;
    // advance to opening paren
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '(') { depth++; }
      else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
    }
    // now i is just past the rpc(...) close paren; inspect the chain window
    const window = text.slice(i, i + 200);
    const breakMatch = window.match(STATEMENT_BREAK);
    const catchMatch = window.match(/\.catch\s*\(/);
    if (catchMatch && (!breakMatch || catchMatch.index! < breakMatch.index!)) {
      return true;
    }
    idx = text.indexOf('.rpc(', idx + 1);
  }
  return false;
}

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collectSourceFiles(full, acc);
    } else if (SOURCE_EXT.has(path.extname(entry.name)) && !entry.name.includes('.test.')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('SCRUM-2245 — no .rpc(...).catch( in src/', () => {
  it('never calls .catch() directly on a Supabase rpc() builder', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_DIR)) {
      const text = fs.readFileSync(file, 'utf8');
      if (hasRpcCatch(text)) {
        offenders.push(path.relative(SRC_DIR, file));
      }
    }
    expect(
      offenders,
      `Found .rpc(...).catch( — RPC builders are thenables, not Promises. ` +
        `Use await/.then(onOk,onErr) instead. Offending files: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
