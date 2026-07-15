import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeS33Wave2Evidence } from './s33-wave2-batch-acceptance.js';

describe('S3.3 Wave-2 CI evidence writer', () => {
  it('creates one private immutable evidence file', () => {
    const root = mkdtempSync(join(tmpdir(), 's33-w2-evidence-'));
    const output = join(root, 'evidence.json');
    writeS33Wave2Evidence(output, { ok: true });
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ ok: true });
    expect(() => writeS33Wave2Evidence(output, { ok: false })).toThrow();
  });

  it('does not follow an evidence target symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 's33-w2-evidence-'));
    const target = join(root, 'target.json');
    const output = join(root, 'evidence.json');
    symlinkSync(target, output);
    expect(() => writeS33Wave2Evidence(output, { ok: true })).toThrow();
  });
});
