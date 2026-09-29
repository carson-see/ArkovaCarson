#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Arkova, ArkovaError, type Agent, type AgentKeyCreated, type AgentRevocation, type AgentScope, type AgentType,
  type AnchorDetails, type ArkovaConfig, type ComputeIdAdmissionInput,
  type ComputeIdAdmissionResult, type CreateAgentInput, type UpdateAgentInput,
  type ListAnchorsOptions, type ListAnchorsResponse, type VerificationResult } from 'arkova';

export interface CliClient {
  request<T = unknown>(path: string, init?: RequestInit, options?: { idempotent?: boolean }): Promise<T>;
  getAnchor(publicId: string): Promise<AnchorDetails>;
  verify(publicId: string): Promise<VerificationResult>;
  fingerprint(data: string | ArrayBuffer): Promise<string>;
  listAnchors(options?: ListAnchorsOptions): Promise<ListAnchorsResponse>;
  agents: {
    register(input: CreateAgentInput): Promise<Agent>;
    list(): Promise<Agent[]>;
    get(agentId: string): Promise<Agent>;
    update(agentId: string, input: UpdateAgentInput): Promise<Agent>;
    revoke(agentId: string): Promise<AgentRevocation>;
    createKey(agentId: string): Promise<AgentKeyCreated>;
    admitComputeId(input: ComputeIdAdmissionInput): Promise<ComputeIdAdmissionResult>;
  };
}

interface CliIo {
  env: Record<string, string | undefined>;
  stdin(): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
}

interface Dependencies {
  client?: CliClient;
  clientFactory?: (config: ArkovaConfig) => CliClient;
  readFile?: (path: string) => Promise<Buffer>;
  now?: () => Date;
}

class UsageError extends Error {}

const HELP = {
  command: 'arkova',
  output: 'json',
  usage: [
    'arkova health',
    'arkova read <public-id>',
    'arkova verify <public-id>',
    'arkova status <public-id>',
    'arkova anchors list [--since RFC3339|Nh] [--until RFC3339] [--tag value --tag-scope user|organization] [--limit 1-100] [--cursor value]',
    'arkova probe <public-id> [--org-id id]',
    'arkova anchor <local-file> [--action queue|instant] [--description text] [--tag value] [--org-tag value]',
    'arkova import <rows-json-file> --action queue|instant [--description text] [--tag value] [--org-tag value]',
    'arkova folder list [--scope USER|ORG] [--org-id id] [--owner-user-id id] [--context-org-id id]',
    'arkova folder create --name name --scope USER|ORG [--org-id id] [--context-org-id id] [--parent-folder-id id]',
    'arkova folder update <folder-id> [--name name] [--parent-folder-id id|--root]',
    'arkova folder connector <folder-id> (--provider google_drive|docusign --source-id id --connection-id id|--clear)',
    'arkova folder delete <folder-id>',
    'arkova folder move --record-id id [--record-id id] (--folder-id id|--root)',
    'arkova agent register --name name [--description text] [--type value] [--scope value] [--framework value] [--version value] [--callback-url https-url] [--metadata-json file]',
    'arkova agent list | get <agent-id> | revoke <agent-id>',
    'arkova agent update <agent-id> [--name name] [--description text] [--scope value] [--status active|suspended] [--framework value] [--version value] [--callback-url https-url|--clear-callback-url]',
    'arkova agent key create <agent-id>',
    'arkova agent computeid admit --request-json file',
  ],
  credentials: 'Set ARKOVA_API_KEY or pass --config - and pipe JSON on stdin.',
  config: { apiKey: 'required for authenticated commands', baseUrl: 'optional API origin', timeoutMs: 'optional request deadline (1-120000 ms); ARKOVA_TIMEOUT_MS' },
};

