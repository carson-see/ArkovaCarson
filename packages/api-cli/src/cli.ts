#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Arkova, ArkovaError, type AnchorDetails, type ArkovaConfig, type VerificationResult } from 'arkova';

export interface CliClient {
  request<T = unknown>(path: string, init?: RequestInit, options?: { idempotent?: boolean }): Promise<T>;
  getAnchor(publicId: string): Promise<AnchorDetails>;
  verify(publicId: string): Promise<VerificationResult>;
  fingerprint(data: string | ArrayBuffer): Promise<string>;
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
    'arkova probe <public-id> [--org-id id]',
    'arkova anchor <local-file> [--action queue|instant] [--description text] [--tag value] [--org-tag value]',
    'arkova import <rows-json-file> --action queue|instant [--description text] [--tag value] [--org-tag value]',
    'arkova folder list [--scope USER|ORG] [--org-id id] [--owner-user-id id] [--context-org-id id]',
    'arkova folder create --name name --scope USER|ORG [--org-id id] [--context-org-id id] [--parent-folder-id id]',
    'arkova folder move --record-id id [--record-id id] (--folder-id id|--root)',
  ],
  credentials: 'Set ARKOVA_API_KEY or pass --config - and pipe JSON on stdin.',
  config: { apiKey: 'required for authenticated commands', baseUrl: 'optional API origin' },
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
    if (typeof record.fingerprint !== 'string' || !/^[a-fA-F0-9]{64}$/.test(record.fingerprint)
      || typeof record.filename !== 'string' || record.filename.length < 1 || record.filename.length > 255
      || typeof record.fingerprint_provided !== 'boolean'
      || (record.file_size !== undefined && (typeof record.file_size !== 'number' || !Number.isInteger(record.file_size) || record.file_size < 0))
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
  return { ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) };
}

async function runCommand(args: string[], client: CliClient, readLocalFile: (path: string) => Promise<Buffer>): Promise<{ value: unknown; exitCode?: number }> {
  const command = args.shift();
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

function errorPayload(error: unknown, secrets: string[]): { error: { code: string; message: string; status?: number } } {
  if (error instanceof UsageError) {
    return { error: { code: 'usage_error', message: redact(error.message, secrets).slice(0, 256) } };
  }
  if (error instanceof ArkovaError) {
    const candidate = redact(error.code || '', secrets);
    const code = /^[a-z][a-z0-9_]{0,63}$/.test(candidate) ? candidate : 'api_error';
    return { error: { code, message: 'Arkova API request failed', status: error.statusCode } };
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
    const result = await runCommand(args, client, dependencies.readFile ?? readFile);
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
