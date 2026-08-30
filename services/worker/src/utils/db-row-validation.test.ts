import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DB_UUID_RE, dbUuid, parseDbRows } from './db-row-validation.js';

/**
 * The exact fixture-org shape from BUG-2026-08-12-003 / FD-15: zero version and
 * variant nibbles. Postgres `uuid` accepts and stores it; Zod 4.4.3's strict
 * RFC-9562 `.uuid()` rejects it.
 */
const ZERO_NIBBLE_UUID = 'aaaaaaaa-0000-0000-0000-000000000001';
const V4_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeLogger() {
  return { error: vi.fn() };
}

describe('dbUuid', () => {
  it('accepts a zero version/variant UUID that Postgres can legitimately hold (FD-15)', () => {
    expect(dbUuid('org_id').safeParse(ZERO_NIBBLE_UUID).success).toBe(true);
  });

  it('is strictly more permissive than Zod strict uuid(), never less', () => {
    // Anything strict `.uuid()` accepts, `dbUuid` must also accept — otherwise
    // relaxing a DB-sourced site could newly reject data that used to work.
    const samples = [
      V4_UUID,
      '00000000-0000-4000-8000-000000000000',
      'ffffffff-ffff-4fff-bfff-ffffffffffff',
      '6ba7b810-9dad-11d1-80b4-00c04fd430c8', // v1
    ];
    for (const sample of samples) {
      expect(z.string().uuid().safeParse(sample).success).toBe(true);
      expect(dbUuid().safeParse(sample).success).toBe(true);
    }
    // And it accepts at least one value strict uuid() rejects.
    expect(z.string().uuid().safeParse(ZERO_NIBBLE_UUID).success).toBe(false);
    expect(dbUuid().safeParse(ZERO_NIBBLE_UUID).success).toBe(true);
  });

  it('still fails closed on genuinely malformed values', () => {
    const bad = [
      'not-a-uuid',
      '',
      'aaaaaaaa-0000-0000-0000-00000000000', // 11 in last group
      'aaaaaaaa-0000-0000-0000-0000000000011', // 13 in last group
      'gggggggg-0000-0000-0000-000000000001', // non-hex
      'aaaaaaaa000000000000000000000001', // unhyphenated
      ` ${ZERO_NIBBLE_UUID}`,
      `${ZERO_NIBBLE_UUID} `,
      `${ZERO_NIBBLE_UUID}\n`,
    ];
    for (const value of bad) {
      expect(dbUuid().safeParse(value).success, `expected ${JSON.stringify(value)} to be rejected`).toBe(false);
    }
  });

  it('rejects non-strings', () => {
    for (const value of [42, null, undefined, {}, []]) {
      expect(dbUuid().safeParse(value).success).toBe(false);
    }
  });

  it('is anchored so an embedded UUID cannot smuggle a payload through', () => {
    expect(DB_UUID_RE.test(`prefix${V4_UUID}`)).toBe(false);
    expect(DB_UUID_RE.test(`${V4_UUID}suffix`)).toBe(false);
  });

  it('names the field in the failure message for diagnosability', () => {
    const parsed = dbUuid('org_id').safeParse('nope');
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain('org_id');
    }
  });
});

describe('parseDbRows', () => {
  const RowSchema = z.object({ id: dbUuid('id'), name: z.string() });

  it('keeps the good rows when one row is malformed (FD-15 blast radius)', () => {
    const logger = makeLogger();
    const result = parseDbRows(
      RowSchema,
      [
        { id: V4_UUID, name: 'first' },
        { id: 'not-a-uuid', name: 'poison' },
        { id: ZERO_NIBBLE_UUID, name: 'third' },
      ],
      { source: 'test_rpc', logger },
    );

    expect(result.rows).toEqual([
      { id: V4_UUID, name: 'first' },
      { id: ZERO_NIBBLE_UUID, name: 'third' },
    ]);
    expect(result.quarantined).toBe(1);
  });

  it('logs loudly rather than silently dropping', () => {
    const logger = makeLogger();
    parseDbRows(RowSchema, [{ id: 'bad', name: 'x' }], { source: 'test_rpc', logger });

    expect(logger.error).toHaveBeenCalled();
    const [context] = logger.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(context).toMatchObject({ source: 'test_rpc', rowIndex: 0 });
  });

  it('never logs the offending row value (no PII in logs, CLAUDE.md §1.4)', () => {
    const logger = makeLogger();
    const secret = 'patient@example.com';
    parseDbRows(RowSchema, [{ id: 'bad', name: secret }], { source: 'test_rpc', logger });

    const serialized = JSON.stringify(logger.error.mock.calls);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('bad');
  });

  it('returns empty without throwing when every row is malformed', () => {
    const logger = makeLogger();
    const result = parseDbRows(RowSchema, [{ id: 'a' }, { id: 'b' }], { source: 'test_rpc', logger });

    expect(result.rows).toEqual([]);
    expect(result.quarantined).toBe(2);
  });

  it('handles empty and nullish input', () => {
    const logger = makeLogger();
    expect(parseDbRows(RowSchema, [], { source: 'test_rpc', logger })).toEqual({ rows: [], quarantined: 0 });
    expect(parseDbRows(RowSchema, null, { source: 'test_rpc', logger })).toEqual({ rows: [], quarantined: 0 });
    expect(parseDbRows(RowSchema, undefined, { source: 'test_rpc', logger })).toEqual({ rows: [], quarantined: 0 });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('throws on a non-array payload — a broken query contract is not one bad row', () => {
    const logger = makeLogger();
    expect(() => parseDbRows(RowSchema, { id: V4_UUID }, { source: 'test_rpc', logger })).toThrow(
      /expected an array/i,
    );
    expect(() => parseDbRows(RowSchema, 'rows', { source: 'test_rpc', logger })).toThrow(/expected an array/i);
  });
});
