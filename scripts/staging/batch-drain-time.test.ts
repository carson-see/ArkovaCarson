import { describe, expect, it } from 'vitest';

import { parseUtcTimestamp, strictUtcTimestampSchema } from './batch-drain-time';

describe('strict UTC chronology contract', () => {
  it.each([
    '2026-07-13T12:00:00Z',
    '2026-07-13T12:00:00.000Z',
    '2026-07-13T12:00:00.123Z',
  ])('accepts canonical RFC3339 UTC timestamp %s', (value) => {
    expect(strictUtcTimestampSchema.safeParse(value).success).toBe(true);
    expect(parseUtcTimestamp(value, 'timestamp')).toBe(Date.parse(value));
  });

  it.each([
    '2026-07-13T12:00:00',
    '2026-07-13T08:00:00-04:00',
    'July 13, 2026 12:00:00',
    '2026-02-30T12:00:00.000Z',
    '2026-07-13t12:00:00.000z',
    '2026-07-13T12:00:00.1234Z',
  ])('rejects non-canonical or non-UTC timestamp %s', (value) => {
    expect(strictUtcTimestampSchema.safeParse(value).success).toBe(false);
    expect(() => parseUtcTimestamp(value, 'timestamp')).toThrow(/RFC3339 UTC/i);
  });
});
