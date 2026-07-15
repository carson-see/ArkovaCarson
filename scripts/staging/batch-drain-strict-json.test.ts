import { describe, expect, it } from 'vitest';

import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';

describe('strict JSON lexical key scanner', () => {
  it.each([
    '{"plain":1,"plain":2}',
    '{"nested":{"key":1,"key":2}}',
    '{"key":1,"k\\u0065y":2}',
    '{"😀":1,"\\uD83D\\uDE00":2}',
  ])('rejects semantically duplicate key bytes before whole-document parsing', (raw) => {
    expect(() => parseJsonRejectingDuplicateKeys(raw, 'capture')).toThrow(/duplicate JSON key/i);
  });

  it('preserves arrays and escaped strings that only resemble keys', () => {
    expect(parseJsonRejectingDuplicateKeys('{"items":["key:","key:"],"other":1}', 'capture')).toEqual({
      items: ['key:', 'key:'],
      other: 1,
    });
  });
});
