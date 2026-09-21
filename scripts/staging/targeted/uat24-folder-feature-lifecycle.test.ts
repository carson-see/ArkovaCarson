import { describe, expect, it, vi } from 'vitest';
import { runWithVerifiedCleanup } from './uat24-folder-feature-lifecycle';

describe('UAT24 hosted feature lifecycle', () => {
  it('does not report success when cleanup fails', async () => {
    const verify = vi.fn();
    await expect(runWithVerifiedCleanup(
      async () => ({ result: 'ok' }),
      async () => { throw new Error('restore failed'); },
      verify,
    )).rejects.toThrow('restore failed');
    expect(verify).not.toHaveBeenCalled();
  });

  it('does not report success when cleanup verification fails', async () => {
    await expect(runWithVerifiedCleanup(
      async () => ({ result: 'ok' }),
      async () => undefined,
      async () => { throw new Error('folder remained'); },
    )).rejects.toThrow('folder remained');
  });
});
