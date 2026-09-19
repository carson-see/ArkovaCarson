#!/usr/bin/env npx tsx
/** SCRUM-5142 bounded full-schema driver for the reserved UAT-17 rig. */
import { randomUUID } from 'node:crypto';
import { runWithVerifiedCleanup } from './uat24-folder-feature-lifecycle';

const EXPECTED_REF = 'vaarxclqdxnwoxziolmp';
const VERIFIED_SUPABASE_ORIGIN = `https://${EXPECTED_REF}.supabase.co`;
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const baseUrl = required('STAGING_SUPABASE_URL').replace(/\/$/, '');
const serviceKey = required('STAGING_SUPABASE_SERVICE_ROLE_KEY');
const actorUserId = required('UAT24_ACTOR_USER_ID');
const orgId = required('UAT24_ORG_ID');
const anchorId = required('UAT24_UNFILED_ANCHOR_ID');
const connectionId = required('UAT24_CONNECTOR_CONNECTION_ID');
const provider = process.env.UAT24_CONNECTOR_PROVIDER?.trim() || 'google_drive';
const hostname = new URL(baseUrl).hostname;
assert(baseUrl === VERIFIED_SUPABASE_ORIGIN && hostname === `${EXPECTED_REF}.supabase.co`,
  `refusing non-UAT24 rig target ${baseUrl}`);
assert(provider === 'google_drive' || provider === 'docusign', 'unsupported connector provider');

