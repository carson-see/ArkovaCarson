import { createHash, timingSafeEqual } from 'node:crypto';

import { getGcpAccessToken } from '../../utils/gcp-auth.js';
import { logger as defaultLogger } from '../../utils/logger.js';

export interface DocusignRefreshTokenStore {
  put(args: { name: string; value: string }): Promise<void>;
  get(args: { name: string }): Promise<string | null>;
  delete(args: { name: string }): Promise<void>;
}

/**
 * Version retention for a refresh-token secret (BUG 2026-09-05, arkova1).
 *
 * DocuSign rotates the refresh token on EVERY refresh, and the hourly
 * connect-failures poll (:00) and listener-drift (:15) jobs each refresh the
 * grant, so `put` runs twice an hour with a genuinely new value. Secret Manager
 * bills every ENABLED or DISABLED version, and nothing ever destroyed the
 * superseded ones: the prod org secret reached 1,645 enabled versions
 * (~$99/month, +~$6/month per day). Only the newest version is ever read
 * (`versions/latest:access`), so anything older than the newest two is dead
 * weight — two are kept so a write that raced a concurrent read still leaves
 * the value that read saw.
 *
 * `maxDestroyPerPut` bounds the work a single cron run does: the steady state
 * is one destroy per rotation, and a backlog left by crashed runs drains a
 * few versions at a time (the bulk backlog is the ops script's job:
 * `scripts/ops/prune-docusign-refresh-token-versions.ts`).
 */
export interface DocusignRefreshTokenRetention {
  /** Newest ENABLED versions to leave in place. */
  keepVersions: number;
  /** Upper bound on `:destroy` calls issued by one `put`. */
  maxDestroyPerPut: number;
}

export const DEFAULT_DOCUSIGN_REFRESH_TOKEN_RETENTION: Readonly<DocusignRefreshTokenRetention> = Object.freeze({
  keepVersions: 2,
  maxDestroyPerPut: 10,
});

/** Minimal pino-compatible surface so tests can capture what is logged. */
export interface DocusignRefreshTokenStoreLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface GcpSecretManagerRefreshTokenStoreDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string>;
  logger?: DocusignRefreshTokenStoreLogger;
  retention?: Partial<DocusignRefreshTokenRetention>;
}

export interface SecretVersionSummary {
  name: string;
  state?: string;
}

const VERSION_NUMBER_RE = /\/versions\/(\d+)$/;
const VERSION_LIST_PAGE_SIZE = 500;
/** Hard stop on list pagination so a pathological secret cannot pin a cron run. */
const VERSION_LIST_MAX_PAGES = 20;

