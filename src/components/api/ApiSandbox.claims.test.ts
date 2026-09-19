import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'ApiSandbox.tsx'),
  'utf8',
);

describe('API Sandbox published capabilities', () => {
  it('does not offer the permanently disabled Nessie endpoint', () => {
    expect(source).not.toContain('/api/v1/nessie/query');
    expect(source).not.toContain("id: 'nessie'");
  });

  it('states that the sandbox is a curated endpoint set', () => {
    expect(source).toContain('curated set of API endpoints');
  });
});