function writeJson(write: (text: string) => void, value: unknown): void {
  write(`${JSON.stringify(value)}\n`);
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value == null || value.startsWith('--')) throw new UsageError(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeMany(args: string[], name: string): string[] {
  const values: string[] = [];
  while (args.includes(name)) values.push(takeOption(args, name) as string);
  return values;
}

function takeBoolean(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function noExtra(args: string[]): void {
  if (args.length > 0) throw new UsageError(`Unexpected argument: ${args[0]}`);
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new UsageError(`${label} is required`);
  return value;
}

async function readJsonObject(path: string, readLocalFile: (path: string) => Promise<Buffer>, label: string): Promise<Record<string, unknown>> {
  if (path === '-') throw new UsageError(`${label} requires a local JSON file path`);
  let value: unknown;
  try { value = JSON.parse((await readLocalFile(path)).toString('utf8')); } catch { throw new UsageError(`${label} must contain valid JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UsageError(`${label} must contain a JSON object`);
  return value as Record<string, unknown>;
}
const CLI_AGENT_TYPES = new Set(['llm_agent', 'ats_integration', 'hr_platform', 'compliance_tool', 'custom']);
const CLI_AGENT_SCOPES = new Set(['read:records', 'read:orgs', 'read:search', 'write:anchors', 'admin:rules', 'verify', 'verify:batch', 'usage:read', 'keys:manage', 'compliance:read', 'compliance:write', 'oracle:read', 'oracle:write', 'anchor:write', 'anchor:read', 'attestations:write', 'attestations:read', 'webhooks:manage', 'agents:manage', 'keys:read', 'orgs:manage']);
const CLI_COMPUTEID_SCOPES = new Set(['verify', 'verify:batch', 'anchor:write', 'write:anchors', 'anchor:read', 'read:records', 'read:search']);
function validateAgentFlags(type: string | undefined, status: string | undefined, scopes: string[], callback: string | undefined): void {
  if (type !== undefined && !CLI_AGENT_TYPES.has(type)) throw new UsageError('--type is invalid');
  if (status !== undefined && !['active', 'suspended'].includes(status)) throw new UsageError('--status must be active or suspended');
  if (scopes.some((scope) => !CLI_AGENT_SCOPES.has(scope))) throw new UsageError('--scope is invalid');
  if (callback !== undefined) {
    try {
      const parsed = new URL(callback);
      if (parsed.protocol !== 'https:' || !parsed.hostname) throw new Error();
    } catch { throw new UsageError('--callback-url must be a valid HTTPS URL'); }
  }
}
function validateAdmission(value: Record<string, unknown>): asserts value is Record<string, unknown> & { passport_id: string; verification_receipt: Record<string, unknown> } {
  const receipt = value.verification_receipt;
  const scopes = value.allowed_scopes;
  if (Object.keys(value).some((key) => !['passport_id', 'verification_receipt', 'name', 'description', 'allowed_scopes'].includes(key))
      || typeof value.passport_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.passport_id)
      || !receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || (receipt as Record<string, unknown>).passport_id !== value.passport_id
      || !['status', 'issued_at', 'expires_at', 'key_id', 'receipt_signature', 'receipt_algorithm', 'receipt_payload'].every((key) => typeof (receipt as Record<string, unknown>)[key] === 'string' && ((receipt as Record<string, unknown>)[key] as string).length > 0)
      || (scopes !== undefined && (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => typeof scope !== 'string' || !CLI_COMPUTEID_SCOPES.has(scope))))) {
    throw new UsageError('request-json-file does not match the ComputeID admission contract');
  }
}

async function runAgent(args: string[], client: CliClient, readLocalFile: (path: string) => Promise<Buffer>): Promise<unknown> {
  const action = required(args.shift(), 'agent action');
  if (action === 'list') { noExtra(args); return client.agents.list(); }
  if (action === 'get') { const id = required(args.shift(), 'agent-id'); noExtra(args); return client.agents.get(id); }
  if (action === 'revoke') { const id = required(args.shift(), 'agent-id'); noExtra(args); return client.agents.revoke(id); }
  if (action === 'key') {
    if (required(args.shift(), 'key action') !== 'create') throw new UsageError('agent key action must be create');
    const id = required(args.shift(), 'agent-id'); noExtra(args); return client.agents.createKey(id);
  }
  if (action === 'computeid') {
    if (required(args.shift(), 'ComputeID action') !== 'admit') throw new UsageError('agent computeid action must be admit');
    const file = required(takeOption(args, '--request-json'), '--request-json'); noExtra(args);
    const value = await readJsonObject(file, readLocalFile, 'request-json-file');
    validateAdmission(value);
    return client.agents.admitComputeId({
      passportId: value.passport_id, verificationReceipt: value.verification_receipt as ComputeIdAdmissionInput['verificationReceipt'],
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
      ...(Array.isArray(value.allowed_scopes) ? { allowedScopes: value.allowed_scopes as ComputeIdAdmissionInput['allowedScopes'] } : {}),
    });
  }
  if (action === 'register') {
    const name = required(takeOption(args, '--name'), '--name');
    const description = takeOption(args, '--description'); const agentType = takeOption(args, '--type');
    const scopes = takeMany(args, '--scope'); const framework = takeOption(args, '--framework');
    const version = takeOption(args, '--version'); const callbackUrl = takeOption(args, '--callback-url');
    const metadataFile = takeOption(args, '--metadata-json');
    const metadata = metadataFile ? await readJsonObject(metadataFile, readLocalFile, 'metadata-json-file') : undefined;
    validateAgentFlags(agentType, undefined, scopes, callbackUrl);
    if (metadata && Object.prototype.hasOwnProperty.call(metadata, 'computeid')) throw new UsageError('metadata.computeid is provider-managed');
    noExtra(args);
    return client.agents.register({ name, ...(description ? { description } : {}), ...(agentType ? { agentType: agentType as AgentType } : {}),
      ...(scopes.length ? { allowedScopes: scopes as AgentScope[] } : {}), ...(framework ? { framework } : {}),
      ...(version ? { version } : {}), ...(callbackUrl ? { callbackUrl } : {}), ...(metadata ? { metadata } : {}) });
  }
  if (action === 'update') {
    const id = required(args.shift(), 'agent-id'); const input: UpdateAgentInput = {};
    const name = takeOption(args, '--name'); const description = takeOption(args, '--description');
    const scopes = takeMany(args, '--scope'); const status = takeOption(args, '--status');
    const framework = takeOption(args, '--framework'); const version = takeOption(args, '--version');
    const callbackUrl = takeOption(args, '--callback-url'); const clearCallback = takeBoolean(args, '--clear-callback-url');
    validateAgentFlags(undefined, status, scopes, callbackUrl);
    if (callbackUrl && clearCallback) throw new UsageError('--callback-url and --clear-callback-url cannot be combined');
    Object.assign(input, name !== undefined ? { name } : {}, description !== undefined ? { description } : {},
      scopes.length ? { allowedScopes: scopes as AgentScope[] } : {}, status ? { status } : {}, framework ? { framework } : {},
      version ? { version } : {}, callbackUrl ? { callbackUrl } : {}, clearCallback ? { callbackUrl: null } : {});
    noExtra(args);
    if (Object.keys(input).length === 0) throw new UsageError('agent update requires at least one field');
    return client.agents.update(id, input);
  }
  throw new UsageError(`Unknown agent action: ${action}`);
}

function validateTags(values: string[], flag: string): string[] {
  if (values.length > 10 || values.some((value) => value.length === 0 || value.length > 64)) {
    throw new UsageError(`${flag} accepts up to 10 values of 1-64 characters`);
  }
  return values;
}

const IMPORT_ROW_KEYS = new Set(['fingerprint', 'filename', 'fingerprint_provided', 'file_size', 'credential_type', 'metadata', 'recipient_email', 'recipient_name']);
const IMPORT_CREDENTIAL_TYPES = new Set(['DEGREE', 'LICENSE', 'CERTIFICATE', 'TRANSCRIPT', 'PROFESSIONAL', 'CPE', 'CLE', 'BADGE', 'ATTESTATION', 'FINANCIAL', 'LEGAL', 'INSURANCE', 'SEC_FILING', 'PATENT', 'REGULATION', 'PUBLICATION', 'CHARITY', 'ACCREDITATION', 'FINANCIAL_ADVISOR', 'BUSINESS_ENTITY', 'RESUME', 'MEDICAL', 'MILITARY', 'IDENTITY', 'CONTRACT_PRESIGNING', 'CONTRACT_POSTSIGNING', 'OTHER']);
function validateImportRows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new UsageError('rows-json-file must contain 1-100 row objects');
  return value.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new UsageError(`import row ${index} must be an object`);
    const record = row as Record<string, unknown>;
    if (Object.keys(record).some((key) => !IMPORT_ROW_KEYS.has(key))) throw new UsageError(`import row ${index} contains an unsupported field`);
    // The worker requires a POSITIVE file_size, so a 0 used to be forwarded and
    // then rejected server-side for the WHOLE request (#3034 review).
    if (record.file_size !== undefined && (typeof record.file_size !== 'number' || !Number.isInteger(record.file_size) || record.file_size < 1)) {
      throw new UsageError(`import row ${index}: file_size must be a positive integer`);
    }
    if (typeof record.fingerprint !== 'string' || !/^[a-fA-F0-9]{64}$/.test(record.fingerprint)
      || typeof record.filename !== 'string' || record.filename.length < 1 || record.filename.length > 255
      || typeof record.fingerprint_provided !== 'boolean'
      || (record.credential_type !== undefined && (typeof record.credential_type !== 'string' || !IMPORT_CREDENTIAL_TYPES.has(record.credential_type)))
      || (record.metadata !== undefined && (!record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)))
      || (record.recipient_email !== undefined && typeof record.recipient_email !== 'string')
      || (record.recipient_name !== undefined && typeof record.recipient_name !== 'string')) throw new UsageError(`import row ${index} is invalid`);
    return record;
  });
}

async function loadConfig(args: string[], io: CliIo): Promise<ArkovaConfig> {
  const source = takeOption(args, '--config');
  if (source != null && source !== '-') throw new UsageError('--config accepts only - (stdin)');
  let stdinConfig: Record<string, unknown> = {};
  if (source === '-') {
    try {
      const parsed = JSON.parse(await io.stdin()) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      stdinConfig = parsed as Record<string, unknown>;
    } catch {
      throw new UsageError('stdin config must be a JSON object');
    }
  }
  const apiKey = typeof stdinConfig.apiKey === 'string' ? stdinConfig.apiKey : io.env.ARKOVA_API_KEY;
  const baseUrl = typeof stdinConfig.baseUrl === 'string' ? stdinConfig.baseUrl : io.env.ARKOVA_BASE_URL;
  const fromStdin = Object.prototype.hasOwnProperty.call(stdinConfig, 'timeoutMs');
  const timeoutRaw = fromStdin ? stdinConfig.timeoutMs : io.env.ARKOVA_TIMEOUT_MS;
  const timeoutMs = fromStdin
    ? (typeof timeoutRaw === 'number' ? timeoutRaw : Number.NaN)
    : (timeoutRaw === undefined ? undefined : typeof timeoutRaw === 'string' && /^[1-9][0-9]*$/.test(timeoutRaw) ? Number(timeoutRaw) : Number.NaN);
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)) {
    throw new UsageError('ARKOVA_TIMEOUT_MS or stdin timeoutMs must be an integer from 1 to 120000');
  }
  return { ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}

async function runCommand(args: string[], client: CliClient, readLocalFile: (path: string) => Promise<Buffer>, now: () => Date): Promise<{ value: unknown; exitCode?: number }> {
  const command = args.shift();
  if (command === 'agent') return { value: await runAgent(args, client, readLocalFile) };
  if (command === 'health') {
    noExtra(args);
    return { value: await client.request('/health') };
  }
  if (command === 'read') {
    const publicId = required(args.shift(), 'public-id');
    noExtra(args);
    return { value: await client.getAnchor(publicId) };
  }
  if (command === 'verify') {
    const publicId = required(args.shift(), 'public-id');
    noExtra(args);
    const result = await client.verify(publicId);
    return { value: result, exitCode: result.verified ? 0 : 1 };
  }
  if (command === 'status') {
    const publicId = required(args.shift(), 'public-id');
    noExtra(args);
    return {
      value: await client.request(
        `/api/v1/anchor/${encodeURIComponent(publicId)}/submission-status`,
      ),
    };
  }
  if (command === 'anchors') {
    if (required(args.shift(), 'anchors action') !== 'list') throw new UsageError('anchors action must be list');
    const sinceRaw = takeOption(args, '--since'); const until = takeOption(args, '--until');
    const tag = takeOption(args, '--tag'); const tagScope = takeOption(args, '--tag-scope');
    const limitRaw = takeOption(args, '--limit'); const cursor = takeOption(args, '--cursor');
    if ((tag !== undefined) !== (tagScope !== undefined)) throw new UsageError('--tag and --tag-scope must be provided together');
    if (tagScope && tagScope !== 'user' && tagScope !== 'organization') throw new UsageError('--tag-scope must be user or organization');
    if (tag !== undefined && (tag.trim().length < 1 || tag.trim().length > 64)) throw new UsageError('--tag must be 1-64 characters');
    if (cursor !== undefined && cursor.length < 1) throw new UsageError('--cursor must not be empty');
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new UsageError('--limit must be an integer from 1 to 100');
    let since = sinceRaw;
    if (sinceRaw && /^\d+h$/.test(sinceRaw)) {
      if (cursor) throw new UsageError('relative --since cannot be reused with --cursor; use the resolved query.since timestamp from the previous result');
      const hours = Number(sinceRaw.slice(0, -1));
      if (!Number.isSafeInteger(hours) || hours < 1 || hours > 8760) throw new UsageError('--since relative hours must be 1h-8760h');
      since = new Date(now().getTime() - hours * 3_600_000).toISOString();
    }
    noExtra(args);
    const query = { ...(since ? { since } : {}), ...(until ? { until } : {}), ...(tag !== undefined ? { tag: tag.trim(), tagScope: tagScope as 'user' | 'organization' } : {}), ...(limit !== undefined ? { limit } : {}) };
    const page = await client.listAnchors({ ...query, ...(cursor ? { cursor } : {}) });
    return { value: { ...page, query, nextPageOptions: page.nextCursor ? { ...query, cursor: page.nextCursor } : null } };
  }
  if (command === 'probe') {
    const publicId = required(args.shift(), 'public-id');
    const orgId = takeOption(args, '--org-id');
    noExtra(args);
    const folderParams = new URLSearchParams({ owner_scope: 'ORG' });
    if (orgId) folderParams.set('org_id', orgId);
    const [health, record, verification, folderResponse] = await Promise.all([
      client.request('/health'),
      client.getAnchor(publicId),
      client.verify(publicId),
      client.request<{ folders: unknown[] }>(`/api/v1/folders?${folderParams}`),
    ]);
    return { value: { health, record, verification, folders: folderResponse.folders } };
  }
  if (command === 'anchor') {
    const path = required(args.shift(), 'local-file');
    if (path === '-') throw new UsageError('anchor requires a local file path');
    const action = takeOption(args, '--action') ?? 'queue';
    if (action !== 'queue' && action !== 'instant') throw new UsageError('--action must be queue or instant');
    const description = takeOption(args, '--description');
    if (description && description.length > 1000) throw new UsageError('--description must be at most 1000 characters');
    const userTags = validateTags(takeMany(args, '--tag'), '--tag');
    const organizationTags = validateTags(takeMany(args, '--org-tag'), '--org-tag');
    noExtra(args);
    const file = await readLocalFile(path);
    const bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
    const fingerprint = await client.fingerprint(bytes);
    const body = {
      fingerprint,
      ...(description ? { description } : {}),
      action,
      ...(userTags.length || organizationTags.length ? {
        private_tags: {
          ...(userTags.length ? { user: userTags } : {}),
          ...(organizationTags.length ? { organization: organizationTags } : {}),
        },
      } : {}),
    };
    return {
      value: await client.request('/api/v1/anchor', { method: 'POST', body: JSON.stringify(body) }, { idempotent: true }),
    };
  }
  if (command === 'import') {
    const path = required(args.shift(), 'rows-json-file');
    if (path === '-') throw new UsageError('import requires a local JSON file path');
    const action = required(takeOption(args, '--action'), '--action');
    if (action !== 'queue' && action !== 'instant') throw new UsageError('--action must be queue or instant');
    const description = takeOption(args, '--description');
    if (description && description.length > 1000) throw new UsageError('--description must be at most 1000 characters');
    const userTags = validateTags(takeMany(args, '--tag'), '--tag');
    const organizationTags = validateTags(takeMany(args, '--org-tag'), '--org-tag');
    noExtra(args);
    let rows: unknown;
    try { rows = JSON.parse((await readLocalFile(path)).toString('utf8')); } catch { throw new UsageError('rows-json-file must contain valid JSON'); }
    rows = validateImportRows(rows);
    return { value: await client.request('/api/v1/anchor/import', {
      method: 'POST',
      body: JSON.stringify({ action, rows, ...(description ? { description } : {}), ...((userTags.length || organizationTags.length) ? { private_tags: { user: userTags, organization: organizationTags } } : {}) }),
    }) };
  }
  if (command === 'folder') return runFolder(args, client);
  throw new UsageError(command ? `Unknown command: ${command}` : 'A command is required');
}

async function runFolder(args: string[], client: CliClient): Promise<{ value: unknown }> {
  const action = args.shift();
  if (action === 'list') {
    const scope = takeOption(args, '--scope') ?? 'ORG';
    if (scope !== 'USER' && scope !== 'ORG') throw new UsageError('--scope must be USER or ORG');
    const params = new URLSearchParams({ owner_scope: scope });
    const pairs = [
      ['owner_user_id', takeOption(args, '--owner-user-id')],
      ['org_id', takeOption(args, '--org-id')],
      ['context_org_id', takeOption(args, '--context-org-id')],
    ] as const;
    for (const [name, value] of pairs) if (value) params.set(name, value);
    noExtra(args);
    return { value: await client.request(`/api/v1/folders?${params}`) };
  }
  if (action === 'create') {
    const name = required(takeOption(args, '--name'), '--name');
    if (name.length > 100) throw new UsageError('--name must be at most 100 characters');
    const scope = required(takeOption(args, '--scope'), '--scope');
    if (scope !== 'USER' && scope !== 'ORG') throw new UsageError('--scope must be USER or ORG');
    const orgId = takeOption(args, '--org-id');
    const contextOrgId = takeOption(args, '--context-org-id');
    const parentFolderId = takeOption(args, '--parent-folder-id');
    const body = {
      name, owner_scope: scope,
      ...(orgId ? { org_id: orgId } : {}),
      ...(contextOrgId ? { context_org_id: contextOrgId } : {}),
      ...(parentFolderId ? { parent_folder_id: parentFolderId } : {}),
    };
    noExtra(args);
    return { value: await client.request('/api/v1/folders', { method: 'POST', body: JSON.stringify(body) }) };
  }
  if (action === 'update') {
    const folderId = required(args.shift(), 'folder-id');
    const name = takeOption(args, '--name');
    if (name !== undefined && (name.trim().length === 0 || name.length > 100)) {
      throw new UsageError('--name must be 1-100 characters');
    }
    const parentFolderId = takeOption(args, '--parent-folder-id');
    const root = takeBoolean(args, '--root');
    if (parentFolderId && root) throw new UsageError('use only one of --parent-folder-id or --root');
    if (name === undefined && parentFolderId === undefined && !root) {
      throw new UsageError('folder update requires --name, --parent-folder-id, or --root');
    }
    noExtra(args);
    const body = {
      ...(name !== undefined ? { name } : {}),
      ...(parentFolderId !== undefined || root ? { parent_folder_id: root ? null : parentFolderId } : {}),
    };
    return { value: await client.request(`/api/v1/folders/${encodeURIComponent(folderId)}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }) };
  }
  if (action === 'connector') {
    const folderId = required(args.shift(), 'folder-id');
    const provider = takeOption(args, '--provider');
    const sourceId = takeOption(args, '--source-id');
    const connectionId = takeOption(args, '--connection-id');
    const clear = takeBoolean(args, '--clear');
    if (clear && (provider || sourceId || connectionId)) {
      throw new UsageError('--clear cannot be combined with connector values');
    }
    if (!clear && (provider !== 'google_drive' && provider !== 'docusign')) {
      throw new UsageError('--provider must be google_drive or docusign');
    }
    if (!clear && (!sourceId || !connectionId)) {
      throw new UsageError('--source-id and --connection-id are required');
    }
    noExtra(args);
    const body = clear
      ? { provider: null, source_id: null, connection_id: null }
      : { provider, source_id: sourceId, connection_id: connectionId };
    return { value: await client.request(`/api/v1/folders/${encodeURIComponent(folderId)}/connector`, {
      method: 'PUT', body: JSON.stringify(body),
    }) };
  }
  if (action === 'delete') {
    const folderId = required(args.shift(), 'folder-id');
    noExtra(args);
    await client.request(`/api/v1/folders/${encodeURIComponent(folderId)}`, { method: 'DELETE' });
    return { value: { deleted: true } };
  }
  if (action === 'move') {
    const recordPublicIds = takeMany(args, '--record-id');
    if (recordPublicIds.length === 0 || recordPublicIds.length > 100) throw new UsageError('--record-id is required (maximum 100)');
    const folderId = takeOption(args, '--folder-id');
    const root = takeBoolean(args, '--root');
    if ((folderId == null) === !root) throw new UsageError('use exactly one of --folder-id or --root');
    noExtra(args);
    return { value: await client.request('/api/v1/folders/bulk-move', {
      method: 'POST', body: JSON.stringify({ record_public_ids: recordPublicIds, folder_id: root ? null : folderId }),
    }) };
  }
  throw new UsageError(action ? `Unknown folder command: ${action}` : 'A folder command is required');
}

