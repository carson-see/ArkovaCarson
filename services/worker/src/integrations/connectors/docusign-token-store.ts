import { createHash } from 'node:crypto';

import { getGcpAccessToken } from '../../utils/gcp-auth.js';

export interface DocusignRefreshTokenStore {
  put(args: { name: string; value: string }): Promise<void>;
  get(args: { name: string }): Promise<string | null>;
  delete(args: { name: string }): Promise<void>;
}

export interface GcpSecretManagerRefreshTokenStoreDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string>;
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

  return {
    async put({ name, value }) {
      parseSecretName(name);
      await ensureSecretExists(name);
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
