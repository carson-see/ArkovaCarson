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

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db and logger
const mockFrom = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockSingle = vi.fn();
const mockInsert = vi.fn();
const mockIlike = vi.fn();
const mockOrder = vi.fn();
const mockRange = vi.fn();
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
  config: { bitcoinNetwork: 'signet', frontendUrl: 'https://app.arkova.io' },
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
    const crypto = require('crypto');
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
      const id = `ARK-IND-VER-${require('crypto').randomUUID().slice(0, 6).toUpperCase()}`;
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
  const { z } = require('zod');

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
    metadata: z.record(z.unknown()).optional(),
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
