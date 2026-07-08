import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { writeEvidenceFile, bearerHeader } from './runtime';

const scratch = join(tmpdir(), `tsoak-runtime-${process.pid}`);

afterEach(() => {
  if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

describe('runtime: writeEvidenceFile', () => {
  it('writes pretty JSON to the requested path and creates parent dirs', () => {
    const out = join(scratch, 'nested', 'evidence.json');
    const evidence = { driver: 'x', totalRequests: 3 };
    writeEvidenceFile(out, evidence);
    expect(existsSync(out)).toBe(true);
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    expect(parsed.driver).toBe('x');
    expect(parsed.totalRequests).toBe(3);
  });

  it('is a no-op when no path is given (stdout-only run)', () => {
    expect(() => writeEvidenceFile(undefined, { driver: 'x' })).not.toThrow();
  });
});

describe('runtime: bearerHeader', () => {
  it('builds an Authorization: Bearer header from a token', () => {
    expect(bearerHeader('abc.def')).toEqual({ Authorization: 'Bearer abc.def' });
  });
});
