import { describe, expect, it, vi } from 'vitest';

import { runS33G1PairedStartCliForTest } from './s33-g1-paired-start';
import type { S33G1PairedStartResult } from './s33-g1-paired-start-driver';

const result = {
  status: 'PAIRED_SOAK_STARTED',
  receipt: { receiptId: 'g1-paired-start:approval:soak:lease' },
} as unknown as S33G1PairedStartResult;

describe('S3.3 G1 paired-start CLI', () => {
  it('reads exact admission/approval artifacts and forwards the explicit CTO confirmation without logging secrets', async () => {
    const readText = vi.fn(async (path: string) => path.endsWith('admission.json')
      ? '{"kind":"isolated_rig_admission"}'
      : 'signed-envelope-secret');
    const execute = vi.fn(async () => result);
    await expect(runS33G1PairedStartCliForTest([
      '--admission', '/tmp/admission.json',
      '--approval', '/tmp/approval.envelope',
      '--cto-confirmation', 'START_G1:approval:soak:lease',
    ], { readText, execute })).resolves.toBe(result);
    expect(readText).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      { kind: 'isolated_rig_admission' },
      'signed-envelope-secret',
      'START_G1:approval:soak:lease',
    );
  });

  it('fails before reads on missing authority arguments and rejects duplicate-key admission JSON', async () => {
    const readText = vi.fn<(path: string) => Promise<string>>(async () => '{}');
    const execute = vi.fn(async () => result);
    await expect(runS33G1PairedStartCliForTest([], { readText, execute }))
      .rejects.toThrow(/--admission/i);
    expect(readText).not.toHaveBeenCalled();

    readText.mockImplementation(async (path: string) => path.endsWith('admission.json')
      ? '{"kind":"one","kind":"two"}'
      : 'signed');
    await expect(runS33G1PairedStartCliForTest([
      '--admission', '/tmp/admission.json',
      '--approval', '/tmp/approval.envelope',
      '--cto-confirmation', 'START_G1:approval:soak:lease',
    ], { readText, execute })).rejects.toThrow(/duplicate/i);
    expect(execute).not.toHaveBeenCalled();
  });
});
