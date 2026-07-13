import { describe, expect, it, vi } from 'vitest';

import {
  createGatedLiveCrashControlAdapter,
  parseCrashReplayCapture,
  ReplayCrashControlAdapter,
} from './batch-drain-crash-adapter';

describe('concrete crash capture adapters', () => {
  it('strictly rejects a replay capture with unknown fields', () => {
    expect(() => parseCrashReplayCapture(JSON.stringify({ schemaVersion: 1, invented: true }))).toThrow(
      /unrecognized|unknown/i,
    );
  });

  it('provides a concrete offline replay adapter', () => {
    expect(ReplayCrashControlAdapter).toBeTypeOf('function');
  });

  it('does not invoke real crash actions when its two-part gate is absent', async () => {
    const terminate = vi.fn();
    const adapter = createGatedLiveCrashControlAdapter({ terminate } as never, {});
    await expect(adapter.terminate({} as never)).rejects.toThrow(/not explicitly enabled/);
    expect(terminate).not.toHaveBeenCalled();
  });
});