function versionNumber(name: string): number | null {
  const match = VERSION_NUMBER_RE.exec(name);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Pure selection of superseded versions. Sorts NUMERICALLY by version id
 * (the API returns names, and `10` sorts before `9` lexically), keeps the
 * newest `keepVersions` ENABLED entries, and returns the rest oldest-first,
 * capped at `maxDestroyPerPut`. `remaining` is the number of superseded
 * versions the cap left behind, so the caller can report backlog honestly.
 */
export function selectSupersededVersions(
  versions: readonly SecretVersionSummary[],
  retention: DocusignRefreshTokenRetention,
): { destroy: number[]; remaining: number } {
  const enabled = versions
    .filter((v) => (v.state ?? 'ENABLED') === 'ENABLED')
    .map((v) => versionNumber(v.name))
    .filter((n): n is number => n !== null)
    .sort((a, b) => b - a);
  const superseded = enabled.slice(Math.max(0, retention.keepVersions)).sort((a, b) => a - b);
  const cap = Math.max(0, retention.maxDestroyPerPut);
  return {
    destroy: superseded.slice(0, cap),
    remaining: Math.max(0, superseded.length - cap),
  };
}

function sameSecretValue(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

const SECRET_NAME_RE = /^projects\/([^/]+)\/secrets\/([A-Za-z0-9_-]{1,255})$/;
const SAFE_PROJECT_RE = /^[A-Za-z0-9:_-]{1,128}$/;
const SAFE_ORG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET_MANAGER_TIMEOUT_MS = 10_000;

function assertSafeSegment(value: string, label: string, pattern: RegExp): string {
  const trimmed = value.trim();
  if (!pattern.test(trimmed)) {
    throw new Error(`${label} contains characters that are not safe for a Secret Manager resource name`);
  }
  return trimmed;
}

export function resolveDocusignSecretManagerProjectId(env: NodeJS.ProcessEnv = process.env): string {
  const kmsProject = /^projects\/([^/]+)/.exec(env.GCP_KMS_INTEGRATION_TOKEN_KEY ?? '')?.[1];
  const projectId = env.GCP_SECRET_MANAGER_PROJECT_ID
    ?? env.GOOGLE_CLOUD_PROJECT
    ?? env.GCLOUD_PROJECT
    ?? env.GCP_PROJECT
    ?? env.PROJECT_ID
    ?? kmsProject;
  if (!projectId) {
    throw new Error('GCP_SECRET_MANAGER_PROJECT_ID or GOOGLE_CLOUD_PROJECT is required for DocuSign refresh-token storage');
  }
  return assertSafeSegment(projectId, 'projectId', SAFE_PROJECT_RE);
}

export function buildDocusignRefreshTokenSecretName(args: {
  projectId: string;
  orgId: string;
  accountId: string;
}): string {
  const projectId = assertSafeSegment(args.projectId, 'projectId', SAFE_PROJECT_RE);
  const orgId = assertSafeSegment(args.orgId, 'orgId', SAFE_ORG_RE);
  const accountHash = createHash('sha256').update(args.accountId, 'utf8').digest('hex').slice(0, 32);
  return `projects/${projectId}/secrets/arkova-docusign-${orgId}-${accountHash}-refresh-token`;
}

/**
 * SCRUM-2044 — Build member-level refresh token secret name.
 * Naming: arkova-docusign-member-{userId}-{accountHash}-refresh-token
 */
export function buildDocusignMemberRefreshTokenSecretName(args: {
  projectId: string;
  userId: string;
  accountId: string;
}): string {
  const projectId = assertSafeSegment(args.projectId, 'projectId', SAFE_PROJECT_RE);
  const userId = assertSafeSegment(args.userId, 'userId', SAFE_ORG_RE);
  const accountHash = createHash('sha256').update(args.accountId, 'utf8').digest('hex').slice(0, 32);
  return `projects/${projectId}/secrets/arkova-docusign-member-${userId}-${accountHash}-refresh-token`;
}

function parseSecretName(name: string): { projectId: string; secretId: string } {
  const match = SECRET_NAME_RE.exec(name);
  if (!match) {
    throw new Error('DocuSign refresh token secret name must be projects/{project}/secrets/{secret}');
  }
  return { projectId: match[1], secretId: match[2] };
}

function secretManagerUrl(path: string): string {
  return `https://secretmanager.googleapis.com/v1/${path}`;
}

export function createGcpSecretManagerRefreshTokenStore(
  deps: GcpSecretManagerRefreshTokenStoreDeps = {},
): DocusignRefreshTokenStore {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getAccessToken = deps.getAccessToken ?? (() => getGcpAccessToken());
  const log = deps.logger ?? defaultLogger;
  const retention: DocusignRefreshTokenRetention = {
    ...DEFAULT_DOCUSIGN_REFRESH_TOKEN_RETENTION,
    ...deps.retention,
  };

  async function headers(): Promise<Headers> {
    const token = await getAccessToken();
    return new Headers({
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    });
  }

  async function fetchSecretManager(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SECRET_MANAGER_TIMEOUT_MS);
    try {
      return await fetchImpl(secretManagerUrl(path), {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Secret Manager request timed out after ${SECRET_MANAGER_TIMEOUT_MS}ms`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function ensureSecretExists(name: string): Promise<void> {
    const { projectId, secretId } = parseSecretName(name);
    const getRes = await fetchSecretManager(name, {
      headers: await headers(),
    });
    if (getRes.ok) return;
    if (getRes.status !== 404) {
      throw new Error(`Secret Manager lookup failed for DocuSign token secret: ${getRes.status}`);
    }

    const project = assertSafeSegment(projectId, 'projectId', SAFE_PROJECT_RE);
    const createRes = await fetchSecretManager(`projects/${project}/secrets?secretId=${encodeURIComponent(secretId)}`, {
      method: 'POST',
      headers: await headers(),
      body: JSON.stringify({ replication: { automatic: {} } }),
    });
    if (!createRes.ok && createRes.status !== 409) {
      throw new Error(`Secret Manager create failed for DocuSign token secret: ${createRes.status}`);
    }
  }

  /**
   * Compare-before-write. Returns true only when the latest ENABLED version
   * holds exactly `value`. A missing version (404) or any read failure
   * returns false so the write still happens — losing a rotated refresh
   * token would sever the integration, one extra version costs cents.
   */
  async function latestVersionEquals(name: string, value: string): Promise<boolean> {
    try {
      const res = await fetchSecretManager(`${name}/versions/latest:access`, {
        headers: await headers(),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { payload?: { data?: string } };
      const data = body.payload?.data;
      if (!data) return false;
      return sameSecretValue(Buffer.from(data, 'base64').toString('utf8'), value);
    } catch {
      return false;
    }
  }

  async function listEnabledVersions(name: string): Promise<SecretVersionSummary[]> {
    const collected: SecretVersionSummary[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < VERSION_LIST_MAX_PAGES; page++) {
      const query = new URLSearchParams({ pageSize: String(VERSION_LIST_PAGE_SIZE), filter: 'state:ENABLED' });
      if (pageToken) query.set('pageToken', pageToken);
      const res = await fetchSecretManager(`${name}/versions?${query.toString()}`, {
        headers: await headers(),
      });
      if (!res.ok) {
        throw new Error(`Secret Manager list versions failed for DocuSign refresh token: ${res.status}`);
      }
      const body = (await res.json()) as { versions?: SecretVersionSummary[]; nextPageToken?: string };
      collected.push(...(body.versions ?? []));
      pageToken = body.nextPageToken || undefined;
      if (!pageToken) break;
    }
    return collected;
  }

  /**
   * Destroy superseded ENABLED versions after a successful write. Never
   * throws: the new token is already stored and the next rotation retries
   * whatever this pass could not do. Logs counts and the secret id only —
   * never a payload.
   */
  async function pruneSupersededVersions(name: string): Promise<void> {
    const { secretId } = parseSecretName(name);
    let destroyed = 0;
    let failed = 0;
    let remaining = 0;
    try {
      const versions = await listEnabledVersions(name);
      const selection = selectSupersededVersions(versions, retention);
      remaining = selection.remaining;
      for (const version of selection.destroy) {
        const res = await fetchSecretManager(`${name}/versions/${version}:destroy`, {
          method: 'POST',
          headers: await headers(),
          body: '{}',
        });
        if (res.ok) destroyed += 1;
        else failed += 1;
      }
    } catch (error) {
      log.warn(
        {
          secretId,
          destroyed,
          failed,
          remainingSuperseded: remaining + failed,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'DocuSign refresh-token secret: version prune failed; superseded versions remain enabled',
      );
      return;
    }
    // A version whose destroy failed is still enabled and still superseded.
    const summary = { secretId, destroyed, failed, remainingSuperseded: remaining + failed, keepVersions: retention.keepVersions };
    if (failed > 0) {
      log.warn(summary, 'DocuSign refresh-token secret: some superseded versions could not be destroyed');
    } else {
      log.info(summary, 'DocuSign refresh-token secret: superseded versions pruned');
    }
  }

  return {
    async put({ name, value }) {
      const { secretId } = parseSecretName(name);
      await ensureSecretExists(name);
      if (await latestVersionEquals(name, value)) {
        log.debug({ secretId }, 'DocuSign refresh-token secret: value unchanged; skipping new version');
        return;
      }
      const res = await fetchSecretManager(`${name}:addVersion`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({
          payload: { data: Buffer.from(value, 'utf8').toString('base64') },
        }),
      });
      if (!res.ok) {
        throw new Error(`Secret Manager addVersion failed for DocuSign refresh token: ${res.status}`);
      }
      await pruneSupersededVersions(name);
    },

    async get({ name }) {
      parseSecretName(name);
      const res = await fetchSecretManager(`${name}/versions/latest:access`, {
        headers: await headers(),
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`Secret Manager access failed for DocuSign refresh token: ${res.status}`);
      }
      const body = (await res.json()) as { payload?: { data?: string } };
      const data = body.payload?.data;
      return data ? Buffer.from(data, 'base64').toString('utf8') : null;
    },

    async delete({ name }) {
      parseSecretName(name);
      const res = await fetchSecretManager(name, {
        method: 'DELETE',
        headers: await headers(),
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`Secret Manager delete failed for DocuSign token secret: ${res.status}`);
      }
    },
  };
}
