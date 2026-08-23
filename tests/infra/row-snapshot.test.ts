/**
 * BUG-030 (b) / defect E-3 — a spec that deletes seeded rows must put them back.
 *
 * `e2e/identity-entitlement.spec.ts` deletes the seed individual's
 * `subscriptions` row in `beforeEach`, again inside one test body, and once more
 * in `afterAll` — with no restore anywhere. Under CI, which runs against a
 * freshly `db reset` database, that is invisible. Against a long-lived rig (a
 * daily E2E runner is exactly the use this suite is being made portable for) the
 * seed subscription is destroyed permanently by the first run, and every later
 * run — and every OTHER spec that assumes a seeded subscription — is then
 * exercising a database the seed no longer describes.
 *
 * The fix is snapshot-and-restore. The rules that make it trustworthy, each
 * pinned below:
 *
 *   1. NEVER destroy what was not first captured. A failed capture must not
 *      degrade into "restore nothing" — it must stop the suite before the first
 *      delete runs.
 *   2. Restore is exact: the same rows, with their original primary keys, not a
 *      freshly-minted equivalent.
 *   3. Restoring an empty snapshot leaves the table empty for that match — it
 *      must not invent a row.
 *   4. Restore is idempotent, so an `afterAll` that runs after a failed test
 *      cannot double-insert.
 */

import { describe, it, expect, vi } from 'vitest';
import { captureRows, type RowStore } from '../../e2e/helpers/row-snapshot';

interface Row { id: string; user_id: string; status?: string }

/** In-memory stand-in for one table filtered to one match. */
function fakeStore(initial: Row[] = []) {
  let rows = [...initial];
  const calls: string[] = [];
  const store: RowStore<Row> & { current: () => Row[]; calls: string[] } = {
    calls,
    current: () => rows,
    async select() {
      calls.push('select');
      return { data: [...rows], error: null };
    },
    async deleteMatching() {
      calls.push('delete');
      rows = [];
      return { error: null };
    },
    async insert(toInsert) {
      calls.push('insert');
      rows = [...rows, ...toInsert];
      return { error: null };
    },
  };
  return store;
}

describe('captureRows — snapshot', () => {
  it('captures the rows present at capture time', async () => {
    const store = fakeStore([{ id: 'sub-1', user_id: 'u1', status: 'active' }]);
    const snapshot = await captureRows(store, 'subscriptions(u1)');

    expect(snapshot.rows).toEqual([{ id: 'sub-1', user_id: 'u1', status: 'active' }]);
  });

  it('throws at capture time when the read fails — never silently "captured nothing"', async () => {
    // Rule 1. A capture that errors and returns an empty snapshot would make
    // restore a no-op, and the suite would delete the seed row and put nothing
    // back — the exact defect, now wearing a snapshot helper.
    const store = fakeStore();
    store.select = async () => ({ data: null, error: { message: 'permission denied' } });

    await expect(captureRows(store, 'subscriptions(u1)'))
      .rejects.toThrow(/subscriptions\(u1\).*permission denied/s);
  });

  it('is not fooled by a null data payload with no error', async () => {
    const store = fakeStore();
    store.select = async () => ({ data: null, error: null });

    await expect(captureRows(store, 'subscriptions(u1)')).rejects.toThrow(/no rows payload/i);
  });

  it('snapshots a defensive copy — later mutation of the table cannot rewrite history', async () => {
    const seeded: Row[] = [{ id: 'sub-1', user_id: 'u1', status: 'active' }];
    const store = fakeStore(seeded);
    const snapshot = await captureRows(store, 'subscriptions(u1)');

    seeded[0].status = 'canceled';
    expect(snapshot.rows[0].status).toBe('active');
  });
});

describe('captureRows — restore', () => {
  it('puts the exact original row back, primary key included', async () => {
    // Rule 2. A restore that re-created the row with a fresh id would leave any
    // FK reference dangling and quietly change what the seed means.
    const store = fakeStore([{ id: 'sub-1', user_id: 'u1', status: 'active' }]);
    const snapshot = await captureRows(store, 'subscriptions(u1)');

    await store.deleteMatching();
    await store.insert([{ id: 'test-row', user_id: 'u1', status: 'trialing' }]);
    expect(store.current()).toEqual([{ id: 'test-row', user_id: 'u1', status: 'trialing' }]);

    await snapshot.restore();

    expect(store.current()).toEqual([{ id: 'sub-1', user_id: 'u1', status: 'active' }]);
  });

  it('restores nothing when nothing was there, and does not invent a row', async () => {
    // Rule 3. "No subscription" is a legitimate seed state, and the fail-closed
    // test depends on it.
    const store = fakeStore([]);
    const snapshot = await captureRows(store, 'subscriptions(u1)');

    await store.insert([{ id: 'test-row', user_id: 'u1' }]);
    await snapshot.restore();

    expect(store.current()).toEqual([]);
    expect(store.calls.filter((c) => c === 'insert')).toHaveLength(1); // only the test's own
  });

  it('restores multiple captured rows', async () => {
    const store = fakeStore([
      { id: 'ent-1', user_id: 'u1', status: 'open' },
      { id: 'ent-2', user_id: 'u1', status: 'closed' },
    ]);
    const snapshot = await captureRows(store, 'entitlements(u1)');

    await store.deleteMatching();
    await snapshot.restore();

    expect(store.current()).toHaveLength(2);
    expect(store.current().map((r) => r.id).sort()).toEqual(['ent-1', 'ent-2']);
  });

  it('is idempotent — a second restore does not double-insert', async () => {
    // Rule 4. Playwright runs afterAll even when a test failed mid-way, and a
    // retry can enter the hook twice.
    const store = fakeStore([{ id: 'sub-1', user_id: 'u1', status: 'active' }]);
    const snapshot = await captureRows(store, 'subscriptions(u1)');

    await snapshot.restore();
    await snapshot.restore();

    expect(store.current()).toEqual([{ id: 'sub-1', user_id: 'u1', status: 'active' }]);
  });

  it('surfaces a restore failure loudly instead of leaving the rig quietly broken', async () => {
    const store = fakeStore([{ id: 'sub-1', user_id: 'u1' }]);
    const snapshot = await captureRows(store, 'subscriptions(u1)');
    store.insert = async () => ({ error: { message: 'insert blew up' } });

    await expect(snapshot.restore()).rejects.toThrow(/subscriptions\(u1\).*insert blew up/s);
  });

  it('clears the test rows before re-inserting, so restore cannot collide with UNIQUE(user_id)', async () => {
    // `subscriptions` has UNIQUE(user_id): inserting the captured row on top of
    // a live test row would 23505 and abort the restore.
    const store = fakeStore([{ id: 'sub-1', user_id: 'u1', status: 'active' }]);
    const snapshot = await captureRows(store, 'subscriptions(u1)');
    const deleteSpy = vi.spyOn(store, 'deleteMatching');

    await snapshot.restore();

    expect(deleteSpy).toHaveBeenCalled();
    expect(store.calls.indexOf('delete')).toBeLessThan(store.calls.lastIndexOf('insert'));
  });
});
