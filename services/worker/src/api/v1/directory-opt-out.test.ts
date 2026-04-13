/**
 * Tests for FERPA Directory Information Opt-Out API — REG-02 (SCRUM-562)
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config.js', () => ({
  config: { frontendUrl: 'https://app.arkova.ai' },
}));

import { ToggleOptOutSchema, BulkOptOutSchema } from './directory-opt-out.js';

describe('Directory Opt-Out API — REG-02', () => {
  describe('ToggleOptOutSchema (exported from module)', () => {
    it('accepts valid opt_out boolean', () => {
      expect(ToggleOptOutSchema.safeParse({ opt_out: true }).success).toBe(true);
      expect(ToggleOptOutSchema.safeParse({ opt_out: false }).success).toBe(true);
    });

    it('rejects non-boolean opt_out', () => {
      expect(ToggleOptOutSchema.safeParse({ opt_out: 'yes' }).success).toBe(false);
      expect(ToggleOptOutSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('BulkOptOutSchema (exported from module)', () => {
    it('accepts valid bulk payload', () => {
      expect(BulkOptOutSchema.safeParse({
        records: [
          { public_id: 'ARK-2026-EDU-001', opt_out: true },
          { public_id: 'ARK-2026-EDU-002', opt_out: false },
        ],
      }).success).toBe(true);
    });

    it('rejects empty records', () => {
      expect(BulkOptOutSchema.safeParse({ records: [] }).success).toBe(false);
    });

    it('rejects missing public_id', () => {
      expect(BulkOptOutSchema.safeParse({
        records: [{ opt_out: true }],
      }).success).toBe(false);
    });

    it('rejects payloads exceeding 1000 records', () => {
      const tooMany = Array.from({ length: 1001 }, (_, i) => ({
        public_id: `ARK-${i}`,
        opt_out: true,
      }));
      expect(BulkOptOutSchema.safeParse({ records: tooMany }).success).toBe(false);
    });
  });
});
