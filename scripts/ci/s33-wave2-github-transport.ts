#!/usr/bin/env tsx
/** Strict GitHub transport extraction/live-identity check for Wave-2 acceptance. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStrictJsonDocument } from '../../services/worker/src/ai/eval/s33-batch-acceptance.js';
import { writeS33Wave2Evidence } from './s33-wave2-batch-acceptance.js';

type JsonRecord = Record<string, unknown>;

export const S33_WAVE2_ACCEPTANCE_COMMENT_MARKER = '<!-- arkova-s33-wave2-authenticated-acceptance:v1 -->';

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function canonicalTimestamp(value: unknown, label: string): string {
  const source = text(value, label);
  const parsed = new Date(source);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be an ISO UTC timestamp`);
  return parsed.toISOString();
}

/** Extract one envelope; prose or a second marker/fence fails closed. */
export function extractS33Wave2AcceptanceEnvelopeFromBody(body: string): unknown {
  if (Buffer.byteLength(body, 'utf8') > 2 * 1024 * 1024) throw new Error('Wave-2 acceptance transport body is too large');
  const markerCount = body.split(S33_WAVE2_ACCEPTANCE_COMMENT_MARKER).length - 1;
  if (markerCount !== 1) throw new Error('Wave-2 acceptance body must contain exactly one versioned marker');
  const afterMarker = body.slice(body.indexOf(S33_WAVE2_ACCEPTANCE_COMMENT_MARKER)
    + S33_WAVE2_ACCEPTANCE_COMMENT_MARKER.length);
  const match = /^\s*```json\r?\n([\s\S]+?)\r?\n```\s*$/u.exec(afterMarker);
  if (!match) throw new Error('Wave-2 acceptance marker must be followed by exactly one JSON code fence');
  return parseStrictJsonDocument(match[1], 'Wave-2 GitHub acceptance transport').parsed;
}

interface SignedTransport {
  repositoryIdentity: 'carson-see/ArkovaCarson';
  pullRequestNumber: number;
  transport: 'github-issue-comment' | 'github-formal-review';
  evidence: {
    id: number;
    nodeId: string | null;
    url: string;
    submittedAtUtc: string;
    actor: { login: string; databaseId: number; nodeId: string };
  };
}

function signedTransport(value: unknown): SignedTransport {
  const envelope = record(value, 'Wave-2 acceptance envelope');
  const payload = record(envelope.payload, 'Wave-2 acceptance payload');
  const reviewer = record(payload.reviewer, 'Wave-2 acceptance reviewer');
  const evidence = record(reviewer.evidence, 'Wave-2 transport evidence');
  const actor = record(evidence.actor, 'Wave-2 transport actor');
  if (payload.repositoryIdentity !== 'carson-see/ArkovaCarson'
    || !['github-issue-comment', 'github-formal-review'].includes(reviewer.transport as string)) {
    throw new Error('Wave-2 acceptance transport repository/kind is invalid');
  }
  const nodeId = evidence.nodeId === null ? null : text(evidence.nodeId, 'Wave-2 transport node id');
  return {
    repositoryIdentity: 'carson-see/ArkovaCarson',
    pullRequestNumber: positiveInteger(payload.pullRequestNumber, 'Wave-2 transport PR number'),
    transport: reviewer.transport as SignedTransport['transport'],
    evidence: {
      id: positiveInteger(evidence.id, 'Wave-2 transport stable id'),
      nodeId,
      url: text(evidence.url, 'Wave-2 transport URL'),
      submittedAtUtc: canonicalTimestamp(evidence.submittedAtUtc, 'Wave-2 transport submitted timestamp'),
      actor: {
        login: text(actor.login, 'Wave-2 transport actor login'),
        databaseId: positiveInteger(actor.databaseId, 'Wave-2 transport actor database id'),
        nodeId: text(actor.nodeId, 'Wave-2 transport actor node id'),
      },
    },
  };
}