function redact(value: string, secrets: string[]): string {
  return secrets.reduce((text, secret) => secret ? text.split(secret).join('[REDACTED]') : text, value);
}

function safeErrorDetails(value: Readonly<Record<string, unknown>> | undefined, secrets: string[]): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const result: Record<string, unknown> = {};
  const token = (candidate: unknown, max = 80): candidate is string => typeof candidate === 'string'
    && candidate.length >= 1 && candidate.length <= max && !/[^a-z0-9:._-]/i.test(candidate);
  for (const key of ['code', 'reason', 'required'] as const) {
    if (token(value[key])) result[key] = redact(value[key], secrets);
  }
  for (const key of ['permitted', 'granted', 'missing'] as const) {
    if (Array.isArray(value[key]) && value[key].length <= 32
      && value[key].every((item) => token(item))) result[key] = value[key].map((item) => redact(item, secrets));
  }
  if (typeof value.agent_id === 'string' && /^[0-9a-f-]{36}$/i.test(value.agent_id)) result.agent_id = value.agent_id;
  if (token(value.request_id, 128)) result.request_id = redact(value.request_id, secrets);
  if (typeof value.retryable === 'boolean') result.retryable = value.retryable;
  return Object.keys(result).length ? result : undefined;
}

function errorPayload(error: unknown, secrets: string[]): { error: { code: string; message: string; status?: number; details?: Record<string, unknown> } } {
  if (error instanceof UsageError) {
    return { error: { code: 'usage_error', message: redact(error.message, secrets).slice(0, 256) } };
  }
  if (error instanceof ArkovaError) {
    const candidate = redact(error.code || '', secrets);
    const code = /^[a-z][a-z0-9_]{0,63}$/.test(candidate) ? candidate : 'api_error';
    const details = safeErrorDetails(error.details, secrets);
    return { error: { code, message: 'Arkova API request failed', status: error.statusCode, ...(details ? { details } : {}) } };
  }
  return { error: { code: 'unexpected_error', message: 'Command failed' } };
}

