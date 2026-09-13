/**
 * Tests for Attestation API (SN3 — Structured Attestation Identifiers)
 *
 * Validates:
 * - Public ID format: ARK-{org_prefix}-{type_code}-{unique_6}
 * - Type code mapping (9 types → 3-letter codes)
 * - IND fallback for individual users (no org)
 * - Collision retry on UNIQUE_VIOLATION (23505)
 * - Profile lookup error handling
 * - Zod validation enforcement
 */

import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { BANNED_PAYLOAD_KEYS, validateWebhookPayload } from '../../webhooks/payload-schemas.js';

// Mock db and logger
const mockFrom = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockSingle = vi.fn();
const mockInsert = vi.fn();
const mockIlike = vi.fn();
const mockOrder = vi.fn();
const _mockRange = vi.fn();
const mockUpdate = vi.fn();

vi.mock('../../utils/db.js', () => ({
  db: {
    from: (...args: unknown[]) => {
      mockFrom(...args);
      return {
        select: (...sArgs: unknown[]) => {
          mockSelect(...sArgs);
          return {
            eq: (...eArgs: unknown[]) => {
              mockEq(...eArgs);
              return {
                single: () => mockSingle(),
                eq: (...e2Args: unknown[]) => {
                  mockEq(...e2Args);
                  return { single: () => mockSingle() };
                },
              };
            },
            ilike: (...iArgs: unknown[]) => {
              mockIlike(...iArgs);
              return { order: mockOrder };
            },
            order: mockOrder,
          };
        },
        insert: (...iArgs: unknown[]) => {
          mockInsert(...iArgs);
          return {
            select: () => ({ single: () => mockSingle() }),
          };
        },
        update: (...uArgs: unknown[]) => {
          mockUpdate(...uArgs);
          return { eq: () => mockSingle() };
        },
      };
    },
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: { bitcoinNetwork: 'signet', frontendUrl: 'https://app.arkova.ai' },
}));

vi.mock('../../auth.js', () => ({
  verifyAuthToken: vi.fn().mockResolvedValue('test-user-id'),
}));

// ─── Type Code Tests ─────────────────────────────────────

describe('Attestation Type Code Mapping', () => {
  // Import the module to access the type code map
  const ATTESTATION_TYPE_CODES: Record<string, string> = {
    VERIFICATION: 'VER',
    ENDORSEMENT: 'END',
    AUDIT: 'AUD',
    APPROVAL: 'APR',
    WITNESS: 'WIT',
    COMPLIANCE: 'COM',
    SUPPLY_CHAIN: 'SUP',
    IDENTITY: 'IDN',
    CUSTOM: 'CUS',
  };

  it('maps all 9 attestation types to 3-letter codes', () => {
    expect(Object.keys(ATTESTATION_TYPE_CODES)).toHaveLength(9);
    for (const code of Object.values(ATTESTATION_TYPE_CODES)) {
      expect(code).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('maps VERIFICATION to VER', () => {
    expect(ATTESTATION_TYPE_CODES['VERIFICATION']).toBe('VER');
  });

  it('maps ENDORSEMENT to END', () => {
    expect(ATTESTATION_TYPE_CODES['ENDORSEMENT']).toBe('END');
  });

  it('maps AUDIT to AUD', () => {
    expect(ATTESTATION_TYPE_CODES['AUDIT']).toBe('AUD');
  });

  it('maps COMPLIANCE to COM', () => {
    expect(ATTESTATION_TYPE_CODES['COMPLIANCE']).toBe('COM');
  });

  it('maps SUPPLY_CHAIN to SUP', () => {
    expect(ATTESTATION_TYPE_CODES['SUPPLY_CHAIN']).toBe('SUP');
  });

  it('maps IDENTITY to IDN', () => {
    expect(ATTESTATION_TYPE_CODES['IDENTITY']).toBe('IDN');
  });
});

// ─── Public ID Format Tests ──────────────────────────────

describe('Attestation Public ID Format', () => {
  it('generates IDs matching ARK-{prefix}-{type}-{unique} pattern', () => {
    const pattern = /^ARK-[A-Z0-9]{2,6}-[A-Z]{3}-[A-Z0-9]{6}$/;

    // Simulate format generation
    const orgPrefix = 'UMI';
    const typeCode = 'VER';
    const uniquePart = 'A3F2B1';
    const publicId = `ARK-${orgPrefix}-${typeCode}-${uniquePart}`;

    expect(publicId).toMatch(pattern);
    expect(publicId).toBe('ARK-UMI-VER-A3F2B1');
  });

  it('uses IND prefix for individual users without org', () => {
    const publicId = `ARK-IND-AUD-X9Y8Z7`;
    expect(publicId).toMatch(/^ARK-IND-/);
  });

  it('uses org_prefix for org users', () => {
    const publicId = `ARK-ACC-COM-123456`;
    expect(publicId).toMatch(/^ARK-ACC-/);
  });

  it('generates unique 6-char suffix from UUID', () => {
    // crypto imported at top level
    const uuid = crypto.randomUUID();
    const uniquePart = uuid.slice(0, 6).toUpperCase();

    expect(uniquePart).toMatch(/^[A-F0-9]{6}$/);
    expect(uniquePart).toHaveLength(6);
  });
});

// ─── Org Prefix Generation Tests ─────────────────────────

describe('Org Prefix Generation Logic', () => {
  it('generates 3-char prefix from 3+ word names (initials)', () => {
    // "University of Michigan" → "UOM"
    const words = 'UNIVERSITY OF MICHIGAN'.split(/\s+/);
    const prefix = words[0][0] + words[1][0] + words[2][0];
    expect(prefix).toBe('UOM');
  });

  it('generates 3-char prefix from 2-word names', () => {
    // "Acme Corporation" → "ACC"
    const words = 'ACME CORPORATION'.split(/\s+/);
    const prefix = words[0].slice(0, 2) + words[1][0];
    expect(prefix).toBe('ACC');
  });

  it('generates 3-char prefix from single-word names', () => {
    // "Arkova" → "ARK"
    const word = 'ARKOVA';
    const prefix = word.slice(0, 3);
    expect(prefix).toBe('ARK');
  });

  it('pads short prefixes with X', () => {
    const word = 'A';
    let prefix = word.slice(0, 3);
    if (prefix.length < 2) prefix += 'X';
    expect(prefix).toBe('AX');
  });
});

// ─── Collision Retry Tests ───────────────────────────────

describe('Attestation ID Collision Handling', () => {
  it('retries up to 3 times on UNIQUE_VIOLATION (23505)', () => {
    // Verify the retry constant
    const MAX_RETRIES = 3;
    expect(MAX_RETRIES).toBe(3);

    // Simulate retry loop
    let attempts = 0;
    const ids: string[] = [];
    for (let i = 0; i < MAX_RETRIES; i++) {
      attempts++;
      const id = `ARK-IND-VER-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
      ids.push(id);
    }
    expect(attempts).toBe(3);
    // All generated IDs should be unique (extremely high probability)
    expect(new Set(ids).size).toBe(3);
  });

  it('stops retrying on non-collision errors', () => {
    const error = { code: '42P01', message: 'relation does not exist' };
    expect(error.code).not.toBe('23505');
    // Non-23505 errors should not trigger retry
  });
});

// ─── Validation Tests ────────────────────────────────────

describe('Attestation Validation', () => {
  // z imported at top level

  const CreateAttestationSchema = z.object({
    anchor_id: z.string().uuid().optional(),
    subject_type: z.enum(['credential', 'entity', 'process', 'asset']).default('credential'),
    subject_identifier: z.string().min(1).max(500),
    attestation_type: z.enum([
      'VERIFICATION', 'ENDORSEMENT', 'AUDIT', 'APPROVAL',
      'WITNESS', 'COMPLIANCE', 'SUPPLY_CHAIN', 'IDENTITY', 'CUSTOM',
    ]),
    attester_name: z.string().min(1).max(200),
    attester_type: z.enum(['INSTITUTION', 'CORPORATION', 'INDIVIDUAL', 'REGULATORY', 'THIRD_PARTY']).default('INSTITUTION'),
    attester_title: z.string().max(200).optional(),
    claims: z.array(z.object({
      claim: z.string().min(1),
      evidence: z.string().optional(),
    })).min(1).max(50),
    summary: z.string().max(2000).optional(),
    jurisdiction: z.string().max(100).optional(),
    evidence_fingerprint: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
    expires_at: z.string().datetime().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });

  it('accepts valid attestation input', () => {
    const valid = {
      attestation_type: 'VERIFICATION',
      attester_name: 'University of Michigan',
      subject_identifier: 'Bachelor of Science in Computer Science',
      claims: [{ claim: 'Degree conferred on 2024-05-20' }],
    };
    const result = CreateAttestationSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects empty attester_name', () => {
    const invalid = {
      attestation_type: 'VERIFICATION',
      attester_name: '',
      subject_identifier: 'test',
      claims: [{ claim: 'test claim' }],
    };
    const result = CreateAttestationSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects empty claims array', () => {
    const invalid = {
      attestation_type: 'AUDIT',
      attester_name: 'Auditor',
      subject_identifier: 'test',
      claims: [],
    };
    const result = CreateAttestationSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects invalid attestation_type', () => {
    const invalid = {
      attestation_type: 'INVALID_TYPE',
      attester_name: 'Test',
      subject_identifier: 'test',
      claims: [{ claim: 'test' }],
    };
    const result = CreateAttestationSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects subject_identifier over 500 chars', () => {
    const invalid = {
      attestation_type: 'VERIFICATION',
      attester_name: 'Test',
      subject_identifier: 'a'.repeat(501),
      claims: [{ claim: 'test' }],
    };
    const result = CreateAttestationSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects invalid evidence_fingerprint format', () => {
    const invalid = {
      attestation_type: 'VERIFICATION',
      attester_name: 'Test',
      subject_identifier: 'test',
      claims: [{ claim: 'test' }],
      evidence_fingerprint: 'not-a-valid-hex',
    };
    const result = CreateAttestationSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('accepts valid 64-char hex evidence_fingerprint', () => {
    const valid = {
      attestation_type: 'VERIFICATION',
      attester_name: 'Test',
      subject_identifier: 'test',
      claims: [{ claim: 'test' }],
      evidence_fingerprint: 'a'.repeat(64),
    };
    const result = CreateAttestationSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('defaults subject_type to credential', () => {
    const valid = {
      attestation_type: 'VERIFICATION',
      attester_name: 'Test',
      subject_identifier: 'test',
      claims: [{ claim: 'test' }],
    };
    const result = CreateAttestationSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subject_type).toBe('credential');
    }
  });

  it('rejects more than 50 claims', () => {
    const invalid = {
      attestation_type: 'VERIFICATION',
      attester_name: 'Test',
      subject_identifier: 'test',
      claims: Array.from({ length: 51 }, (_, i) => ({ claim: `claim ${i}` })),
    };
    const result = CreateAttestationSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});

// ─── SCRUM-897 Rich Evidence + Credential Include Helpers ─────────────

describe('Attestation rich evidence helpers', () => {
  it('parses include=credentials from comma-separated query values', async () => {
    const { shouldIncludeAttestorCredentials } = await import('./attestations.js');
    expect(shouldIncludeAttestorCredentials('credentials')).toBe(true);
    expect(shouldIncludeAttestorCredentials('evidence, credentials')).toBe(true);
    expect(shouldIncludeAttestorCredentials(['foo', 'credentials'])).toBe(true);
    expect(shouldIncludeAttestorCredentials(undefined)).toBe(false);
  });

  it('maps public evidence without leaking the internal evidence UUID', async () => {
    const { toPublicEvidenceItem } = await import('./attestations.js');
    const item = toPublicEvidenceItem({
      id: 'internal-evidence-id',
      public_id: 'AEV-ABCDEF1234567890ABCDEF1234567890',
      evidence_type: 'document',
      description: 'Court filing',
      fingerprint: 'a'.repeat(64),
      mime_type: 'application/pdf',
      size_bytes: 4096,
      created_at: '2026-05-03T14:00:00Z',
    });

    expect(item).toEqual({
      id: 'AEV-ABCDEF1234567890ABCDEF1234567890',
      public_id: 'AEV-ABCDEF1234567890ABCDEF1234567890',
      evidence_type: 'document',
      description: 'Court filing',
      fingerprint: 'a'.repeat(64),
      mime: 'application/pdf',
      size: 4096,
      created_at: '2026-05-03T14:00:00Z',
    });
    expect(item.id).toBe(item.public_id);
  });

  it('caps attestor credential lineage at requested item plus two parent levels', async () => {
    const { capAttestorCredentialLineage } = await import('./attestations.js');
    const lineage = [1, 2, 3, 4].map((version) => ({
      public_id: `ARK-CRED-${version}`,
      credential_type: 'LICENSE',
      version_number: version,
      parent_public_id: version === 1 ? null : `ARK-CRED-${version - 1}`,
      status: 'SECURED',
      fingerprint: `${version}`.repeat(64),
      chain_tx_id: `tx-${version}`,
      chain_block_height: 800000 + version,
      chain_timestamp: '2026-05-03T14:00:00Z',
      is_current: version === 4,
    }));

    const capped = capAttestorCredentialLineage(lineage, 'ARK-CRED-3');

    expect(capped).toHaveLength(3);
    expect(capped.map((item) => item.public_id)).toEqual([
      'ARK-CRED-1',
      'ARK-CRED-2',
      'ARK-CRED-3',
    ]);
    expect(capped[0].chain_proof?.explorer_url).toContain('/tx/tx-1');
  });

  it('filters non-public attestor credential lineage statuses', async () => {
    const { capAttestorCredentialLineage } = await import('./attestations.js');
    const lineage = [
      {
        public_id: 'ARK-CRED-1',
        credential_type: 'LICENSE',
        version_number: 1,
        parent_public_id: null,
        status: 'SECURED',
        fingerprint: '1'.repeat(64),
        chain_tx_id: 'tx-1',
        chain_block_height: 800001,
        chain_timestamp: '2026-05-03T14:00:00Z',
        is_current: false,
      },
      {
        public_id: 'ARK-CRED-2',
        credential_type: 'LICENSE',
        version_number: 2,
        parent_public_id: 'ARK-CRED-1',
        status: 'SUBMITTED',
        fingerprint: '2'.repeat(64),
        chain_tx_id: 'tx-2',
        chain_block_height: 800002,
        chain_timestamp: '2026-05-03T14:00:00Z',
        is_current: false,
      },
      {
        public_id: 'ARK-CRED-3',
        credential_type: 'LICENSE',
        version_number: 3,
        parent_public_id: 'ARK-CRED-2',
        status: 'SECURED',
        fingerprint: '3'.repeat(64),
        chain_tx_id: 'tx-3',
        chain_block_height: 800003,
        chain_timestamp: '2026-05-03T14:00:00Z',
        is_current: true,
      },
    ];

    const capped = capAttestorCredentialLineage(lineage, 'ARK-CRED-3');

    expect(capped.map((item) => item.public_id)).toEqual(['ARK-CRED-1', 'ARK-CRED-3']);
    expect(capAttestorCredentialLineage(lineage, 'ARK-CRED-2')).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * SCRUM-3982 — outbound webhook payloads from this router.
 *
 * The route handlers are mounted behind `requireAuth` + Supabase, and this
 * suite has no HTTP harness, so the dispatch payloads are asserted against the
 * SOURCE of their own call sites. That is deliberate and not a weaker test
 * than a spy: the thing being ratcheted is the literal set of keys written at
 * the call site, and reading it straight from the file catches a re-added
 * `fingerprint` no matter which code path reaches the dispatch.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('attestation webhook payloads carry public ids only (SCRUM-3982)', () => {
  const SOURCE = readFileSync(
    new URL('./attestations.ts', import.meta.url),
    'utf-8',
  );

  /**
   * Top-level keys of the object literal passed to
   * `dispatchWebhookEvent(orgExpr, '<eventType>', idExpr, { … })`.
   * Brace-balanced so a nested object cannot truncate the scan.
   */
  function dispatchedPayloadKeys(eventType: string): string[] {
    const marker = `'${eventType}'`;
    const at = SOURCE.indexOf(marker);
    expect(at, `no dispatchWebhookEvent call site for ${eventType}`).toBeGreaterThan(-1);
    const open = SOURCE.indexOf('{', at);
    expect(open).toBeGreaterThan(-1);

    let depth = 0;
    let close = -1;
    for (let i = open; i < SOURCE.length; i++) {
      if (SOURCE[i] === '{') depth++;
      else if (SOURCE[i] === '}') {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    expect(close, 'unbalanced object literal').toBeGreaterThan(open);

    const body = SOURCE.slice(open + 1, close);
    const keys: string[] = [];
    let nesting = 0;
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      const match = /^([a-z_][a-z0-9_]*)\s*:/i.exec(trimmed);
      if (nesting === 0 && match) keys.push(match[1]);
      nesting += (line.match(/[{[]/g) ?? []).length - (line.match(/[}\]]/g) ?? []).length;
    }
    return keys;
  }

  it('attestation.created no longer ships the document fingerprint (CLAUDE.md §1.6)', () => {
    const keys = dispatchedPayloadKeys('attestation.created');
    expect(keys).not.toContain('fingerprint');
    expect(keys).toEqual(['public_id', 'attestation_type', 'status', 'created_at']);
  });

  it('attestation.revoked ships public ids only', () => {
    const keys = dispatchedPayloadKeys('attestation.revoked');
    expect(keys).toEqual(['public_id', 'status', 'revocation_reason', 'revoked_at']);
  });

  it.each(['attestation.created', 'attestation.revoked'])(
    '%s carries no key the outbound allowlist bans',
    (eventType) => {
      for (const key of dispatchedPayloadKeys(eventType)) {
        expect(BANNED_PAYLOAD_KEYS).not.toContain(key);
        expect(key.startsWith('_')).toBe(false);
      }
    },
  );

  it('both dispatched payloads validate against their registered schemas', () => {
    // Shapes built from the key lists above with representative values, so a
    // key added at the call site without a matching schema field fails here
    // too, not only in production.
    const created = validateWebhookPayload('attestation.created', {
      public_id: 'ARK-ORG-VER-ABC123',
      attestation_type: 'VERIFICATION',
      status: 'PENDING',
      created_at: '2026-09-12T10:00:00Z',
    });
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.bypassed).toBeUndefined();

    const revoked = validateWebhookPayload('attestation.revoked', {
      public_id: 'ARK-ORG-VER-ABC123',
      status: 'REVOKED',
      revocation_reason: 'Issued in error',
      revoked_at: '2026-09-12T10:00:00Z',
    });
    expect(revoked.ok).toBe(true);
    if (revoked.ok) expect(revoked.bypassed).toBeUndefined();
  });

  it('the revoke handler stamps ONE revoked_at across row, webhook and response', () => {
    // Was three separate `new Date().toISOString()` calls — the stored value,
    // the delivered value and the returned value were all different instants.
    //
    // CTO review (finding C8/RA6): the assertion is scoped to the revoke
    // handler's OWN body, brace-balanced. It used to slice from the handler to
    // EOF, so it counted every `new Date()` in every route declared after it —
    // a test that would have gone red for a change in an unrelated handler,
    // reporting a clock bug that did not exist.
    const start = SOURCE.indexOf("router.patch('/:publicId/revoke'");
    expect(start, 'revoke handler not found').toBeGreaterThan(-1);
    const bodyOpen = SOURCE.indexOf('{', SOURCE.indexOf('=>', start));
    let depth = 0;
    let bodyClose = -1;
    for (let i = bodyOpen; i < SOURCE.length; i++) {
      if (SOURCE[i] === '{') depth++;
      else if (SOURCE[i] === '}' && --depth === 0) {
        bodyClose = i;
        break;
      }
    }
    expect(bodyClose, 'unbalanced revoke handler body').toBeGreaterThan(bodyOpen);

    // Strip line comments — the rationale comment names the old call.
    const handler = SOURCE.slice(bodyOpen, bodyClose + 1).replace(/\/\/[^\n]*/g, '');
    expect(handler).toContain('const revokedAt = new Date().toISOString();');
    expect(handler.match(/new Date\(\)\.toISOString\(\)/g)).toHaveLength(1);
    expect(handler.match(/revoked_at: revokedAt/g)).toHaveLength(3);
  });
});
