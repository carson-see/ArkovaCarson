/**
 * SCRUM-1444 (R2-8 sub-B) — attestations.ts response sanitizer tests.
 *
 * Pin that internal-actor UUIDs (`id`, `attester_user_id`, `attester_org_id`,
 * `anchor_id`) and BANNED_RESPONSE_KEYS never reach customer-facing payloads.
 *
 * The route SELECTs already omit `id` / `attester_user_id` / `attester_org_id`
 * for the list endpoint, but a future SELECT widening would silently leak
 * through the `...a` spread without this defensive filter. This file pins
 * the shape of the sanitizer so future refactors cannot regress.
 *
 * Mirrors the agents-sanitizer.test.ts pattern (SCRUM-1271-A).
 *
 * Defense-in-depth note (added 2026-05-03 per code-review feedback):
 * the non-list handlers (POST `/`, GET `/:publicId`, batch-create,
 * batch-verify, PATCH revoke) use explicit field listing rather than
 * `toPublicAttestation()` because each has a different v1 response shape
 * (per CLAUDE.md §1.8 frozen schema) that includes nested `attester` /
 * `claims` / `chain_proof` / `evidence` blocks; wrapping them through the
 * flat allowlist would lose those legitimate fields. The static-source
 * test below scans attestations.ts and pins that **no** `res.json()` /
 * `res.status(...).json()` call argument passes a `...spread` of an
 * untrusted object — that's the refactor regression that would silently
 * leak. If a future change introduces a spread, the test fails and the
 * author is forced to either route through `toPublicAttestation()` or
 * add an explicit allowlist alongside the fail.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { toPublicAttestation } from './attestationResponse.js';
import { findBannedKeys } from './response-schemas.js';
import { attestationsRouter } from './attestations.js';

const mockRange = vi.hoisted(() => vi.fn());

vi.mock('../../utils/db.js', () => {
  const queryChain: Record<string, unknown> = {};
  queryChain.eq = vi.fn(() => queryChain);
  queryChain.ilike = vi.fn(() => queryChain);
  queryChain.lt = vi.fn(() => queryChain);
  queryChain.order = vi.fn(() => queryChain);
  queryChain.range = mockRange;

  return {
    db: {
      from: vi.fn(() => ({
        select: vi.fn(() => queryChain),
      })),
    },
  };
});

vi.mock('../../utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: { frontendUrl: 'https://app.arkova.ai', bitcoinNetwork: 'signet' },
}));

vi.mock('../../auth.js', () => ({
  verifyAuthToken: vi.fn(),
}));

vi.mock('../../webhooks/delivery.js', () => ({
  dispatchWebhookEvent: vi.fn(),
}));

// ───────────────────────────────────────────────────────────────────────────
// Helpers for the static-source defense test below. Hoisted to module scope
// per SonarCloud guidance (the linter wants these out of the describe-block
// closure to avoid per-test reallocation + to keep each function under its
// own complexity ceiling). Same behavior as the in-block versions; just
// rebuilt for cleanliness.
// ───────────────────────────────────────────────────────────────────────────

/** Scan one body span, append any non-allowlisted `...ident` spread. */
function collectSpreads(
  span: string,
  line: number,
  allowlist: ReadonlySet<string>,
  findings: Array<{ line: number; spread: string }>,
): void {
  const SPREAD = /\.\.\.([A-Za-z_$][\w$]*)/g;
  let s: RegExpExecArray | null;
  while ((s = SPREAD.exec(span)) !== null) {
    if (!allowlist.has(s[1])) findings.push({ line, spread: `...${s[1]}` });
  }
}

/** Walk one line forward from `start`, balancing parens; returns where
 * the outer `)` closed (-1 if it didn't close on this line). */
function scanLine(
  line: string,
  start: number,
  initialDepth: number,
): { closedAt: number; endDepth: number } {
  let depth = initialDepth;
  for (let j = start; j < line.length; j++) {
    const c = line[j];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (depth === 0) return { closedAt: j, endDepth: 0 };
  }
  return { closedAt: -1, endDepth: depth };
}

/** Scan a source file for non-allowlisted spreads inside res.json(...) /
 * res.status(...).json(...) call arguments. Returns the offending findings. */
function findUntrustedResponseSpreads(
  source: string,
  allowlist: ReadonlySet<string>,
): Array<{ line: number; spread: string }> {
  const RESPONSE_OPEN = /\bres\s*(?:\.status\s*\([^)]*\))?\s*\.json\s*\(/g;
  const findings: Array<{ line: number; spread: string }> = [];
  const lines = source.split('\n');

  let inResponse = false;
  let startLine = 0;
  let depth = 0;
  let span = '';

  for (let i = 0; i < lines.length; i++) {
    let scanFrom = 0;

    if (!inResponse) {
      RESPONSE_OPEN.lastIndex = 0;
      const m = RESPONSE_OPEN.exec(lines[i]);
      if (!m) continue;
      inResponse = true;
      startLine = i + 1;
      scanFrom = m.index + m[0].length;
      depth = 1;
      span = '';
    }

    const result = scanLine(lines[i], scanFrom, depth);
    if (result.closedAt >= 0) {
      span += (span ? '\n' : '') + lines[i].slice(scanFrom, result.closedAt);
      collectSpreads(span, startLine, allowlist, findings);
      inResponse = false;
      span = '';
    } else {
      depth = result.endDepth;
      span += (span ? '\n' : '') + lines[i].slice(scanFrom);
    }
  }
  return findings;
}

