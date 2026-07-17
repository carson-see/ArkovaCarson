import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const adapterPath = resolve(
  process.cwd(),
  'scripts/staging/s33-b1-soak-supervisor-production-adapter.ts',
);

describe('RIG-B1 production supervisor teardown composition', () => {
  it('passes only RIG-B1 authority inputs to the canonical teardown script', () => {
    const source = readFileSync(adapterPath, 'utf8');
    const start = source.indexOf('  canonicalTeardown(context: B1SupervisorContext)');
    const end = source.indexOf('\n  }\n}', start);
    const body = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("'--b1-approval-artifact'");
    expect(body).not.toContain("'--runtime-sa'");
    expect(body).not.toContain("'--lease-id'");
  });
});
