import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('.mergify.yml', 'utf8');

describe('merge queue cost cap', () => {
  it('limits concurrent speculative full matrices while retaining serial batches', () => {
    expect(source).toMatch(/^  max_parallel_checks: 2$/m);
    expect(source.match(/^    batch_size: 1$/gm)).toHaveLength(3);
  });
});
