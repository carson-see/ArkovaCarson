import { describe, expect, it } from 'vitest';

import { formatS33RigRError } from './s33-rig-r-release-cli';

describe('RIG-R durable error reporting', () => {
  it('renders every AggregateError entry and recursive cause', () => {
    const refresh = new Error('session refresh failed', {
      cause: new Error('HTTP 504 from auth endpoint'),
    });
    const teardown = new AggregateError([
      new Error('Supabase cleanup failed'),
      new Error('lease release failed'),
    ], 'ordered compensation failed');
    const output = formatS33RigRError(new AggregateError(
      [refresh, teardown],
      'release and compensation failed',
    ));

    expect(output).toContain('AggregateError: release and compensation failed');
    expect(output).toContain('Error: session refresh failed');
    expect(output).toContain('cause: Error: HTTP 504 from auth endpoint');
    expect(output).toContain('AggregateError: ordered compensation failed');
    expect(output).toContain('Error: Supabase cleanup failed');
    expect(output).toContain('Error: lease release failed');
  });
});
