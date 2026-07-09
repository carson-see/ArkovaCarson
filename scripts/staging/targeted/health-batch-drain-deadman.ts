#!/usr/bin/env -S npx tsx
/**
 * Targeted staging driver for PR #1461 batch-drain dead-man /health behavior.
 *
 * Read-only: GET /health?detailed=true against a tag-routed staging worker and
 * assert the actual JSON fields added by the dead-man switch. This is not a
 * soak runner and intentionally refuses shared/main staging via
 * resolveStagingApiBase().
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { resolveStagingApiBase } from '../load-harness-env';

export type AnchoringStatus = 'ok' | 'warning';
export type BatchDrainReason = 'ok' | 'backlog_aged' | 'batch_stale' | 'backlog_age_unknown';

export interface BatchDrainHealthExpectations {
  anchoringStatus?: AnchoringStatus;
  drainStalled?: boolean;
  drainReason?: BatchDrainReason;
  pendingCount?: number;
}

export interface BatchDrainHealthSnapshot {
  status: AnchoringStatus;
  drainStalled: boolean;
  drainReason: BatchDrainReason;
  pendingCount: number | null;
  lastBatchAt: string | null;
}

const ANCHORING_STATUSES = new Set<AnchoringStatus>(['ok', 'warning']);
const DRAIN_REASONS = new Set<BatchDrainReason>([
  'ok',
  'backlog_aged',
  'batch_stale',
  'backlog_age_unknown',
]);

const SAFE_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(message);
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') fail(`Expected checks.anchoring.${key} to be a string.`);
  return value;
}

function readNullableStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string') fail(`Expected checks.anchoring.${key} to be a string or null.`);
  return value;
}

function readBooleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') fail(`Expected checks.anchoring.${key} to be a boolean.`);
  return value;
}

function readNullableNumberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`Expected checks.anchoring.${key} to be a finite number or null.`);
  }
  return value;
}

function parseAnchoringStatus(value: string): AnchoringStatus {
  if (ANCHORING_STATUSES.has(value as AnchoringStatus)) return value as AnchoringStatus;
  fail(`Expected checks.anchoring.status to be ok|warning, received ${value}.`);
}

function parseDrainReason(value: string): BatchDrainReason {
  if (DRAIN_REASONS.has(value as BatchDrainReason)) return value as BatchDrainReason;
  fail(`Expected checks.anchoring.drainReason to be one of ${[...DRAIN_REASONS].join('|')}, received ${value}.`);
}

function assertEqual<T>(name: string, actual: T, expected: T | undefined): void {
  if (expected !== undefined && actual !== expected) {
    fail(`Expected ${name}=${String(expected)}, received ${String(actual)}.`);
  }
}

export function buildDetailedHealthUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, '')}/health?detailed=true`;
}

export function assertBatchDrainHealthPayload(
  payload: unknown,
  expectations: BatchDrainHealthExpectations = {},
): BatchDrainHealthSnapshot {
  if (!isRecord(payload)) fail('Expected /health?detailed=true response body to be a JSON object.');
  if (!isRecord(payload.checks)) fail('Expected /health?detailed=true response to include checks object.');
  if (!isRecord(payload.checks.anchoring)) {
    fail('Expected /health?detailed=true response to include detailed checks.anchoring object.');
  }

  const anchoring = payload.checks.anchoring;
  const snapshot: BatchDrainHealthSnapshot = {
    status: parseAnchoringStatus(readStringField(anchoring, 'status')),
    drainStalled: readBooleanField(anchoring, 'drainStalled'),
    drainReason: parseDrainReason(readStringField(anchoring, 'drainReason')),
    pendingCount: readNullableNumberField(anchoring, 'pendingCount'),
    lastBatchAt: readNullableStringField(anchoring, 'lastBatchAt'),
  };

  assertEqual('checks.anchoring.status', snapshot.status, expectations.anchoringStatus);
  assertEqual('checks.anchoring.drainStalled', snapshot.drainStalled, expectations.drainStalled);
  assertEqual('checks.anchoring.drainReason', snapshot.drainReason, expectations.drainReason);
  assertEqual('checks.anchoring.pendingCount', snapshot.pendingCount, expectations.pendingCount);

  return snapshot;
}

function parseExpectedStatus(value: string | undefined): AnchoringStatus | undefined {
  if (value === undefined) return undefined;
  return parseAnchoringStatus(value);
}

function parseExpectedReason(value: string | undefined): BatchDrainReason | undefined {
  if (value === undefined) return undefined;
  return parseDrainReason(value);
}

function parseExpectedBoolean(value: string | undefined, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  fail(`${label} must be true or false.`);
}

function parseExpectedNumber(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) fail(`${label} must be a non-negative integer.`);
  return parsed;
}

function resolveGcloudPath(): string {
  try {
    return execFileSync('/usr/bin/which', ['gcloud'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: SAFE_PATH },
    }).trim(); // NOSONAR S4036 — absolute which path plus constrained PATH for operator tooling.
  } catch {
    return '/usr/local/bin/gcloud';
  }
}

function fetchIamToken(): string {
  const envToken = process.env.STAGING_GCP_IDENTITY?.trim();
  if (envToken) return envToken;
  return execFileSync(resolveGcloudPath(), ['auth', 'print-identity-token'], { encoding: 'utf8' }).trim();
}

async function fetchHealthPayload(apiBase: string): Promise<unknown> {
  const url = buildDetailedHealthUrl(apiBase);
  const headers = new Headers({ Authorization: `Bearer ${fetchIamToken()}` });
  const response = await fetch(url, { headers });
  const text = await response.text();
  if (!response.ok) {
    fail(`GET ${url} failed with HTTP ${response.status}.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail(`GET ${url} did not return JSON.`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'api-base': { type: 'string' },
      'expect-anchoring-status': { type: 'string' },
      'expect-drain-stalled': { type: 'string' },
      'expect-drain-reason': { type: 'string' },
      'expect-pending-count': { type: 'string' },
    },
  });

  try {
    const expectations: BatchDrainHealthExpectations = {
      anchoringStatus: parseExpectedStatus(values['expect-anchoring-status']),
      drainStalled: parseExpectedBoolean(values['expect-drain-stalled'], '--expect-drain-stalled'),
      drainReason: parseExpectedReason(values['expect-drain-reason']),
      pendingCount: parseExpectedNumber(values['expect-pending-count'], '--expect-pending-count'),
    };

    const payload = await fetchHealthPayload(
      resolveStagingApiBase({
        STAGING_API_BASE: values['api-base'] ?? process.env.STAGING_API_BASE,
      }),
    );
    const snapshot = assertBatchDrainHealthPayload(payload, expectations);

    console.log(JSON.stringify({ ok: true, snapshot }, null, 2));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
