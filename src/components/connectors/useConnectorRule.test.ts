/**
 * useConnectorRule — D4/D5 adopt-vs-create + action_type pairing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const workerFetch = vi.fn();
vi.mock('@/lib/workerClient', () => ({
  workerFetch: (...args: unknown[]) => workerFetch(...args),
}));

import { useConnectorRule } from './useConnectorRule';

const ORG_ID = 'org-1';

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  workerFetch.mockReset();
});

describe('useConnectorRule — load (D5 adopt-vs-create counting)', () => {
  it('reports status "none" when zero enabled rules of this trigger_type exist, and never writes on mount', async () => {
    workerFetch.mockResolvedValueOnce(jsonRes(200, { items: [] }));

    const { result } = renderHook(() => useConnectorRule(ORG_ID, 'google_drive'));
    await waitFor(() => expect(result.current.state.status).toBe('none'));

    expect(workerFetch).toHaveBeenCalledTimes(1);
    expect(workerFetch).toHaveBeenCalledWith('/api/rules', { method: 'GET' });
  });

  it('reports status "adoptable" with the rule detail when exactly one enabled match exists', async () => {
    workerFetch.mockResolvedValueOnce(
      jsonRes(200, { items: [{ id: 'rule-1', trigger_type: 'WORKSPACE_FILE_MODIFIED', enabled: true }] }),
    );
    workerFetch.mockResolvedValueOnce(
      jsonRes(200, {
        item: {
          id: 'rule-1',
          trigger_type: 'WORKSPACE_FILE_MODIFIED',
          trigger_config: { drive_folders: [] },
          action_type: 'AUTO_ANCHOR',
          action_config: { tag: 'connector-google_drive' },
          enabled: true,
        },
      }),
    );

    const { result } = renderHook(() => useConnectorRule(ORG_ID, 'google_drive'));
    await waitFor(() => expect(result.current.state.status).toBe('adoptable'));
    expect(result.current.state.status === 'adoptable' && result.current.state.rule.id).toBe('rule-1');
  });

  it('reports status "managed" (read-only) when two or more enabled matches exist', async () => {
    workerFetch.mockResolvedValueOnce(
      jsonRes(200, {
        items: [
          { id: 'rule-1', trigger_type: 'WORKSPACE_FILE_MODIFIED', enabled: true },
          { id: 'rule-2', trigger_type: 'WORKSPACE_FILE_MODIFIED', enabled: true },
        ],
      }),
    );
    workerFetch.mockResolvedValueOnce(
      jsonRes(200, {
        item: {
          id: 'rule-1',
          trigger_type: 'WORKSPACE_FILE_MODIFIED',
          trigger_config: {},
          action_type: 'AUTO_ANCHOR',
          action_config: {},
          enabled: true,
        },
      }),
    );

    const { result } = renderHook(() => useConnectorRule(ORG_ID, 'google_drive'));
    await waitFor(() => expect(result.current.state.status).toBe('managed'));
    expect(result.current.state.status === 'managed' && result.current.state.count).toBe(2);
  });

  it('ignores disabled rules and rules of a different trigger_type when counting', async () => {
    workerFetch.mockResolvedValueOnce(
      jsonRes(200, {
        items: [
          { id: 'rule-disabled', trigger_type: 'WORKSPACE_FILE_MODIFIED', enabled: false },
          { id: 'rule-other-type', trigger_type: 'ESIGN_COMPLETED', enabled: true },
        ],
      }),
    );

    const { result } = renderHook(() => useConnectorRule(ORG_ID, 'google_drive'));
    await waitFor(() => expect(result.current.state.status).toBe('none'));
  });
});

describe('useConnectorRule — save (create path)', () => {
  it('creates then enables, in that order, with paired action_type/action_config (SEC-02 + D4)', async () => {
    workerFetch.mockResolvedValueOnce(jsonRes(200, { items: [] })); // load
    const { result } = renderHook(() => useConnectorRule(ORG_ID, 'google_drive'));
    await waitFor(() => expect(result.current.state.status).toBe('none'));

    workerFetch.mockResolvedValueOnce(jsonRes(201, { id: 'new-rule-1' })); // POST
    workerFetch.mockResolvedValueOnce(jsonRes(200, { ok: true })); // PATCH enable
    workerFetch.mockResolvedValueOnce(jsonRes(200, { items: [{ id: 'new-rule-1', trigger_type: 'WORKSPACE_FILE_MODIFIED', enabled: true }] })); // reload
    workerFetch.mockResolvedValueOnce(
      jsonRes(200, {
        item: {
          id: 'new-rule-1',
          trigger_type: 'WORKSPACE_FILE_MODIFIED',
          trigger_config: { drive_folders: [{ type: 'drive_folder', folder_id: 'f1', folder_name: 'Contracts' }] },
          action_type: 'INSTANT_SECURE',
          action_config: { tag: 'connector-google_drive' },
          enabled: true,
        },
      }),
    ); // reload detail

    let ok = false;
    await act(async () => {
      ok = await result.current.save({
        name: 'Google Drive',
        triggerConfig: { drive_folders: [{ type: 'drive_folder', folder_id: 'f1', folder_name: 'Contracts' }] },
        actionType: 'INSTANT_SECURE',
      });
    });

    expect(ok).toBe(true);
    const postCall = workerFetch.mock.calls[1];
    expect(postCall[0]).toBe('/api/rules');
    const postBody = JSON.parse(postCall[1].body);
    expect(postBody.action_type).toBe('INSTANT_SECURE');
    expect(postBody.action_config).toEqual({ tag: 'connector-google_drive' });
    expect(postBody.enabled).toBe(false);

    const patchCall = workerFetch.mock.calls[2];
    expect(patchCall[0]).toBe('/api/rules/new-rule-1');
    expect(JSON.parse(patchCall[1].body)).toEqual({ enabled: true });
  });

  it('adopts the winning rule on a 409 rule_exists race instead of surfacing an error', async () => {
    workerFetch.mockResolvedValueOnce(jsonRes(200, { items: [] })); // load: 0 at page-load time
    const { result } = renderHook(() => useConnectorRule(ORG_ID, 'google_drive'));
    await waitFor(() => expect(result.current.state.status).toBe('none'));

    workerFetch.mockResolvedValueOnce(
      jsonRes(409, { error: { code: 'rule_exists', existing_rule_id: 'seeded-rule' } }),
    ); // POST races and loses
    workerFetch.mockResolvedValueOnce(jsonRes(200, { ok: true })); // PATCH adopt
    workerFetch.mockResolvedValueOnce(jsonRes(200, { items: [{ id: 'seeded-rule', trigger_type: 'WORKSPACE_FILE_MODIFIED', enabled: true }] })); // reload
    workerFetch.mockResolvedValueOnce(
      jsonRes(200, {
        item: {
          id: 'seeded-rule',
          trigger_type: 'WORKSPACE_FILE_MODIFIED',
          trigger_config: {},
          action_type: 'INSTANT_SECURE',
          action_config: { tag: 'connector-google_drive' },
          enabled: true,
        },
      }),
    );

    let ok = false;
    await act(async () => {
      ok = await result.current.save({ name: 'Google Drive', triggerConfig: {}, actionType: 'INSTANT_SECURE' });
    });

    expect(ok).toBe(true);
    const patchCall = workerFetch.mock.calls[2];
    expect(patchCall[0]).toBe('/api/rules/seeded-rule');
    const patchBody = JSON.parse(patchCall[1].body);
    expect(patchBody.action_type).toBe('INSTANT_SECURE');
    expect(patchBody.action_config).toEqual({ tag: 'connector-google_drive' });
  });

  it('adopts the winning rule on a 409 rule_exists race that lands on the enable step (second gap, CTO pre-mortem 2026-09-13)', async () => {
    // Unlike the previous test, the create POST itself wins cleanly — the
    // seeder lands in the SECOND gap, between create (disabled) and the
    // follow-up enable PATCH.
    workerFetch.mockResolvedValueOnce(jsonRes(200, { items: [] })); // load: 0 at page-load time
    const { result } = renderHook(() => useConnectorRule(ORG_ID, 'google_drive'));
    await waitFor(() => expect(result.current.state.status).toBe('none'));

    workerFetch.mockResolvedValueOnce(jsonRes(201, { id: 'my-new-rule' })); // POST creates cleanly
    workerFetch.mockResolvedValueOnce(
      jsonRes(409, { error: { code: 'rule_exists', existing_rule_id: 'seeded-rule' } }),
    ); // PATCH enable races and loses
    workerFetch.mockResolvedValueOnce(jsonRes(200, { ok: true })); // PATCH adopt the winner
    workerFetch.mockResolvedValueOnce(jsonRes(200, { items: [{ id: 'seeded-rule', trigger_type: 'WORKSPACE_FILE_MODIFIED', enabled: true }] })); // reload
    workerFetch.mockResolvedValueOnce(
      jsonRes(200, {
        item: {
          id: 'seeded-rule',
          trigger_type: 'WORKSPACE_FILE_MODIFIED',
          trigger_config: {},
          action_type: 'INSTANT_SECURE',
          action_config: { tag: 'connector-google_drive' },
          enabled: true,
        },
      }),
    );

    let ok = false;
    await act(async () => {
      ok = await result.current.save({ name: 'Google Drive', triggerConfig: {}, actionType: 'INSTANT_SECURE' });
    });

    expect(ok).toBe(true);
    // My own just-created (disabled) rule is left behind, never adopted.
    const patchCall = workerFetch.mock.calls[3];
    expect(patchCall[0]).toBe('/api/rules/seeded-rule');
    const patchBody = JSON.parse(patchCall[1].body);
    expect(patchBody.action_type).toBe('INSTANT_SECURE');
    expect(patchBody.action_config).toEqual({ tag: 'connector-google_drive' });
  });
});

describe('useConnectorRule — save (adopt path)', () => {
  it('PATCHes the adopted rule with trigger_config + PAIRED action_type/action_config in one call', async () => {
    workerFetch.mockResolvedValueOnce(
      jsonRes(200, { items: [{ id: 'rule-1', trigger_type: 'WORKSPACE_FILE_MODIFIED', enabled: true }] }),
    );
    workerFetch.mockResolvedValueOnce(
      jsonRes(200, {
        item: {
          id: 'rule-1',
          trigger_type: 'WORKSPACE_FILE_MODIFIED',
          trigger_config: {},
          action_type: 'AUTO_ANCHOR',
          action_config: { tag: 'connector-google_drive' },
          enabled: true,
        },
      }),
    );
    const { result } = renderHook(() => useConnectorRule(ORG_ID, 'google_drive'));
    await waitFor(() => expect(result.current.state.status).toBe('adoptable'));

    workerFetch.mockResolvedValueOnce(jsonRes(200, { ok: true })); // PATCH
    workerFetch.mockResolvedValueOnce(
      jsonRes(200, { items: [{ id: 'rule-1', trigger_type: 'WORKSPACE_FILE_MODIFIED', enabled: true }] }),
    ); // reload
    workerFetch.mockResolvedValueOnce(
      jsonRes(200, {
        item: {
          id: 'rule-1',
          trigger_type: 'WORKSPACE_FILE_MODIFIED',
          trigger_config: { drive_folders: [] },
          action_type: 'INSTANT_SECURE',
          action_config: { tag: 'connector-google_drive' },
          enabled: true,
        },
      }),
    );

    await act(async () => {
      await result.current.save({ name: 'ignored', triggerConfig: { drive_folders: [] }, actionType: 'INSTANT_SECURE' });
    });

    const patchCall = workerFetch.mock.calls[2];
    expect(patchCall[0]).toBe('/api/rules/rule-1');
    expect(patchCall[1].method).toBe('PATCH');
    const patchBody = JSON.parse(patchCall[1].body);
    expect(patchBody).toEqual({
      trigger_config: { drive_folders: [] },
      action_type: 'INSTANT_SECURE',
      action_config: { tag: 'connector-google_drive' },
    });
  });
});
