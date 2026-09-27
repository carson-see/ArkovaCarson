import { describe, expect, it, vi } from 'vitest';
import {
  DriveFolderReconciliationError, driveFolderReconciliationPage, runDriveFolderReconciliation,
  type DriveFolderRuleCandidate,
} from './drive-folder-reconciliation.js';

const driveRule = (overrides: Partial<DriveFolderRuleCandidate> = {}): DriveFolderRuleCandidate => ({
  id: '00000000-0000-4000-8000-000000000001',
  org_id: '00000000-0000-4000-8000-000000000010',
  created_by_user_id: '00000000-0000-4000-8000-000000000020',
  trigger_config: { drive_folders: [{ type: 'drive_folder', folder_id: 'drive-folder-a', folder_name: 'Evidence' }] },
  action_config: { tag: 'connector-google_drive' },
  ...overrides,
});
const current = async (candidate: DriveFolderRuleCandidate) => candidate;

describe('driveFolderReconciliationPage', () => {
  it('bounds and rotates pages', () => {
    expect(driveFolderReconciliationPage(250, new Date(3_600_000))).toEqual({ page: 1, pages: 3 });
    expect(driveFolderReconciliationPage(0, new Date(0))).toEqual({ page: 0, pages: 1 });
  });
});

describe('runDriveFolderReconciliation', () => {
  it('queries only enabled workspace rules in stable id order', async () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    chain.select = vi.fn(() => chain); chain.eq = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.range = vi.fn(async () => ({ data: [], count: 0, error: null }));
    const from = vi.fn(() => chain);
    await runDriveFolderReconciliation({ db: { from } as never, now: () => new Date(0) });
    expect(from).toHaveBeenCalledWith('organization_rules');
    expect(chain.eq).toHaveBeenNthCalledWith(1, 'enabled', true);
    expect(chain.eq).toHaveBeenNthCalledWith(2, 'trigger_type', 'WORKSPACE_FILE_MODIFIED');
    expect(chain.order).toHaveBeenCalledWith('id', { ascending: true });
    expect(chain.range).toHaveBeenCalledWith(0, 99);
  });

  it('throws with partial counters after a transient error, then later retries without save/artifact idempotently', async () => {
    const persisted = new Set<string>(); let transient = true;
    const mirror = vi.fn(async (_deps, args) => args.folders.map((folder: { folderId: string }) => {
      if (transient) return { folderId: '', driveFolderId: folder.folderId, outcome: 'error' as const, error: 'db reset' };
      const key = `${args.orgId}:${folder.folderId}`; const existed = persisted.has(key); persisted.add(key);
      return { folderId: key, driveFolderId: folder.folderId, outcome: existed ? 'existing' as const : 'created' as const };
    }));
    const deps = {
      db: {} as never, listCandidates: async () => ({ rows: [driveRule()], count: 1 }),
      readCurrentRule: current, mirror, now: () => new Date(0),
    };
    const failed = await runDriveFolderReconciliation(deps).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(DriveFolderReconciliationError);
    expect((failed as DriveFolderReconciliationError).summary).toMatchObject({ errored: 1, scanned: 1 });
    transient = false;
    expect((await runDriveFolderReconciliation(deps)).created).toBe(1);
    expect((await runDriveFolderReconciliation(deps)).existing).toBe(1);
    expect(persisted.size).toBe(1);
  });

  it('re-reads candidates and suppresses deleted/disabled or removed selections before writes', async () => {
    const candidates = [driveRule({ id: 'deleted' }), driveRule({ id: 'removed' }), driveRule({ id: 'current', org_id: 'org-current' })];
    const mirror = vi.fn(async (_deps: unknown, _args: { orgId: string }) => [
      { folderId: 'f', driveFolderId: 'drive-folder-a', outcome: 'existing' as const },
    ]);
    const readCurrentRule = vi.fn(async (candidate: DriveFolderRuleCandidate) => {
      if (candidate.id === 'deleted') return null;
      if (candidate.id === 'removed') return driveRule({ ...candidate, trigger_config: { drive_folders: [] } });
      return candidate;
    });
    const result = await runDriveFolderReconciliation({
      db: {} as never, listCandidates: async () => ({ rows: candidates, count: 3 }),
      readCurrentRule, mirror, now: () => new Date(0),
    });
    expect(readCurrentRule).toHaveBeenCalledTimes(3);
    expect(mirror).toHaveBeenCalledTimes(1);
    expect(mirror.mock.calls[0]?.[1]).toMatchObject({ orgId: 'org-current' });
    expect(result).toMatchObject({ scanned: 3, eligible: 1, existing: 1 });
  });

  it('rejects malformed/over-cap persisted JSON without partially mirroring it', async () => {
    const overCap = driveRule({ trigger_config: {
      drive_folders: [1, 2, 3, 4].map((n) => ({ type: 'drive_folder', folder_id: `folder-${n}` })),
    } });
    const mirror = vi.fn();
    const error = await runDriveFolderReconciliation({
      db: {} as never, listCandidates: async () => ({ rows: [overCap], count: 1 }),
      readCurrentRule: current, mirror, now: () => new Date(0),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DriveFolderReconciliationError);
    expect((error as DriveFolderReconciliationError).summary).toMatchObject({ invalid: 1, errored: 1 });
    expect(mirror).not.toHaveBeenCalled();
  });

  it('rejects three array selections plus a distinct valid legacy binding as four total folders', async () => {
    const mixed = driveRule({ trigger_config: {
      type: 'drive_folder', folder_id: 'legacy',
      drive_folders: [1, 2, 3].map((n) => ({ type: 'drive_folder', folder_id: `folder-${n}` })),
    } });
    const mirror = vi.fn();
    const error = await runDriveFolderReconciliation({
      db: {} as never, listCandidates: async () => ({ rows: [mixed], count: 1 }),
      readCurrentRule: current, mirror, now: () => new Date(0),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DriveFolderReconciliationError);
    expect((error as DriveFolderReconciliationError).summary).toMatchObject({ invalid: 1, errored: 1 });
    expect(mirror).not.toHaveBeenCalled();
  });

  it('keeps a null-creator rule visibly non-green as needs_admin_repair without attempting an impossible mirror', async () => {
    const mirror = vi.fn();
    const error = await runDriveFolderReconciliation({
      db: {} as never, listCandidates: async () => ({ rows: [driveRule({ created_by_user_id: null })], count: 1 }),
      readCurrentRule: current, mirror, now: () => new Date(0),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DriveFolderReconciliationError);
    expect((error as DriveFolderReconciliationError).summary).toMatchObject({ needsAdminRepair: 1, errored: 1 });
    expect(mirror).not.toHaveBeenCalled();
  });

  it('stops cooperatively before another rule when the total-run deadline is reached', async () => {
    const mirror = vi.fn();
    const error = await runDriveFolderReconciliation({
      db: {} as never, listCandidates: async () => ({ rows: [driveRule(), driveRule({ id: '2' })], count: 2 }),
      readCurrentRule: current, mirror, now: () => new Date(0), monotonicNowMs: () => 10, deadlineAtMs: 10,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DriveFolderReconciliationError);
    expect((error as DriveFolderReconciliationError).summary).toMatchObject({
      scanned: 0, errored: 0, deadlineExceeded: true,
    });
    expect(mirror).not.toHaveBeenCalled();
  });

  it('does not start mirror writes when the authoritative reread consumes the remaining budget', async () => {
    const mirror = vi.fn();
    const clock = vi.fn()
      .mockReturnValueOnce(0) // before initial scan
      .mockReturnValueOnce(0) // after scan
      .mockReturnValueOnce(0) // before candidate reread
      .mockReturnValue(10); // after reread, before mirror
    const error = await runDriveFolderReconciliation({
      db: {} as never,
      listCandidates: async () => ({ rows: [driveRule(), driveRule({ id: '2' })], count: 2 }),
      readCurrentRule: current, mirror, now: () => new Date(0), monotonicNowMs: clock, deadlineAtMs: 10,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DriveFolderReconciliationError);
    expect((error as DriveFolderReconciliationError).summary).toMatchObject({
      scanned: 1, errored: 2, deadlineExceeded: true,
    });
    expect(mirror).not.toHaveBeenCalled();
  });

  it('fetches only the rotating bounded page and reports population', async () => {
    const listCandidates = vi.fn(async ({ page }: { page: number }) => ({
      rows: page === 1 ? [driveRule({ id: 'page-1' })] : [], count: 250,
    }));
    const result = await runDriveFolderReconciliation({
      db: {} as never, listCandidates, readCurrentRule: current,
      mirror: vi.fn(async () => [{ folderId: 'f', driveFolderId: 'drive-folder-a', outcome: 'existing' as const }]),
      now: () => new Date(3_600_000),
    });
    expect(listCandidates.mock.calls).toEqual([[{ page: 0, pageSize: 100 }], [{ page: 1, pageSize: 100 }]]);
    expect(result).toMatchObject({ candidates: 250, page: 1, pages: 3, scanned: 1 });
  });
});