function liveActor(value: unknown): SignedTransport['evidence']['actor'] {
  const actor = record(value, 'Live GitHub transport actor');
  return {
    login: text(actor.login, 'Live GitHub actor login'),
    databaseId: positiveInteger(actor.id, 'Live GitHub actor database id'),
    nodeId: text(actor.node_id, 'Live GitHub actor node id'),
  };
}

/**
 * Confirm the signature-bound transport record against the live GitHub API.
 * Review state and account distinctness are intentionally irrelevant.
 */
export function verifyS33Wave2GitHubTransportEvidence(
  authenticatedAcceptance: unknown,
  liveGitHubEvidence: unknown,
  expectedPullRequestNumber: number,
): Readonly<{
  transport: SignedTransport['transport'];
  id: number;
  nodeId: string | null;
  url: string;
  submittedAtUtc: string;
  actor: SignedTransport['evidence']['actor'];
}> {
  const signed = signedTransport(authenticatedAcceptance);
  if (signed.pullRequestNumber !== expectedPullRequestNumber) {
    throw new Error('Wave-2 signed transport PR does not match the workflow PR');
  }
  const live = record(liveGitHubEvidence, 'Live GitHub transport evidence');
  const liveTimestamp = signed.transport === 'github-issue-comment' ? live.created_at : live.submitted_at;
  const normalized = {
    id: positiveInteger(live.id, 'Live GitHub transport id'),
    nodeId: text(live.node_id, 'Live GitHub transport node id'),
    url: text(live.html_url, 'Live GitHub transport URL'),
    submittedAtUtc: canonicalTimestamp(liveTimestamp, 'Live GitHub transport timestamp'),
    actor: liveActor(live.user),
  };
  const nodeMatches = signed.evidence.nodeId === null || signed.evidence.nodeId === normalized.nodeId;
  if (signed.evidence.id !== normalized.id || !nodeMatches || signed.evidence.url !== normalized.url
    || signed.evidence.submittedAtUtc !== normalized.submittedAtUtc
    || signed.evidence.actor.login !== normalized.actor.login
    || signed.evidence.actor.databaseId !== normalized.actor.databaseId
    || signed.evidence.actor.nodeId !== normalized.actor.nodeId) {
    throw new Error('Wave-2 signed transport does not match live GitHub transport evidence');
  }
  return Object.freeze({
    transport: signed.transport,
    id: normalized.id,
    nodeId: signed.evidence.nodeId,
    url: normalized.url,
    submittedAtUtc: normalized.submittedAtUtc,
    actor: Object.freeze(normalized.actor),
  });
}

function usage(): never {
  throw new Error([
    'Usage:',
    '  s33-wave2-github-transport.ts extract --body FILE --output FILE',
    '  s33-wave2-github-transport.ts verify --acceptance FILE --github-evidence FILE --pull-request-number NUMBER --output FILE',
  ].join('\n'));
}

function options(argv: readonly string[]): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--') || result.has(name)) usage();
    result.set(name, value);
  }
  return result;
}

function required(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) usage();
  return value;
}

export function runS33Wave2GitHubTransportCli(argv: readonly string[]): unknown {
  const command = argv[0];
  const values = options(argv.slice(1));
  const output = required(values, '--output');
  if (command === 'extract') {
    const envelope = extractS33Wave2AcceptanceEnvelopeFromBody(readFileSync(required(values, '--body'), 'utf8'));
    writeS33Wave2Evidence(output, envelope);
    return envelope;
  }
  if (command === 'verify') {
    const acceptance = parseStrictJsonDocument(
      readFileSync(required(values, '--acceptance')),
      'Wave-2 authenticated acceptance',
    ).parsed;
    const githubEvidence = parseStrictJsonDocument(
      readFileSync(required(values, '--github-evidence')),
      'Wave-2 live GitHub evidence',
    ).parsed;
    const pullRequestNumber = Number(required(values, '--pull-request-number'));
    const result = verifyS33Wave2GitHubTransportEvidence(acceptance, githubEvidence, pullRequestNumber);
    writeS33Wave2Evidence(output, result);
    return result;
  }
  return usage();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = runS33Wave2GitHubTransportCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