const defaultIo: CliIo = {
  env: process.env,
  stdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  },
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function main(argv: string[], io: CliIo = defaultIo, dependencies: Dependencies = {}): Promise<number> {
  const args = [...argv];
  if (args.includes('--help') || args.includes('-h')) {
    writeJson(io.stdout, HELP);
    return 0;
  }
  const secrets = [io.env.ARKOVA_API_KEY].filter((value): value is string => Boolean(value));
  try {
    const config = await loadConfig(args, io);
    if (config.apiKey && !secrets.includes(config.apiKey)) secrets.push(config.apiKey);
    if (!config.apiKey && args[0] !== 'health') throw new UsageError('ARKOVA_API_KEY or stdin config apiKey is required');
    const client = dependencies.client ?? (dependencies.clientFactory ?? ((value) => new Arkova(value)))(config);
    const result = await runCommand(args, client, dependencies.readFile ?? readFile, dependencies.now ?? (() => new Date()));
    if (result.value && typeof result.value === 'object' && !Array.isArray(result.value)) {
      const returnedKey = (result.value as Record<string, unknown>).key;
      if (typeof returnedKey === 'string' && !secrets.includes(returnedKey)) secrets.push(returnedKey);
    }
    writeJson(io.stdout, result.value);
    return result.exitCode ?? 0;
  } catch (error) {
    const payload = errorPayload(error, secrets);
    writeJson(io.stderr, payload);
    return payload.error.code === 'usage_error' ? 2 : 1;
  }
}

function isDirectInvocation(entryPath: string | undefined): boolean {
  if (!entryPath) return false;
  try {
    return pathToFileURL(realpathSync(entryPath)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1])) process.exitCode = await main(process.argv.slice(2));
