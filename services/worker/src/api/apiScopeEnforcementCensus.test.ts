/**
 * SCRUM-3981 — census ratchet: every scope in the published vocabulary is
 * either REQUIRED somewhere in the worker, or listed below as knowingly
 * unenforced with a reason.
 *
 * `webhooks:manage` shipped in `API_KEY_SCOPES`, in `docs/api/README.md`, and
 * in the dashboard's scope picker while gating nothing. That is not a
 * one-off: a scope is added to the vocabulary in one PR and wired to a mount
 * in another, and nothing notices when the second PR never lands. A grantable
 * scope that enforces nothing is worse than no scope — an operator who mints
 * a key WITHOUT it believes they have withheld a capability they have not.
 *
 * So the class is made visible rather than tidied away: the list below is an
 * honest inventory of what the vocabulary currently promises and does not
 * deliver, and it is a ratchet in both directions —
 *   - a NEW scope must arrive with a mount or an entry here, and
 *   - once a scope IS enforced, its entry here must be deleted.
 *
 * SCOPE OF THE SCAN, stated plainly: it counts the three request-time guards
 * that take a scope string as their argument — `requireScope` (API-key only,
 * `middleware/apiKeyAuth.ts`), `requireScopeAnyAuth` (dual-mode,
 * `middleware/requireScopeAnyAuth.ts`), and `requireScopeV2`
 * (`api/v2/scopeGuard.ts`). It does NOT prove a guard is reachable, nor
 * that the route it guards is mounted; `docs.routeParity.test.ts`,
 * `phiScopeMount.test.ts` and `webhooks-scope.test.ts` carry that weight for
 * the surfaces they cover. Lines whose first non-space character is `//` or
 * `*` are skipped so a scope named only in prose does not read as a mount.
 *
 * ONE narrowing is applied, and it is the whole point of the census rather
 * than an exception to it: a `requireScope('X')` that sits on the SAME mount
 * as `requireAuth` is NOT counted. `requireScope` is API-key-only and opens
 * `if (!req.apiKey) { next(); return; }` (`middleware/apiKeyAuth.ts`), while
 * `requireAuth` (`api/v1/router.ts`) 401s any caller whose Authorization
 * header is absent or starts with `Bearer ak_` and never reads `X-API-Key`.
 * Chained together they enforce nothing for the JWT callers such a mount is
 * built for — `apiScopes.ts`'s own header and `api/v1/agents.md` both say so
 * about `/keys`. Counting that pairing as enforcement would have the census
 * certify exactly the documented-but-inert state it exists to detect.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { API_KEY_SCOPES } from './apiScopes.js';

const WORKER_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Scopes that exist in the vocabulary and are enforced by NO guard today.
 * One line each, saying what is actually true — not what we would like to be
 * true. Adding a line here is a deliberate, reviewable act.
 */
const KNOWN_UNENFORCED: Record<string, string> = {
  'write:anchors':
    'Grant-side alias only: scopeSatisfies() lets it satisfy anchor:write, which is what the mounts require. Never the required argument.',
  'admin:rules':
    'Reserved for org-admin automation/BPMN endpoints that are pre-GA; no route exists to guard (docs/api/README.md says "currently pre-GA").',
  'compliance:write':
    'Grant-side only: requireScopeAnyAuth.ts:112 hands it to ORG_ADMIN/platform-admin JWT callers (ADMIN_JWT_SCOPES). No mount requires it.',
  'oracle:read':
    'The /oracle mount requires the legacy `verify` scope instead; scopeSatisfies maps verify -> oracle:read for a required side that does not exist yet.',
  'oracle:write':
    'No oracle write route is mounted.',
  'anchor:read':
    'No mount requires it; scopeSatisfies maps verify -> anchor:read for a required side that does not exist yet. Anchor reads are public-projection routes gated by `verify`.',
  'attestations:write':
    'router.ts mounts /attestations with no scope guard; the write handlers check only that an API key is present. A real gap, owned by SCRUM-3993 (the parent build subtask), not by this webhooks PR — stated, not fixed.',
  'attestations:read':
    'GET /attestations is public by design (attestations are a public verification registry, docs/api/README.md); scopeSatisfies maps verify -> attestations:read for a required side that does not exist.',
  'keys:read':
    'The /keys mount requires keys:manage for both reads and writes; keys:read is granted by nobody and required by nobody.',
  'keys:manage':
    'Its only guard site is router.ts /keys, where requireAuth 401s every API-key caller first, so requireScope never sees req.apiKey. Real gate is the in-handler ORG_ADMIN check in keys.ts.',
};

