import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveEvidenceOutputPath } from './evidence-path.js';

describe('resolveEvidenceOutputPath', () => {
  it('accepts evidence paths under docs/staging', () => {
    expect(resolveEvidenceOutputPath('docs/staging/ai-soak-pr1413.json')).toBe(
      resolve(process.cwd(), 'docs/staging/ai-soak-pr1413.json'),
    );
  });

  it('rejects path traversal outside docs/staging', () => {
    expect(() => resolveEvidenceOutputPath('docs/staging/../../package.json')).toThrow(/docs\/staging/);
    expect(() => resolveEvidenceOutputPath('/tmp/ai-soak.json')).toThrow(/docs\/staging/);
  });
});
