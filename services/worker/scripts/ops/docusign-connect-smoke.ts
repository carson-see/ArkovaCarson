#!/usr/bin/env -S npx tsx
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export type DocusignSmokeMode = 'orphan' | 'accepted-duplicate';
type CheckStatus = 'pass' | 'fail' | 'skip';

interface DocusignConnectPayload {
  event: 'envelope-completed';
  eventId: string;
  envelopeId: string;
  accountId: string;
  status: 'completed';
  generatedDateTime: string;
  sender: { email: string };
  envelopeDocuments: Array<{
    documentId: string;
    name: string;
    sha256: string;
  }>;
}

export interface DocusignSmokeOptions {
  workerUrl: string;
  hmacSecret: string;
  mode: DocusignSmokeMode;
  accountId: string;
  envelopeId: string;
  eventId: string;
  generatedDateTime: string;
  senderEmail: string;
  timeoutMs: number;
  allowProcessing: boolean;
}

interface HttpResult {
  status: number;
  body: unknown;
}

interface SmokeCheck {
  name: string;
  status: CheckStatus;
  http_status?: number;
  code?: string | null;
  detail: string;
}

export interface DocusignSmokeResult {
  ok: boolean;
  worker_url: string;
  mode: DocusignSmokeMode;
  envelope_id: string;
  event_id: string;
  account_id_sha256: string;
  checks: SmokeCheck[];
}

interface SmokeDeps {
  fetchImpl?: typeof fetch;
}

function normalizeWorkerUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseArgTokens(argv: string[]): { values: Map<string, string>; flags: Set<string> } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }

    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    if (equalsIndex >= 0) {
      const key = withoutPrefix.slice(0, equalsIndex);
      const value = withoutPrefix.slice(equalsIndex + 1);
      values.set(key, value);
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags.add(withoutPrefix);
      continue;
    }

    values.set(withoutPrefix, next);
    i += 1;
  }
  return { values, flags };
}

function envFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): DocusignSmokeOptions {
  const { values, flags } = parseArgTokens(argv);
  const hmacSecret = (values.get('hmac-secret') ?? env.DOCUSIGN_CONNECT_HMAC_SECRET ?? '').trim();
  if (!hmacSecret) {
    throw new Error('DOCUSIGN_CONNECT_HMAC_SECRET is required; pass it via env or --hmac-secret.');
  }

  const mode = (values.get('mode') ?? env.DOCUSIGN_SMOKE_MODE ?? 'orphan') as DocusignSmokeMode;
  if (mode !== 'orphan' && mode !== 'accepted-duplicate') {
    throw new Error(`Unsupported --mode=${mode}; expected orphan or accepted-duplicate.`);
  }

  const allowProcessing = flags.has('allow-processing') || envFlag(env.DOCUSIGN_SMOKE_ALLOW_PROCESSING);
  const accountId = (
    values.get('account-id') ??
    env.DOCUSIGN_SMOKE_ACCOUNT_ID ??
    (mode === 'orphan' ? `arkova-smoke-unknown-${Date.now()}` : '')
  ).trim();
  if (mode === 'accepted-duplicate' && !allowProcessing) {
    throw new Error('--mode=accepted-duplicate requires --allow-processing because it can enqueue real work.');
  }
  if (mode === 'accepted-duplicate' && !accountId) {
    throw new Error('--mode=accepted-duplicate requires --account-id for the connected sandbox integration.');
  }

  const envelopeId = (
    values.get('envelope-id') ??
    env.DOCUSIGN_SMOKE_ENVELOPE_ID ??
    `arkova-smoke-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`
  ).trim();
  const eventId = (values.get('event-id') ?? env.DOCUSIGN_SMOKE_EVENT_ID ?? `evt-${envelopeId}`).trim();
  const generatedDateTime = (
    values.get('generated-at') ??
    env.DOCUSIGN_SMOKE_GENERATED_AT ??
    new Date().toISOString()
  ).trim();
  const senderEmail = (
    values.get('sender-email') ??
    env.DOCUSIGN_SMOKE_SENDER_EMAIL ??
    'arkova.docusign.smoke@example.invalid'
  ).trim();
  const timeoutMs = Number(values.get('timeout-ms') ?? env.DOCUSIGN_SMOKE_TIMEOUT_MS ?? '10000');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number.');
  }

  return {
    workerUrl: normalizeWorkerUrl(values.get('worker-url') ?? env.WORKER_URL ?? 'http://localhost:3001'),
    hmacSecret,
    mode,
    accountId,
    envelopeId,
    eventId,
    generatedDateTime,
    senderEmail,
    timeoutMs,
    allowProcessing,
  };
}

