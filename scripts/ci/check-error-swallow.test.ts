import { describe, it, expect } from 'vitest';
import { scanSource, BASELINE } from './check-error-swallow.js';

describe('check-error-swallow (SCRUM-3836)', () => {
  it('flags the exact shape that hid the reorg statement_timeout', () => {
    const src = [
      'const { data: rows, error } = await db.from("anchors").select("id");',
      'if (error || !rows || rows.length === 0) {',
      '  return { checked: 0 };',
      '}',
    ].join('\n');
    const v = scanSource('example.ts', src);
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(2);
  });

  it('accepts a site that logs the failure', () => {
    const src = [
      'if (error || !rows) {',
      '  logger.error({ error }, "query failed");',
      '  return null;',
      '}',
    ].join('\n');
    expect(scanSource('example.ts', src)).toHaveLength(0);
  });

  it('accepts a site that throws — loud is loud', () => {
    const src = [
      'if (error || !data) {',
      '  throw new Error(`failed: ${error?.message}`);',
      '}',
    ].join('\n');
    expect(scanSource('example.ts', src)).toHaveLength(0);
  });

  it('flags a swallow whose log is too far away to be the handler', () => {
    const src = [
      'if (error || !rows) return null;', '', '', '', '', '',
      'logger.error({ error }, "unrelated, six lines later");',
    ].join('\n');
    expect(scanSource('example.ts', src)).toHaveLength(1);
  });

  it('keeps the baseline empty — occurrences are fixed, not grandfathered', () => {
    expect(BASELINE.size).toBe(0);
  });
});
