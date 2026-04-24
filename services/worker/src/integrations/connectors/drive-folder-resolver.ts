/**
 * Google Drive folder-path resolver (SCRUM-1169)
 *
 * Closes the CIBA-HARDEN-05 deferral in `adapters.ts`: Drive's change
 * notifications only carry opaque parent IDs, so the canonical event's
 * `folder_path` field was hardcoded to `null`, silently breaking rules
 * like `folder_path_starts_with: "/HR/"`. This resolver walks the parent
 * chain using the connected org's Drive credentials and returns a human
 * path like `/HR/2026-Q2/candidate-notes.pdf`.
 *
 * Design:
 *   - One `files.get` per parent, bounded by a 20-level depth cap.
 *   - Per-org cache (TTL 15 min) in `drive_folder_path_cache` keyed by
 *     (org_id, file_id). Renames propagate within the TTL.
 *   - Shared-drive root resolves to `/<drive name>/...` via `drives.get`.
 *   - Any failure along the chain returns `null`; the rule simply does
 *     not fire on `folder_path`. Never throws a poison event.
 *
 * Constitution refs:
 *   - 1.7: pure async function taking a fetch + DB; trivially mocked.
 */
import { getFileMetadata, getSharedDriveName, DriveApiError } from '../oauth/drive.js';

const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_DEPTH = 20;

export interface FolderPathCacheStore {
  get(args: { orgId: string; fileId: string }): Promise<{ folder_path: string | null; cached_at: string } | null>;
  put(args: { orgId: string; fileId: string; folderPath: string | null }): Promise<void>;
}

export interface DriveFolderResolverDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * Resolve a Drive file's full human-readable path, e.g. `/HR/2026-Q2/file.pdf`.
 * Returns `null` if any step of the chain fails — callers should treat `null`
 * as "path-based rules cannot match on this event" and skip accordingly.
 */
export async function resolveDriveFolderPath(args: {
  orgId: string;
  fileId: string;
  accessToken: string;
  cache: FolderPathCacheStore;
  deps?: DriveFolderResolverDeps;
}): Promise<string | null> {
  const now = args.deps?.now ?? (() => new Date());

  // Cache hit?
  const cached = await args.cache.get({ orgId: args.orgId, fileId: args.fileId });
  if (cached) {
    const age = now().getTime() - new Date(cached.cached_at).getTime();
    if (age < CACHE_TTL_MS) {
      return cached.folder_path;
    }
  }

  try {
    const path = await walkChain({
      orgId: args.orgId,
      fileId: args.fileId,
      accessToken: args.accessToken,
      fetchImpl: args.deps?.fetchImpl,
    });
    await args.cache.put({ orgId: args.orgId, fileId: args.fileId, folderPath: path });
    return path;
  } catch (err) {
    // Permission loss, deleted parent, network — resolver is best-effort.
    // Cache the `null` briefly to avoid stampeding the Drive API.
    if (err instanceof DriveApiError) {
      await args.cache.put({ orgId: args.orgId, fileId: args.fileId, folderPath: null });
    }
    return null;
  }
}

async function walkChain(args: {
  orgId: string;
  fileId: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const segments: string[] = [];
  let currentId: string | undefined = args.fileId;
  let depth = 0;
  let rootDriveId: string | undefined;

  while (currentId && depth < MAX_DEPTH) {
    const meta = await getFileMetadata({
      fileId: currentId,
      accessToken: args.accessToken,
      deps: { fetchImpl: args.fetchImpl },
    });
    segments.unshift(meta.name);
    rootDriveId = meta.driveId ?? rootDriveId;
    currentId = meta.parents[0];
    depth++;
  }

  // If we hit MAX_DEPTH, we intentionally do NOT label this as failure —
  // return what we have (a deeply-nested path). Conservative.
  if (rootDriveId) {
    const sharedName = await getSharedDriveName({
      driveId: rootDriveId,
      accessToken: args.accessToken,
      deps: { fetchImpl: args.fetchImpl },
    });
    return `/${sharedName}/${segments.join('/')}`;
  }
  return `/${segments.join('/')}`;
}