const headers = { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' };
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${VERIFIED_SUPABASE_ORIGIN}/rest/v1/${path}`, {
    ...init, headers: { ...headers, ...(init.headers ?? {}) }, redirect: 'error',
  });
  const body = await response.text();
  if (!response.ok) {
    let code = 'unknown_error';
    try { code = String((JSON.parse(body) as { code?: unknown }).code ?? code).slice(0, 80); } catch { /* bounded */ }
    throw new Error(`${path} returned ${response.status} (${code})`);
  }
  return (body ? JSON.parse(body) : null) as T;
}
async function expectFailure(path: string, body: Record<string, unknown>, pattern: RegExp): Promise<void> {
  const response = await fetch(`${VERIFIED_SUPABASE_ORIGIN}/rest/v1/${path}`, {
    method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
  });
  const text = await response.text();
  assert(!response.ok, `${path} unexpectedly succeeded`);
  let code = 'unknown_error';
  try { code = String((JSON.parse(text) as { code?: unknown }).code ?? code).slice(0, 80); } catch { /* bounded */ }
  assert(pattern.test(text), `${path} failed unexpectedly (${response.status}, ${code})`);
}

type Folder = {
  id: string; owner_scope: 'USER' | 'ORG'; user_id: string | null; org_id: string | null;
  context_org_id: string | null; parent_folder_id: string | null;
  connector_provider: string | null; connector_source_id: string | null;
};
type MoveResult = { moved: string[]; failed: Array<{ anchor_id: string; code: string }> };
const createdFolderIds: string[] = [];
const runId = randomUUID().replaceAll('-', '').slice(0, 16);
const rpc = <T>(name: string, body: Record<string, unknown>) => request<T>(`rpc/${name}`, {
  method: 'POST', body: JSON.stringify(body),
});

async function createFolder(scope: 'USER' | 'ORG', name: string, parent: string | null): Promise<Folder> {
  const folder = await rpc<Folder>('folder_api_create', {
    p_actor_user_id: actorUserId, p_api_key_id: null, p_api_org_id: null, p_owner_scope: scope,
    p_owner_user_id: scope === 'USER' ? actorUserId : null, p_org_id: scope === 'ORG' ? orgId : null,
    p_context_org_id: scope === 'USER' ? orgId : null, p_name: name, p_parent_folder_id: parent,
  });
  createdFolderIds.push(folder.id);
  return folder;
}

async function updateConnector(folderId: string, sourceId: string | null): Promise<Folder> {
  return rpc<Folder>('folder_api_update', {
    p_actor_user_id: actorUserId, p_api_org_id: null, p_folder_id: folderId,
    p_name: null, p_name_present: false, p_parent_folder_id: null, p_parent_present: false,
    p_connector_provider: sourceId ? provider : null, p_connector_source_id: sourceId,
    p_connector_connection_id: sourceId ? connectionId : null, p_connector_present: true,
  });
}

async function main(): Promise<Record<string, unknown>> {
  const anchors = await request<Array<{ user_id: string; org_id: string; folder_id: string | null }>>(
    `anchors?select=user_id,org_id,folder_id&id=eq.${encodeURIComponent(anchorId)}&limit=1`,
  );
  assert(anchors.length === 1, 'fixture anchor does not exist');
  assert(anchors[0].user_id === actorUserId && anchors[0].org_id === orgId, 'fixture anchor ownership mismatch');
  assert(anchors[0].folder_id === null, 'fixture anchor must start unfiled so cleanup restores NULL safely');

  const root = await createFolder('ORG', `uat24-${runId}-root`, null);
  const child = await createFolder('ORG', `uat24-${runId}-child`, root.id);
  const personal = await createFolder('USER', `uat24-${runId}-personal`, null);
  assert(root.owner_scope === 'ORG' && root.org_id === orgId, 'org folder ownership mismatch');
  assert(child.parent_folder_id === root.id, 'nested folder parent mismatch');
  assert(personal.owner_scope === 'USER' && personal.user_id === actorUserId && personal.context_org_id === orgId,
    'contextual personal folder ownership mismatch');

  await expectFailure('rpc/folder_api_update', {
    p_actor_user_id: actorUserId, p_api_org_id: null, p_folder_id: root.id,
    p_name: null, p_name_present: false, p_parent_folder_id: child.id, p_parent_present: true,
    p_connector_provider: null, p_connector_source_id: null, p_connector_connection_id: null,
    p_connector_present: false,
  }, /folder hierarchy cycle/i);

  const moved = await rpc<MoveResult>('folder_api_bulk_move', {
    p_actor_user_id: actorUserId, p_api_org_id: null,
    p_anchor_ids: [anchorId, randomUUID()], p_folder_id: child.id,
  });
  assert(moved.moved.includes(anchorId), 'owned anchor was not moved');
  assert(moved.failed.length === 1 && moved.failed[0].code === 'not_authorized_or_not_found',
    'bulk partial-failure contract mismatch');

  const sourceId = `uat24-${runId}`;
  const bound = await updateConnector(child.id, sourceId);
  assert(bound.connector_provider === provider && bound.connector_source_id === sourceId,
    'connector binding did not persist');
  await updateConnector(child.id, null);
  return { result: 'uat24-hosted-feature-ok', projectRef: EXPECTED_REF,
    orgFolder: true, contextualPersonalFolder: true, nestedCycleDenied: true,
    bulkMoved: 1, bulkFailed: 1, connectorBoundAndCleared: true };
}

async function cleanup(): Promise<void> {
  const errors: string[] = [];
  try {
    const restored = await rpc<MoveResult>('folder_api_bulk_move', {
      p_actor_user_id: actorUserId, p_api_org_id: null, p_anchor_ids: [anchorId], p_folder_id: null,
    });
    if (!restored.moved.includes(anchorId)) errors.push('anchor_restore_not_moved');
  } catch { errors.push('anchor_restore_failed'); }
  for (const folderId of [...createdFolderIds].reverse()) {
    try {
      const deleted = await rpc<Folder | null>('folder_api_delete', {
        p_actor_user_id: actorUserId, p_api_org_id: null, p_folder_id: folderId,
      });
      if (!deleted?.id) errors.push(`folder_delete_empty:${folderId}`);
    } catch { errors.push(`folder_delete_failed:${folderId}`); }
  }
  if (errors.length) throw new Error(`cleanup failed (${errors.join(',')})`);
}

async function verifyCleanup(): Promise<void> {
  const anchors = await request<Array<{ folder_id: string | null }>>(
    `anchors?select=folder_id&id=eq.${encodeURIComponent(anchorId)}&limit=1`,
  );
  assert(anchors.length === 1 && anchors[0].folder_id === null, 'cleanup verification: anchor is not unfiled');
  if (createdFolderIds.length) {
    const encodedIds = createdFolderIds.map(encodeURIComponent).join(',');
    const folders = await request<Array<{ id: string }>>(`folders?select=id&id=in.(${encodedIds})`);
    assert(folders.length === 0, 'cleanup verification: created folders remain');
  }
}

runWithVerifiedCleanup(main, cleanup, verifyCleanup).then((result) => {
  console.log(JSON.stringify(result));
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