export function buildDocusignConnectPayload(args: {
  accountId: string;
  envelopeId: string;
  eventId: string;
  generatedDateTime: string;
  senderEmail: string;
}): DocusignConnectPayload {
  return {
    event: 'envelope-completed',
    eventId: args.eventId,
    envelopeId: args.envelopeId,
    accountId: args.accountId,
    status: 'completed',
    generatedDateTime: args.generatedDateTime,
    sender: { email: args.senderEmail },
    envelopeDocuments: [{
      documentId: 'combined',
      name: `arkova-smoke-${args.envelopeId}.pdf`.slice(0, 500),
      sha256: sha256Hex(`arkova-docusign-smoke:${args.accountId}:${args.envelopeId}`),
    }],
  };
}

export function signDocusignPayload(rawBody: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
}

function codeFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === 'object') {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  if (record.orphaned === true) return 'orphaned';
  if (record.duplicate === true) return 'duplicate';
  if (record.ok === true) return 'ok';
  return null;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 500);
  }
}

async function postPayload(args: {
  options: DocusignSmokeOptions;
  rawBody: string;
  signature: string;
  fetchImpl: typeof fetch;
}): Promise<HttpResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.options.timeoutMs);
  try {
    const res = await args.fetchImpl(`${args.options.workerUrl}/webhooks/docusign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DocuSign-Signature-1': args.signature,
      },
      body: args.rawBody,
      signal: controller.signal,
    });
    return { status: res.status, body: await readBody(res) };
  } finally {
    clearTimeout(timeout);
  }
}

function checkResult(name: string, http: HttpResult, pass: boolean, detail: string): SmokeCheck {
  return {
    name,
    status: pass ? 'pass' : 'fail',
    http_status: http.status,
    code: codeFromBody(http.body),
    detail,
  };
}

export async function runDocusignConnectSmoke(
  options: DocusignSmokeOptions,
  deps: SmokeDeps = {},
): Promise<DocusignSmokeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const payload = buildDocusignConnectPayload(options);
  const rawBody = JSON.stringify(payload);
  const validSignature = signDocusignPayload(rawBody, options.hmacSecret);
  const invalidSignature = signDocusignPayload(rawBody, `${options.hmacSecret}:invalid`);

  const checks: SmokeCheck[] = [];
  const invalid = await postPayload({ options, rawBody, signature: invalidSignature, fetchImpl });
  checks.push(checkResult(
    'invalid_hmac_rejected',
    invalid,
    invalid.status === 401 && codeFromBody(invalid.body) === 'invalid_signature',
    'Tampered signature must be rejected before payload processing.',
  ));

  if (options.mode === 'orphan') {
    const orphan = await postPayload({ options, rawBody, signature: validSignature, fetchImpl });
    checks.push(checkResult(
      'signed_unknown_account_orphaned',
      orphan,
      orphan.status === 200 && codeFromBody(orphan.body) === 'orphaned',
      'Signed payload for an unknown account must be acknowledged without processing.',
    ));
    checks.push({
      name: 'duplicate_delivery_deduped',
      status: 'skip',
      detail: 'Duplicate-path smoke requires a connected sandbox account; orphaned accounts return before nonce insert.',
    });
  } else {
    const accepted = await postPayload({ options, rawBody, signature: validSignature, fetchImpl });
    checks.push(checkResult(
      'signed_known_account_accepted',
      accepted,
      accepted.status === 202 && codeFromBody(accepted.body) === 'ok',
      'Signed payload for a connected sandbox account should enqueue one rule event and one retryable job.',
    ));
    const duplicate = await postPayload({ options, rawBody, signature: validSignature, fetchImpl });
    checks.push(checkResult(
      'duplicate_delivery_deduped',
      duplicate,
      duplicate.status === 200 && codeFromBody(duplicate.body) === 'duplicate',
      'Replaying the exact same signed payload should be idempotently acknowledged as duplicate.',
    ));
  }

  return {
    ok: checks.every((check) => check.status !== 'fail'),
    worker_url: options.workerUrl,
    mode: options.mode,
    envelope_id: options.envelopeId,
    event_id: options.eventId,
    account_id_sha256: sha256Hex(options.accountId),
    checks,
  };
}

function usage(): string {
  return `
DocuSign Connect smoke

Safe orphan smoke:
  DOCUSIGN_CONNECT_HMAC_SECRET=... WORKER_URL=https://... npm run smoke:docusign -- --mode=orphan

Accepted + duplicate smoke, only for a connected sandbox account:
  DOCUSIGN_CONNECT_HMAC_SECRET=... WORKER_URL=https://... npm run smoke:docusign -- --mode=accepted-duplicate --account-id=<docusign-account-id> --allow-processing
`.trim();
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(usage());
    return;
  }

  const options = parseArgs(process.argv.slice(2));
  const result = await runDocusignConnectSmoke(options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