describe('attestations.ts public shape (SCRUM-1444 / SCRUM-1271-B)', () => {
  const fullDbRow = {
    id: 'attestation-uuid-internal',
    public_id: 'ARK-ARKOVA-VER-A1B2C3',
    anchor_id: 'anchor-uuid-internal',
    attester_user_id: 'user-uuid-internal',
    attester_org_id: 'org-uuid-internal',
    org_id: 'org-uuid-internal',
    attestation_type: 'VERIFICATION',
    status: 'ACTIVE',
    subject_type: 'credential',
    subject_identifier: 'cred-12345',
    attester_name: 'Acme Verifier',
    attester_type: 'INSTITUTION',
    summary: 'Verified by Acme on 2026-04-29.',
    fingerprint: 'a'.repeat(64),
    issued_at: '2026-04-29T00:00:00Z',
    expires_at: null,
    created_at: '2026-04-29T00:00:00Z',
    chain_tx_id: null,
  };

  beforeEach(() => {
    mockRange.mockResolvedValue({ data: [fullDbRow], count: 1, error: null });
  });

  it('strips internal id, attester_user_id, attester_org_id, anchor_id', () => {
    const out = toPublicAttestation(fullDbRow);
    expect(out).not.toHaveProperty('id');
    expect(out).not.toHaveProperty('attester_user_id');
    expect(out).not.toHaveProperty('attester_org_id');
    expect(out).not.toHaveProperty('anchor_id');
    expect(out).not.toHaveProperty('org_id');
  });

  it('drops unapproved future columns instead of relying on a blacklist', () => {
    const out = toPublicAttestation({
      ...fullDbRow,
      internal_review_notes: 'never expose this',
      raw_claim_payload: { pii: true },
    });
    expect(out).not.toHaveProperty('internal_review_notes');
    expect(out).not.toHaveProperty('raw_claim_payload');
  });

  it('strips every BANNED_RESPONSE_KEYS field', () => {
    const out = toPublicAttestation(fullDbRow);
    expect(findBannedKeys(out)).toEqual([]);
  });

  it('preserves customer-facing fields (public_id, attestation_type, fingerprint, ...)', () => {
    const out = toPublicAttestation(fullDbRow);
    expect(out).toMatchObject({
      public_id: 'ARK-ARKOVA-VER-A1B2C3',
      attestation_type: 'VERIFICATION',
      status: 'ACTIVE',
      fingerprint: 'a'.repeat(64),
      attester_name: 'Acme Verifier',
      created_at: '2026-04-29T00:00:00Z',
    });
  });

  it('returns empty object for null / undefined input', () => {
    expect(toPublicAttestation(null)).toEqual({});
    expect(toPublicAttestation(undefined)).toEqual({});
    expect(toPublicAttestation({})).toEqual({});
  });

  it('does not mutate the input row', () => {
    const before = { ...fullDbRow };
    toPublicAttestation(fullDbRow);
    expect(fullDbRow).toEqual(before);
  });

  it('sanitizes list endpoint items before adding verify_url', async () => {
    const app = express();
    app.use('/api/v1/attestations', attestationsRouter);

    const res = await request(app).get('/api/v1/attestations').expect(200);
    const item = res.body.attestations[0];

    expect(findBannedKeys(item)).toEqual([]);
    expect(item).not.toHaveProperty('id');
    expect(item).not.toHaveProperty('attester_user_id');
    expect(item).not.toHaveProperty('attester_org_id');
    expect(item).not.toHaveProperty('anchor_id');
    expect(item).not.toHaveProperty('org_id');
    expect(item.verify_url).toBe('https://app.arkova.ai/verify/attestation/ARK-ARKOVA-VER-A1B2C3');
  });

  // ───────────────────────────────────────────────────────────────────────
  // Static-source defense: pin that no `res.json(...)` / `res.status(...).json(...)`
  // call argument introduces a `...spread` of an untrusted object — the
  // refactor regression that would silently leak `id` / `org_id` / etc.
  //
  // The list endpoint legitimately uses `...toPublicAttestation(a)` (whitelisted
  // by name); any other spread fails the test. The author then has to either
  // route the new spread through `toPublicAttestation()` or extend this
  // allowlist with an explicit justification.
  // ───────────────────────────────────────────────────────────────────────

  // Helpers `collectSpreads`, `scanLine`, `findUntrustedResponseSpreads`
  // are at module scope (above the describe block) per SonarCloud's
  // outer-scope guidance. See the comment block there.

  it('attestations.ts has no res.json() spread of untrusted rows (static-source defense)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, 'attestations.ts'), 'utf8');

    const ALLOWLISTED_SPREADS = new Set<string>([
      'toPublicAttestation', // sanitizer — explicit allowlist, safe by construction
    ]);

    const findings = findUntrustedResponseSpreads(source, ALLOWLISTED_SPREADS);
    expect(findings, 'attestations.ts: untrusted spread in res.json() call').toEqual([]);
  });
});