/** Every `.ts` file under services/worker/src that is not a test. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (entry.isDirectory()) {
      sourceFiles(full, acc);
      continue;
    }
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue;
    acc.push(full);
  }
  return acc;
}

const GUARD_CALL = /require(Scope|ScopeAnyAuth|ScopeV2)\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * The `.use(...)` mount statement enclosing a guard call, or just the line if
 * the call is not inside one. Bounded lookback so a WRAPPED mount —
 * `router.use(\n  '/keys',\n  requireAuth,\n  requireScope('keys:manage'),\n...`
 * — is read as one statement; four mounts in router.ts are already wrapped,
 * and a line-only test would silently stop discounting `/keys` the day it
 * grows a fifth argument.
 */
function enclosingMount(lines: string[], index: number): string {
  for (let i = index; i >= Math.max(0, index - 12); i -= 1) {
    if (lines[i].includes('.use(')) return lines.slice(i, index + 1).join('\n');
    // A route handler or a closed statement above us means we are not inside a
    // mount; stop rather than reaching into the previous one.
    if (i < index && /^\s*(?:\}|\);|(?:router|app)\.(?:get|post|patch|put|delete)\()/.test(lines[i])) {
      break;
    }
  }
  return lines[index];
}

/** Scope strings passed to a request-time scope guard, with where they were found. */
function collectRequiredScopes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(WORKER_SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      for (const match of line.matchAll(GUARD_CALL)) {
        const [, variant, scope] = match;
        // API-key-only guard behind a JWT-only gate: enforces nothing. See the
        // header. `requireScopeAnyAuth` is the dual-mode guard and is exempt.
        if (variant === 'Scope' && /\brequireAuth\b/.test(enclosingMount(lines, index))) continue;
        const sites = found.get(scope) ?? [];
        sites.push(`${file.slice(WORKER_SRC.length + 1)}:${index + 1}`);
        found.set(scope, sites);
      }
    });
  }
  return found;
}

const required = collectRequiredScopes();

describe('API key scope vocabulary — enforcement census (SCRUM-3981)', () => {
  it('finds guard call sites at all (the scan itself is not broken)', () => {
    expect(required.size).toBeGreaterThan(0);
  });

  it.each([...API_KEY_SCOPES])('%s is required by a guard or listed as knowingly unenforced', (scope) => {
    const sites = required.get(scope);
    const unenforcedReason = KNOWN_UNENFORCED[scope];

    expect(
      Boolean(sites) || Boolean(unenforcedReason),
      `Scope "${scope}" is grantable but no requireScope/requireScopeAnyAuth/requireScopeV2 call requires it. ` +
        'Either wire it to a mount, or add it to KNOWN_UNENFORCED in this file with a one-line reason.',
    ).toBe(true);
  });

  it('does not carry a KNOWN_UNENFORCED entry for a scope that IS enforced', () => {
    const stale = Object.keys(KNOWN_UNENFORCED).filter((scope) => required.has(scope));
    expect(
      stale,
      'These scopes are now enforced — delete their KNOWN_UNENFORCED entries: ' +
        stale.map((scope) => `${scope} (${required.get(scope)?.join(', ')})`).join('; '),
    ).toEqual([]);
  });

  it('does not carry a KNOWN_UNENFORCED entry for a scope outside the vocabulary', () => {
    const unknown = Object.keys(KNOWN_UNENFORCED).filter(
      (scope) => !(API_KEY_SCOPES as readonly string[]).includes(scope),
    );
    expect(unknown, `Not in API_KEY_SCOPES: ${unknown.join(', ')}`).toEqual([]);
  });

  it('gives every KNOWN_UNENFORCED entry a non-empty reason', () => {
    for (const [scope, reason] of Object.entries(KNOWN_UNENFORCED)) {
      expect(reason.trim().length, `${scope} needs a reason`).toBeGreaterThan(10);
    }
  });

  it('does not count an API-key-only requireScope that sits behind requireAuth', () => {
    // `router.use('/keys', requireAuth, requireScope('keys:manage'), keysRouter)`
    // is the live instance. Pinned both halves so the narrowing cannot rot into
    // a no-op: the mount still looks like this, AND the scan does not count it.
    const routerSource = readFileSync(join(WORKER_SRC, 'api', 'v1', 'router.ts'), 'utf8');
    expect(routerSource).toMatch(/requireAuth,\s*requireScope\('keys:manage'\)/);
    expect(required.has('keys:manage')).toBe(false);
  });

  it('requires webhooks:manage on at least one mount (SCRUM-3981)', () => {
    // The specific regression this PR closes, pinned by name so a revert is
    // loud rather than a quiet return to "grantable but inert".
    expect(required.get('webhooks:manage')).toBeDefined();
  });
});
