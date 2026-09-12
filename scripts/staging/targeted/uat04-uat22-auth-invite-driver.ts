#!/usr/bin/env -S npx tsx
/**
 * Dedicated T3 driver for UAT-04 mandatory human MFA and UAT-22 selected-org
 * platform administration. Importing this module is pure. A live run requires
 * both --execute and --live-email; all recipients are provider-owned Resend
 * test addresses, and the long phase performs GET/auth checks only.
 */

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { writeEvidenceFile } from './runtime.js';

export const RIG_ID = 'uat04-22-0911';
const PROD_REF = 'vzwyaatejekddvltxyye';
const SHARED_REFS = new Set(['fizyjojbebyalirtjjht', 'ujtlwnoqfhtitcmsnrpq']);
const STANDING_REF = 'fizyjojbebyalirtjjht';
const STANDING_SERVICE = 'arkova-worker-staging';
const STANDING_WORKER_URL = 'https://arkova-worker-staging-kvojbeutfa-uc.a.run.app';
const STANDING_SERVICE_UID = 'a8e256d2-a5f9-41be-b880-8b85c4382bd3';
const STANDING_PROJECT = 'arkova1';
const STANDING_REGION = 'us-central1';
const STANDING_PRS = [2825, 2831, 2832] as const;
const EXPECTED_SERVICE = `arkova-worker-${RIG_ID}-staging`;
const LEASE_MS = 72 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;

export const APPROVED_RECIPIENTS = Object.freeze({
  existing: `delivered+${RIG_ID}-existing@resend.dev`,
  fresh: `delivered+${RIG_ID}-new@resend.dev`,
  already: `delivered+${RIG_ID}-already@resend.dev`,
  provision: `delivered+${RIG_ID}-provision@resend.dev`,
});

const EXPECTED_CATALOG = Object.freeze({
  triggers: [
    ['aa_enroll_oauth_email_confirmation', 'O', 'CREATE TRIGGER aa_enroll_oauth_email_confirmation AFTER INSERT OR UPDATE OF raw_app_meta_data ON auth.users FOR EACH ROW EXECUTE FUNCTION private.enroll_oauth_email_confirmation()'],
    ['on_auth_user_created', 'O', 'CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION create_profile_for_new_user()'],
    ['zz_auth_user_auto_associate_org', 'O', 'CREATE TRIGGER zz_auth_user_auto_associate_org AFTER INSERT OR UPDATE OF email_confirmed_at, email ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_auth_user_email_verified_org_join()'],
  ],
  functions: [
    ['create_profile_for_new_user', 'e12af1a4fe1b83ac6c44b072a9385316'],
    ['handle_auth_user_email_verified_org_join', 'f4df7fbebb1b4310fe0bf3e3b1e83eaa'],
  ],
  buckets: [['exports', false], ['org-logos', true]],
  policies: [
    ['mfa_verified_authenticated', 'ALL', false, ['authenticated'], 'private.is_human_mfa_verified()', 'private.is_human_mfa_verified()'],
    ['org_logos_admin_delete', 'DELETE', true, ['public'], "((bucket_id = 'org-logos'::text) AND (EXISTS ( SELECT 1\n   FROM (org_members om\n     JOIN profiles p ON ((p.id = om.user_id)))\n  WHERE ((om.user_id = auth.uid()) AND ((om.org_id)::text = (storage.foldername(objects.name))[1]) AND ((p.role = 'ORG_ADMIN'::user_role) OR (om.role = ANY (ARRAY['owner'::org_member_role, 'admin'::org_member_role])))))))", null],
    ['org_logos_admin_insert', 'INSERT', true, ['public'], null, "((bucket_id = 'org-logos'::text) AND (EXISTS ( SELECT 1\n   FROM (org_members om\n     JOIN profiles p ON ((p.id = om.user_id)))\n  WHERE ((om.user_id = auth.uid()) AND ((om.org_id)::text = (storage.foldername(objects.name))[1]) AND ((p.role = 'ORG_ADMIN'::user_role) OR (om.role = ANY (ARRAY['owner'::org_member_role, 'admin'::org_member_role])))))))"],
    ['org_logos_admin_update', 'UPDATE', true, ['public'], "((bucket_id = 'org-logos'::text) AND (EXISTS ( SELECT 1\n   FROM (org_members om\n     JOIN profiles p ON ((p.id = om.user_id)))\n  WHERE ((om.user_id = auth.uid()) AND ((om.org_id)::text = (storage.foldername(objects.name))[1]) AND ((p.role = 'ORG_ADMIN'::user_role) OR (om.role = ANY (ARRAY['owner'::org_member_role, 'admin'::org_member_role])))))))", null],
    ['org_logos_public_read', 'SELECT', true, ['public'], "(bucket_id = 'org-logos'::text)", null],
  ],
});

export const EXPECTED_CATALOG_SHA256 = createHash('sha256')
  .update(JSON.stringify(EXPECTED_CATALOG))
  .digest('hex');

interface BaseAdmissionManifest {
  schemaVersion: 1;
  rigId: typeof RIG_ID;
  sourceHead: string;
  supabaseProjectRef: string;
  supabaseUrl: string;
  cloudRunService: string;
  workerUrl: string;
  createdAt: string;
  destroyBy: string;
  bootstrapCatalogSha256: string;
}

export interface IsolatedAdmissionManifest extends BaseAdmissionManifest {
  admissionMode?: 'isolated';
  cloudRunService: typeof EXPECTED_SERVICE;
}

export interface StandingLeaseMember {
  prNumber: 2825 | 2831 | 2832;
  sourceHead: string;
  reason: string;
  acquiredBy: string;
  acquiredAt: string;
}

export interface StandingAdmissionManifest extends BaseAdmissionManifest {
  admissionMode: 'exclusive-standing-mirror';
  runId: string;
  baselineSourceHead: string;
  sourceMembership: StandingLeaseMember[];
  acceptedBaseline149Sha256: string;
  expectedRcMigrationCount: number;
  expectedRcLedgerSha256: string;
  historicalLeaseSha256: string;
  standingService: {
    projectId: typeof STANDING_PROJECT;
    region: typeof STANDING_REGION;
    uid: typeof STANDING_SERVICE_UID;
    generation: number;
    revision: string;
    imageDigest: string;
    configurationSha256: string;
  };
}

export type AdmissionManifest = IsolatedAdmissionManifest | StandingAdmissionManifest;

export interface StandingObservation {
  ledgerCount: number;
  baselineCount: number;
  leaseCount: number;
  baseline149Sha256: string;
  ledgerSha256: string;
  historicalLeaseSha256: string;
  leaseRows: Array<{
    pr_number: number;
    reason: string | null;
    acquired_by: string | null;
    acquired_at: string;
  }>;
  service: {
    uid: string;
    generation: number;
    revision: string;
    imageDigest: string;
    configurationSha256: string;
    trafficRevision: string;
    trafficPercent: number;
  };
}

export interface UatArgs {
  manifestPath: string;
  manifestSha256?: string;
  evidenceOut?: string;
  durationMin: number;
  intervalSec: number;
  execute: boolean;
  liveEmail: boolean;
}

type JsonObject = Record<string, unknown>;

export interface LongProbe {
  label: string;
  method: 'GET';
  path: string;
}

interface CheckResult {
  label: string;
  passed: boolean;
  status?: number;
  code?: string;
  at: string;
}

interface Evidence {
  schemaVersion: 1;
  driver: 'uat04-uat22-auth-invite';
  rigId: typeof RIG_ID;
  sourceHead: string;
  admissionMode: 'isolated' | 'exclusive-standing-mirror';
  runId: string | null;
  manifestSha256: string | null;
  supabaseProjectRef: string;
  cloudRunService: string;
  workerUrl: string;
  createdAt: string;
  destroyBy: string;
  startedAt: string;
  endedAt: string;
  driverWindowComplete: boolean;
  cleanedUp: boolean;
  liveEmail: boolean;
  approvedRecipients: string[];
  checks: CheckResult[];
  allChecksPassed: boolean;
  workerUptime: WorkerUptimeObservation | null;
  releaseQualification: 'not_assessed';
  prerequisitesNotProvenByDriver: string[];
}

interface Runtime {
  manifest: AdmissionManifest;
  args: UatArgs;
  anonKey: string;
  serviceKey: string;
  managementToken: string;
  checks: CheckResult[];
  secrets: Set<string>;
  userIds: Set<string>;
  userEmails: Set<string>;
  orgIds: Set<string>;
  orgNames: Set<string>;
  invitationIds: Set<string>;
  startedAt: number;
  password: string;
  selectedOrgId: string;
  homeOrgId: string;
  existingUserId: string;
  adminSession: HumanSession | null;
  expectedEmailConfigured: boolean;
  workerUptime: WorkerUptimeObservation | null;
  managementQueryOverride?: (query: string) => Promise<unknown[]>;
  hostedAuthSimulated?: boolean;
  rateLimitWaitOverride?: (waitMs: number) => Promise<void>;
  standingObservationOverride?: () => Promise<StandingObservation>;
}

interface HumanSession {
  userId: string;
  email: string;
  factorId: string;
  totpSecret: string;
  aal1: string;
  aal2: string;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface WorkerUptimeObservation {
  bootEarliestMs: number;
  bootLatestMs: number;
  firstUptimeSeconds: number;
  lastUptimeSeconds: number;
  lastReceivedAt: number;
  samples: number;
}

/** A common process start must fit every response's request/response interval. */
export function observeWorkerUptime(
  previous: WorkerUptimeObservation | null,
  uptime: unknown,
  requestedAt: number,
  receivedAt: number,
): WorkerUptimeObservation {
  if (typeof uptime !== 'number' || !Number.isSafeInteger(uptime) || uptime < 0
      || !Number.isFinite(requestedAt) || !Number.isFinite(receivedAt) || receivedAt < requestedAt) {
    throw new Error('invalid_worker_uptime');
  }
  // The worker rounds process.uptime() down to whole seconds. Its sampling
  // instant is between our request and response; retain that uncertainty.
  const bootEarliestMs = Math.max(previous?.bootEarliestMs ?? -Infinity, requestedAt - (uptime + 1) * 1000);
  const bootLatestMs = Math.min(previous?.bootLatestMs ?? Infinity, receivedAt - uptime * 1000);
  if (bootEarliestMs > bootLatestMs || (previous
      && (uptime < previous.lastUptimeSeconds || requestedAt < previous.lastReceivedAt))) {
    throw new Error('worker_uptime_discontinuity');
  }
  return {
    bootEarliestMs, bootLatestMs,
    firstUptimeSeconds: previous?.firstUptimeSeconds ?? uptime,
    lastUptimeSeconds: uptime,
    lastReceivedAt: receivedAt,
    samples: (previous?.samples ?? 0) + 1,
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function asUrl(value: unknown, name: string): URL {
  try {
    return new URL(requireString(value, name));
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
}

function requireSha(value: unknown, name: string, length: 40 | 64): string {
  const sha = requireString(value, name);
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(sha) || /^([0-9a-f])\1+$/.test(sha)) {
    throw new Error(`${name} must be a non-placeholder lowercase ${length === 40 ? 'Git SHA' : 'SHA-256'}`);
  }
  return sha;
}

function leaseWindow(value: JsonObject, now: number): { createdAt: string; destroyBy: string } {
  const createdAt = requireString(value.createdAt, 'createdAt');
  const destroyBy = requireString(value.destroyBy, 'destroyBy');
  const createdMs = Date.parse(createdAt);
  const destroyMs = Date.parse(destroyBy);
  if (!Number.isFinite(createdMs) || !Number.isFinite(destroyMs)) throw new Error('Lease timestamps must be valid ISO dates');
  if (createdMs > now) throw new Error('Resource lease cannot start in the future');
  if (destroyMs - createdMs !== LEASE_MS) throw new Error('Resource lease must be exactly 72 hours');
  if (now >= destroyMs) throw new Error('Resource lease is expired');
  return { createdAt: new Date(createdMs).toISOString(), destroyBy: new Date(destroyMs).toISOString() };
}

function validateStandingManifest(value: JsonObject, now: number): StandingAdmissionManifest {
  const sourceHead = requireSha(value.sourceHead, 'sourceHead', 40);
  if (value.supabaseProjectRef !== STANDING_REF) throw new Error(`standing mode requires project ${STANDING_REF}`);
  if (value.supabaseUrl !== `https://${STANDING_REF}.supabase.co`) throw new Error('standing Supabase URL is not bound to its project');
  if (value.cloudRunService !== STANDING_SERVICE || value.workerUrl !== STANDING_WORKER_URL) {
    throw new Error('standing worker identity does not match the admitted service');
  }
  if (value.bootstrapCatalogSha256 !== EXPECTED_CATALOG_SHA256) throw new Error('bootstrap catalog identity does not match this driver');
  const { createdAt, destroyBy } = leaseWindow(value, now);
  const runId = requireString(value.runId, 'runId');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    throw new Error('runId must be a UUID');
  }
  const baselineSourceHead = requireSha(value.baselineSourceHead, 'baselineSourceHead', 40);
  if (!Array.isArray(value.sourceMembership) || value.sourceMembership.length !== STANDING_PRS.length) {
    throw new Error('sourceMembership must contain exactly PRs 2825, 2831, and 2832');
  }
  const sourceMembership = value.sourceMembership.map((raw, index) => {
    if (!isObject(raw) || raw.prNumber !== STANDING_PRS[index]) throw new Error('sourceMembership must be ordered 2825, 2831, 2832');
    const sourceMemberHead = requireSha(raw.sourceHead, `sourceMembership[${index}].sourceHead`, 40);
    const reason = requireString(raw.reason, `sourceMembership[${index}].reason`);
    const acquiredBy = requireString(raw.acquiredBy, `sourceMembership[${index}].acquiredBy`);
    const acquiredAt = requireString(raw.acquiredAt, `sourceMembership[${index}].acquiredAt`);
    if (!Number.isFinite(Date.parse(acquiredAt))) throw new Error(`sourceMembership[${index}].acquiredAt must be an ISO date`);
    for (const binding of [`run=${runId}`, `starts=${createdAt}`, `expires=${destroyBy}`, `combined=${sourceHead}`, `pr=${raw.prNumber}`, `head=${sourceMemberHead}`]) {
      if (!reason.includes(binding)) throw new Error(`sourceMembership[${index}].reason is not target-bound`);
    }
    const acquiredMs = Date.parse(acquiredAt);
    if (acquiredMs < Date.parse(createdAt) || acquiredMs >= Date.parse(destroyBy)) throw new Error(`sourceMembership[${index}].acquiredAt is outside the run lease`);
    return { prNumber: raw.prNumber, sourceHead: sourceMemberHead, reason, acquiredBy, acquiredAt: new Date(acquiredMs).toISOString() } as StandingLeaseMember;
  });
  const expectedRcMigrationCount = value.expectedRcMigrationCount;
  if (!Number.isSafeInteger(expectedRcMigrationCount) || (expectedRcMigrationCount as number) <= 149) {
    throw new Error('expectedRcMigrationCount must be a manifest-supplied integer greater than baseline 149');
  }
  if (!isObject(value.standingService)) throw new Error('standingService is required');
  const standingService = value.standingService;
  if (standingService.projectId !== STANDING_PROJECT || standingService.region !== STANDING_REGION
      || standingService.uid !== STANDING_SERVICE_UID) throw new Error('standingService identity mismatch');
  if (!Number.isSafeInteger(standingService.generation) || (standingService.generation as number) < 1) throw new Error('standingService.generation is invalid');
  const revision = requireString(standingService.revision, 'standingService.revision');
  if (!revision.startsWith(`${STANDING_SERVICE}-`)) throw new Error('standingService.revision is invalid');
  const imageDigest = requireString(standingService.imageDigest, 'standingService.imageDigest');
  if (!/^(?:[a-z0-9._/:-]+@)?sha256:[0-9a-f]{64}$/.test(imageDigest)
      || /sha256:([0-9a-f])\1+$/.test(imageDigest)) throw new Error('standingService.imageDigest is invalid');
  return {
    schemaVersion: 1, admissionMode: 'exclusive-standing-mirror', rigId: RIG_ID,
    sourceHead, supabaseProjectRef: STANDING_REF, supabaseUrl: `https://${STANDING_REF}.supabase.co`,
    cloudRunService: STANDING_SERVICE, workerUrl: STANDING_WORKER_URL, createdAt, destroyBy,
    bootstrapCatalogSha256: EXPECTED_CATALOG_SHA256, runId, baselineSourceHead, sourceMembership,
    acceptedBaseline149Sha256: requireSha(value.acceptedBaseline149Sha256, 'acceptedBaseline149Sha256', 64),
    expectedRcMigrationCount: expectedRcMigrationCount as number,
    expectedRcLedgerSha256: requireSha(value.expectedRcLedgerSha256, 'expectedRcLedgerSha256', 64),
    historicalLeaseSha256: requireSha(value.historicalLeaseSha256, 'historicalLeaseSha256', 64),
    standingService: {
      projectId: STANDING_PROJECT, region: STANDING_REGION, uid: STANDING_SERVICE_UID,
      generation: standingService.generation as number, revision, imageDigest,
      configurationSha256: requireSha(standingService.configurationSha256, 'standingService.configurationSha256', 64),
    },
  };
}

export function validateManifest(value: unknown, now = Date.now()): AdmissionManifest {
  if (!isObject(value)) throw new Error('Admission manifest must be an object');
  if (value.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
  if (value.rigId !== RIG_ID) throw new Error(`rigId must be ${RIG_ID}`);
  if (value.admissionMode === 'exclusive-standing-mirror') return validateStandingManifest(value, now);
  if (value.admissionMode !== undefined && value.admissionMode !== 'isolated') throw new Error('unsupported admissionMode');
  const sourceHead = requireString(value.sourceHead, 'sourceHead');
  if (!/^[0-9a-f]{40}$/.test(sourceHead)) throw new Error('sourceHead must be a full lowercase Git SHA');
  const supabaseProjectRef = requireString(value.supabaseProjectRef, 'supabaseProjectRef');
  if (supabaseProjectRef === PROD_REF || SHARED_REFS.has(supabaseProjectRef)) {
    throw new Error('Protected Supabase project refs are forbidden');
  }
  if (!/^[a-z]{20}$/.test(supabaseProjectRef)) throw new Error('supabaseProjectRef must be a hosted project ref');
  const supabaseUrl = asUrl(value.supabaseUrl, 'supabaseUrl');
  if (supabaseUrl.username || supabaseUrl.password) throw new Error('supabaseUrl must not contain credentials');
  if (supabaseUrl.protocol !== 'https:' || supabaseUrl.hostname !== `${supabaseProjectRef}.supabase.co`
      || supabaseUrl.port || supabaseUrl.pathname !== '/' || supabaseUrl.search || supabaseUrl.hash) {
    throw new Error('supabaseUrl is not bound to supabaseProjectRef');
  }
  if (value.cloudRunService !== EXPECTED_SERVICE) throw new Error(`Cloud Run service must be ${EXPECTED_SERVICE}`);
  const workerUrl = asUrl(value.workerUrl, 'workerUrl');
  if (workerUrl.username || workerUrl.password) throw new Error('worker URL must not contain credentials');
  if (workerUrl.protocol !== 'https:' || !workerUrl.hostname.endsWith('.a.run.app')
      || !workerUrl.hostname.startsWith(`${EXPECTED_SERVICE}-`) || workerUrl.port
      || workerUrl.pathname !== '/' || workerUrl.search || workerUrl.hash) {
    throw new Error('worker URL is not bound to the isolated Cloud Run service');
  }
  const { createdAt, destroyBy } = leaseWindow(value, now);
  if (value.bootstrapCatalogSha256 !== EXPECTED_CATALOG_SHA256) {
    throw new Error('bootstrap catalog identity does not match this driver');
  }
  return {
    schemaVersion: 1,
    rigId: RIG_ID,
    sourceHead,
    supabaseProjectRef,
    supabaseUrl: supabaseUrl.origin,
    cloudRunService: EXPECTED_SERVICE,
    workerUrl: workerUrl.origin,
    createdAt,
    destroyBy,
    bootstrapCatalogSha256: EXPECTED_CATALOG_SHA256,
  };
}

export function validateManifestDocument(raw: string, expectedSha256: string | undefined, now = Date.now()): AdmissionManifest {
  if (expectedSha256 !== undefined) {
    const expected = requireSha(expectedSha256, '--manifest-sha256', 64);
    const actual = createHash('sha256').update(raw).digest('hex');
    if (actual !== expected) throw new Error('manifest SHA-256 mismatch');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Admission manifest must be valid JSON'); }
  const manifest = validateManifest(parsed, now);
  if (manifest.admissionMode === 'exclusive-standing-mirror' && expectedSha256 === undefined) {
    throw new Error('--manifest-sha256 is required for standing mode');
  }
  return manifest;
}

export function parseUatArgs(argv: string[]): UatArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      manifest: { type: 'string' },
      'manifest-sha256': { type: 'string' },
      'evidence-out': { type: 'string' },
      duration: { type: 'string' },
      'interval-sec': { type: 'string' },
      execute: { type: 'boolean', default: false },
      'live-email': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const manifestPath = requireString(values.manifest, '--manifest');
  const durationMin = values.duration === undefined ? 2910 : Number(values.duration);
  const intervalSec = values['interval-sec'] === undefined ? 900 : Number(values['interval-sec']);
  if (!Number.isSafeInteger(durationMin) || durationMin < 1 || durationMin > 2910) {
    throw new Error('--duration must be an integer from 1 through 2910 minutes');
  }
  if (!Number.isSafeInteger(intervalSec) || intervalSec < 60 || intervalSec > 3600) {
    throw new Error('--interval-sec must be an integer from 60 through 3600 seconds');
  }
  const execute = values.execute === true;
  const liveEmail = values['live-email'] === true;
  if (execute && !liveEmail) throw new Error('--execute requires explicit --live-email opt-in');
  if (execute && !values['evidence-out']) throw new Error('--execute requires --evidence-out');
  return { manifestPath, manifestSha256: values['manifest-sha256'], evidenceOut: values['evidence-out'], durationMin, intervalSec, execute, liveEmail };
}

const SENSITIVE_KEY = /authorization|token|secret|password|apikey|api_key|signedurl|activation_link/i;

export function redactEvidence(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    return [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)
      .reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactEvidence(item, secrets));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactEvidence(child, secrets),
  ]));
}

export function buildLongProbePlan(orgId: string): LongProbe[] {
  return [
    { label: 'aal2-platform-health', method: 'GET', path: '/api/admin/system-health' },
    { label: 'aal2-selected-org', method: 'GET', path: `/api/admin/organizations/${orgId}` },
    { label: 'aal2-selected-roster', method: 'GET', path: `/api/admin/organizations/${orgId}/members` },
  ];
}

export function boundedRateLimitWait(retryAfter: string | null, now: number, destroyBy: string): number | null {
  const retrySeconds = Number(retryAfter);
  const requestedWait = Number.isFinite(retrySeconds) && retrySeconds > 0 ? retrySeconds * 1000 + 250 : 61_000;
  const remainingLease = Date.parse(destroyBy) - now - REQUEST_TIMEOUT_MS - 1;
  return remainingLease > 0 ? Math.min(requestedWait, 61_000, remainingLease) : null;
}

export function assertWorkerRequestLease(now: number, destroyBy: string): void {
  if (!(Date.parse(destroyBy) - now > REQUEST_TIMEOUT_MS)) throw new Error('worker_request_exceeds_lease');
}

export function isDirectRun(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(new URL(moduleUrl)) === realpathSync(resolve(argv1));
  } catch {
    return false;
  }
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function registerSecret(runtime: Runtime, value: string): string {
  runtime.secrets.add(value);
  return value;
}

function record(runtime: Runtime, label: string, passed: boolean, status?: number, code?: string): void {
  runtime.checks.push({ label, passed, ...(status === undefined ? {} : { status }), ...(code ? { code } : {}), at: new Date().toISOString() });
  if (!passed) throw new Error(`check_failed:${label}`);
}

async function jsonFetch(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const raw = await response.text();
  let body: unknown = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  return { status: response.status, body, headers: response.headers };
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function worker(runtime: Runtime, method: string, path: string, token?: string, body?: unknown) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertWorkerRequestLease(Date.now(), runtime.manifest.destroyBy);
    const result = await jsonFetch(`${runtime.manifest.workerUrl}${path}`, {
      method,
      headers: token ? bearer(token) : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (result.status !== 429 || attempt === 2) return result;
    const waitMs = boundedRateLimitWait(result.headers.get('retry-after'), Date.now(), runtime.manifest.destroyBy);
    if (waitMs === null) return result;
    if (runtime.rateLimitWaitOverride) await runtime.rateLimitWaitOverride(waitMs);
    else await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
  }
  throw new Error('worker_retry_exhausted');
}

function assertFixtureRequestLease(runtime: Runtime, allowTerminalCleanup = false): void {
  if (runtime.manifest.admissionMode === 'exclusive-standing-mirror' && !allowTerminalCleanup) {
    assertWorkerRequestLease(Date.now(), runtime.manifest.destroyBy);
  }
}

async function managementQuery(runtime: Runtime, query: string, allowTerminalCleanup = false): Promise<unknown[]> {
  assertFixtureRequestLease(runtime, allowTerminalCleanup);
  if (runtime.managementQueryOverride) return runtime.managementQueryOverride(query);
  const result = await jsonFetch(
    `https://api.supabase.com/v1/projects/${runtime.manifest.supabaseProjectRef}/database/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${runtime.managementToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    },
  );
  if (result.status !== 200 || !Array.isArray(result.body)) throw new Error('management_query_failed');
  return result.body;
}

/**
 * The admission packet must calculate hashes from the returned arrays using
 * recursively key-sorted compact JSON, UTF-8 bytes, and SHA-256. The baseline
 * excludes the three target RC migrations and must contain exactly 149 rows;
 * the RC digest covers the full expected ledger.
 */
export function standingStateSql(): string {
  return `WITH ordered_ledger AS (
      SELECT version::text AS version, name::text AS name, statements
      FROM supabase_migrations.schema_migrations ORDER BY version
    ), baseline AS (
      SELECT * FROM ordered_ledger WHERE version NOT IN ('0443','0451','0452') ORDER BY version
    ), historical AS (
      SELECT pr_number, reason, acquired_by, acquired_at
      FROM public.staging_lease WHERE pr_number IN (2571,2637,2668) ORDER BY pr_number
    ), rc AS (
      SELECT pr_number, reason, acquired_by, acquired_at
      FROM public.staging_lease WHERE pr_number IN (2825,2831,2832) ORDER BY pr_number
    ) SELECT
      (SELECT count(*)::int FROM ordered_ledger) AS ledger_count,
      (SELECT count(*)::int FROM baseline) AS baseline_count,
      (SELECT count(*)::int FROM public.staging_lease) AS lease_count,
      (SELECT jsonb_agg(to_jsonb(b) ORDER BY version) FROM baseline b) AS baseline_rows,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY version) FROM ordered_ledger l) AS ledger_rows,
      (SELECT jsonb_agg(to_jsonb(h) ORDER BY pr_number) FROM historical h) AS historical_rows,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY pr_number) FROM rc r) AS lease_rows;`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function canonicalEvidenceSha256(value: unknown): string {
  // Matches `jq -cS .`: compact sorted JSON followed by its terminating LF.
  return createHash('sha256').update(`${canonicalJson(value)}\n`).digest('hex');
}

const CLOUD_RUN_CONTROLLER_ANNOTATIONS = new Set([
  'run.googleapis.com/build-id',
  'run.googleapis.com/build-name',
  'run.googleapis.com/build-source-location',
  'run.googleapis.com/client-name',
  'run.googleapis.com/client-version',
  'run.googleapis.com/operation-id',
  'serving.knative.dev/creator',
  'serving.knative.dev/lastModifier',
]);

function stableAnnotations(value: unknown): unknown {
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !CLOUD_RUN_CONTROLLER_ANNOTATIONS.has(key)));
}

function stableServiceSpec(value: JsonObject): JsonObject {
  const copy = structuredClone(value);
  if (isObject(copy.template) && isObject(copy.template.metadata)) {
    copy.template.metadata.annotations = stableAnnotations(copy.template.metadata.annotations);
  }
  return copy;
}

/** Hashes configuration and serving identity while omitting controller clocks, conditions, and resourceVersion. */
export function standingServiceConfigurationSha256(serviceDocument: unknown): string {
  if (!isObject(serviceDocument) || !isObject(serviceDocument.metadata) || !isObject(serviceDocument.spec)) {
    throw new Error('invalid standing Cloud Run service document');
  }
  const metadata = serviceDocument.metadata;
  const stable = {
    apiVersion: serviceDocument.apiVersion,
    kind: serviceDocument.kind,
    metadata: {
      name: metadata.name,
      namespace: metadata.namespace,
      uid: metadata.uid,
      generation: metadata.generation,
      labels: metadata.labels,
      annotations: stableAnnotations(metadata.annotations),
    },
    spec: stableServiceSpec(serviceDocument.spec),
  };
  return createHash('sha256').update(canonicalJson(stable)).digest('hex');
}

async function observeStandingState(runtime: Runtime): Promise<StandingObservation> {
  if (runtime.standingObservationOverride) return runtime.standingObservationOverride();
  const rows = await managementQuery(runtime, standingStateSql());
  const row = isObject(rows[0]) ? rows[0] : {};
  const manifest = runtime.manifest;
  if (manifest.admissionMode !== 'exclusive-standing-mirror') throw new Error('standing observation requested for isolated rig');
  assertFixtureRequestLease(runtime);
  const serviceRaw = execFileSync('gcloud', [
    'run', 'services', 'describe', manifest.cloudRunService,
    '--project', manifest.standingService.projectId, '--region', manifest.standingService.region, '--format=json',
  ], { encoding: 'utf8', timeout: REQUEST_TIMEOUT_MS });
  const serviceDocument: unknown = JSON.parse(serviceRaw);
  if (!isObject(serviceDocument) || !isObject(serviceDocument.metadata) || !isObject(serviceDocument.status)) {
    throw new Error('standing_service_observation_invalid');
  }
  const revision = requireString(serviceDocument.status.latestReadyRevisionName, 'latestReadyRevisionName');
  assertFixtureRequestLease(runtime);
  const revisionRaw = execFileSync('gcloud', [
    'run', 'revisions', 'describe', revision,
    '--project', manifest.standingService.projectId, '--region', manifest.standingService.region, '--format=json',
  ], { encoding: 'utf8', timeout: REQUEST_TIMEOUT_MS });
  const revisionDocument: unknown = JSON.parse(revisionRaw);
  if (!isObject(revisionDocument) || !isObject(revisionDocument.status)) throw new Error('standing_revision_observation_invalid');
  const traffic = Array.isArray(serviceDocument.status.traffic)
    ? serviceDocument.status.traffic.find((item) => isObject(item) && item.revisionName === revision)
    : undefined;
  const leaseRows = Array.isArray(row.lease_rows) ? row.lease_rows : [];
  if (!Array.isArray(row.baseline_rows) || !Array.isArray(row.ledger_rows) || !Array.isArray(row.historical_rows)) {
    throw new Error('standing_ledger_observation_invalid');
  }
  const imageDigest = revisionDocument.status.imageDigest;
  return {
    ledgerCount: Number(row.ledger_count),
    baselineCount: Number(row.baseline_count),
    leaseCount: Number(row.lease_count),
    ledgerSha256: canonicalEvidenceSha256(row.ledger_rows),
    baseline149Sha256: canonicalEvidenceSha256(row.baseline_rows),
    historicalLeaseSha256: canonicalEvidenceSha256(row.historical_rows),
    leaseRows: leaseRows.map((item) => {
      if (!isObject(item)) throw new Error('standing_lease_row_invalid');
      return {
        pr_number: Number(item.pr_number),
        reason: typeof item.reason === 'string' ? item.reason : null,
        acquired_by: typeof item.acquired_by === 'string' ? item.acquired_by : null,
        acquired_at: new Date(requireString(item.acquired_at, 'lease.acquired_at')).toISOString(),
      };
    }),
    service: {
      uid: requireString(serviceDocument.metadata.uid, 'service.uid'),
      generation: Number(serviceDocument.metadata.generation),
      revision,
      imageDigest: requireString(imageDigest, 'revision.imageDigest'),
      configurationSha256: standingServiceConfigurationSha256(serviceDocument),
      trafficRevision: isObject(traffic) ? requireString(traffic.revisionName, 'traffic.revisionName') : '',
      trafficPercent: isObject(traffic) ? Number(traffic.percent) : 0,
    },
  };
}

export function verifyStandingObservation(
  manifest: StandingAdmissionManifest,
  observation: StandingObservation,
  now = Date.now(),
): void {
  assertWorkerRequestLease(now, manifest.destroyBy);
  if (observation.baseline149Sha256 !== manifest.acceptedBaseline149Sha256) throw new Error('standing baseline149 drift');
  if (observation.baselineCount !== 149) throw new Error('standing baseline must contain exactly 149 migrations');
  if (observation.ledgerCount !== manifest.expectedRcMigrationCount
      || observation.ledgerSha256 !== manifest.expectedRcLedgerSha256) throw new Error('standing RC ledger drift');
  if (observation.historicalLeaseSha256 !== manifest.historicalLeaseSha256) throw new Error('standing historical lease drift');
  if (observation.leaseCount !== 6) throw new Error('standing unexpected lease membership');
  const expectedRows = manifest.sourceMembership.map((row) => ({
    pr_number: row.prNumber, reason: row.reason, acquired_by: row.acquiredBy,
    acquired_at: new Date(row.acquiredAt).toISOString(),
  }));
  const observedRows = observation.leaseRows.map((row) => ({
    ...row, acquired_at: new Date(row.acquired_at).toISOString(),
  }));
  if (JSON.stringify(observedRows) !== JSON.stringify(expectedRows)) throw new Error('standing RC lease membership drift');
  const expected = manifest.standingService;
  const actual = observation.service;
  if (actual.uid !== expected.uid || actual.generation !== expected.generation || actual.revision !== expected.revision
      || actual.imageDigest !== expected.imageDigest || actual.configurationSha256 !== expected.configurationSha256
      || actual.trafficRevision !== expected.revision || actual.trafficPercent !== 100) {
    throw new Error('standing service identity/configuration drift');
  }
}

async function verifyStandingTarget(runtime: Runtime): Promise<void> {
  const manifest = runtime.manifest;
  if (manifest.admissionMode !== 'exclusive-standing-mirror') return;
  assertFixtureRequestLease(runtime);
  const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  record(runtime, 'standing-current-source-head', currentHead === manifest.sourceHead);
  const members = [manifest.baselineSourceHead, ...manifest.sourceMembership.map((row) => row.sourceHead)];
  for (const head of members) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', head, manifest.sourceHead], { stdio: 'ignore' });
    } catch {
      record(runtime, 'standing-exact-source-membership', false);
    }
  }
  record(runtime, 'standing-exact-source-membership', true);
  const observation = await observeStandingState(runtime);
  try {
    verifyStandingObservation(manifest, observation);
  } catch {
    record(runtime, 'standing-live-ledger-lease-service-identity', false);
  }
  record(runtime, 'standing-live-ledger-lease-service-identity', true);
}

export function catalogSql(): string {
  return `SELECT jsonb_build_object(
    'triggers', (SELECT jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,
      pg_get_triggerdef(t.oid)) ORDER BY t.tgname)
      FROM pg_trigger t WHERE t.tgrelid='auth.users'::regclass AND NOT t.tgisinternal),
    'functions', (SELECT jsonb_agg(jsonb_build_array(p.proname,md5(pg_get_functiondef(p.oid))) ORDER BY p.proname)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.proname IN ('create_profile_for_new_user','handle_auth_user_email_verified_org_join')),
    'buckets', (SELECT jsonb_agg(jsonb_build_array(id,public) ORDER BY id)
      FROM storage.buckets WHERE id IN ('exports','org-logos')),
    'policies', (SELECT jsonb_agg(jsonb_build_array(p.polname,CASE p.polcmd
        WHEN '*' THEN 'ALL' WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE p.polcmd::text END,
        p.polpermissive, (SELECT jsonb_agg(CASE WHEN role_oid=0 THEN 'public' ELSE pg_get_userbyid(role_oid) END
          ORDER BY CASE WHEN role_oid=0 THEN 'public' ELSE pg_get_userbyid(role_oid) END) FROM unnest(p.polroles) AS roles(role_oid)),
        pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname)
      FROM pg_policy p WHERE p.polrelid='storage.objects'::regclass)
  ) AS catalog`;
}

async function verifyCatalog(runtime: Runtime): Promise<void> {
  const rows = await managementQuery(runtime, catalogSql());
  const catalog = isObject(rows[0]) ? rows[0].catalog : null;
  const matches = isObject(catalog)
    && JSON.stringify(catalog.triggers) === JSON.stringify(EXPECTED_CATALOG.triggers)
    && JSON.stringify(catalog.functions) === JSON.stringify(EXPECTED_CATALOG.functions)
    && JSON.stringify(catalog.buckets) === JSON.stringify(EXPECTED_CATALOG.buckets)
    && JSON.stringify(catalog.policies) === JSON.stringify(EXPECTED_CATALOG.policies);
  record(runtime, 'bootstrap-catalog-identity', matches);
}

async function verifyHostedAuth(runtime: Runtime): Promise<void> {
  if (runtime.hostedAuthSimulated) {
    record(runtime, 'hosted-auth-hook-local-simulation', true, undefined, 'local_simulation');
    return;
  }
  assertFixtureRequestLease(runtime);
  const result = await jsonFetch(
    `https://api.supabase.com/v1/projects/${runtime.manifest.supabaseProjectRef}/config/auth`,
    { headers: { Authorization: `Bearer ${runtime.managementToken}` } },
  );
  const body = isObject(result.body) ? result.body : {};
  record(runtime, 'hosted-auth-hook', result.status === 200
    && body.hook_custom_access_token_enabled === true
    && body.hook_custom_access_token_uri === 'pg-functions://postgres/private/oauth_email_confirmation_token_hook', result.status);
}

function sqlList(values: Iterable<string>): string {
  return [...values].map((value) => `'${value.replaceAll("'", "''")}'`).join(',') || "'00000000-0000-0000-0000-000000000000'";
}

function postgrestIn(field: string, values: Set<string>): string | null {
  return values.size > 0 ? `${field}.in.(${[...values].join(',')})` : null;
}

async function verifyCleanStart(runtime: Runtime): Promise<void> {
  const approved = sqlList(Object.values(APPROVED_RECIPIENTS));
  const rows = await managementQuery(runtime, `SELECT
    (SELECT count(*) FROM auth.users WHERE lower(email) IN (${approved}))::int AS users,
    (SELECT count(*) FROM public.profiles WHERE lower(email) IN (${approved}))::int AS profiles,
    (SELECT count(*) FROM public.invitations WHERE lower(email) IN (${approved}))::int AS invitations,
    (SELECT count(*) FROM public.organizations WHERE display_name LIKE 'UAT0422 %')::int AS organizations`);
  const counts = isObject(rows[0]) ? rows[0] : {};
  record(runtime, 'run-owned-identities-initially-absent',
    ['users', 'profiles', 'invitations', 'organizations'].every((key) => counts[key] === 0));
  for (const email of Object.values(APPROVED_RECIPIENTS)) runtime.userEmails.add(email);
}

function client(runtime: Runtime, key: string, allowTerminalCleanup = false): SupabaseClient {
  return createClient(runtime.manifest.supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        assertFixtureRequestLease(runtime, allowTerminalCleanup);
        return fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      },
    },
  });
}

function service(runtime: Runtime, allowTerminalCleanup = false): SupabaseClient {
  return client(runtime, runtime.serviceKey, allowTerminalCleanup);
}

async function createOrgFixture(runtime: Runtime, label: string): Promise<string> {
  const db = service(runtime);
  const name = `UAT0422 ${label} ${randomUUID()}`;
  runtime.orgNames.add(name);
  const { data, error } = await db.from('organizations').insert({
    display_name: name,
    legal_name: name,
    org_prefix: `U${randomUUID().replaceAll('-', '').slice(0, 15).toUpperCase()}`,
  }).select('id').single();
  if (error || !data?.id) throw new Error('fixture_org_create_failed');
  runtime.orgIds.add(data.id as string);
  return data.id as string;
}

async function waitForProfile(db: SupabaseClient, userId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { data } = await db.from('profiles').select('id').eq('id', userId).maybeSingle();
    if (data) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return false;
}

async function createHuman(runtime: Runtime, email: string): Promise<string> {
  const db = service(runtime);
  runtime.userEmails.add(email.toLowerCase());
  const { data, error } = await db.auth.admin.createUser({ email, password: runtime.password, email_confirm: true });
  if (error || !data.user) throw new Error('fixture_user_create_failed');
  runtime.userIds.add(data.user.id);
  record(runtime, 'real-auth-trigger-created-profile', await waitForProfile(db, data.user.id));
  return data.user.id;
}

async function placeHuman(runtime: Runtime, userId: string, orgId: string, role: 'INDIVIDUAL' | 'ORG_ADMIN' | 'ORG_MEMBER', orgRole: 'member' | 'admin') {
  const db = service(runtime);
  const roleResult = await db.rpc('admin_change_user_role', { p_user_id: userId, p_new_role: role });
  if (roleResult.error) throw new Error('fixture_role_failed');
  const orgResult = await db.rpc('admin_set_user_org', { p_user_id: userId, p_org_id: orgId, p_org_role: orgRole });
  if (orgResult.error) throw new Error('fixture_org_placement_failed');
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function totp(secret: string): string {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

async function enrollHuman(runtime: Runtime, userId: string, email: string): Promise<HumanSession> {
  const human = client(runtime, runtime.anonKey);
  const signed = await human.auth.signInWithPassword({ email, password: runtime.password });
  if (signed.error || !signed.data.session) throw new Error('aal1_signin_failed');
  const aal1 = registerSecret(runtime, signed.data.session.access_token);
  const enrolled = await human.auth.mfa.enroll({ factorType: 'totp' });
  if (enrolled.error || !enrolled.data) throw new Error('mfa_enroll_failed');
  const totpSecret = registerSecret(runtime, enrolled.data.totp.secret);
  const challenged = await human.auth.mfa.challenge({ factorId: enrolled.data.id });
  if (challenged.error || !challenged.data) throw new Error('mfa_challenge_failed');
  const verified = await human.auth.mfa.verify({
    factorId: enrolled.data.id,
    challengeId: challenged.data.id,
    code: totp(enrolled.data.totp.secret),
  });
  if (verified.error || !verified.data) throw new Error('mfa_verify_failed');
  const aal2 = registerSecret(runtime, verified.data.access_token);
  return { userId, email, factorId: enrolled.data.id, totpSecret, aal1, aal2 };
}

async function reauthenticate(runtime: Runtime, session: HumanSession): Promise<{ aal1: string; aal2: string }> {
  const human = client(runtime, runtime.anonKey);
  const signed = await human.auth.signInWithPassword({ email: session.email, password: runtime.password });
  if (signed.error || !signed.data.session) throw new Error('repeat_aal1_signin_failed');
  const aal1 = registerSecret(runtime, signed.data.session.access_token);
  const challenged = await human.auth.mfa.challenge({ factorId: session.factorId });
  if (challenged.error || !challenged.data) throw new Error('repeat_mfa_challenge_failed');
  const verified = await human.auth.mfa.verify({
    factorId: session.factorId,
    challengeId: challenged.data.id,
    code: totp(session.totpSecret),
  });
  if (verified.error || !verified.data) throw new Error('repeat_mfa_verify_failed');
  return { aal1, aal2: registerSecret(runtime, verified.data.access_token) };
}

async function aalBoundary(runtime: Runtime, session: HumanSession, label: string): Promise<void> {
  const aal1Worker = await worker(runtime, 'GET', '/api/admin/system-health', session.aal1);
  record(runtime, `${label}-worker-aal1-denied`, aal1Worker.status === 401, aal1Worker.status);
  assertFixtureRequestLease(runtime);
  const aal1Data = await jsonFetch(`${runtime.manifest.supabaseUrl}/rest/v1/profiles?select=id&id=eq.${session.userId}`, {
    headers: { apikey: runtime.anonKey, Authorization: `Bearer ${session.aal1}` },
  });
  record(runtime, `${label}-postgrest-aal1-denied`, [401, 403].includes(aal1Data.status), aal1Data.status);
  assertFixtureRequestLease(runtime);
  const aal2Data = await jsonFetch(`${runtime.manifest.supabaseUrl}/rest/v1/profiles?select=id&id=eq.${session.userId}`, {
    headers: { apikey: runtime.anonKey, Authorization: `Bearer ${session.aal2}` },
  });
  record(runtime, `${label}-postgrest-aal2-own-profile`, aal2Data.status === 200 && Array.isArray(aal2Data.body) && aal2Data.body.length === 1, aal2Data.status);
}

async function invitationAndProvisioning(runtime: Runtime, admin: HumanSession, ordinary: HumanSession, existing: HumanSession): Promise<void> {
  const db = service(runtime);
  const orgId = runtime.selectedOrgId;
  const selected = await worker(runtime, 'GET', `/api/admin/organizations/${orgId}`, admin.aal2);
  record(runtime, 'selected-org-platform-read', selected.status === 200 && isObject(selected.body)
    && isObject(selected.body.organization) && selected.body.organization.id === orgId, selected.status);

  const ordinaryKey = randomUUID();
  runtime.invitationIds.add(ordinaryKey);
  const ordinaryDenied = await worker(runtime, 'POST', `/api/admin/organizations/${orgId}/invitations`, ordinary.aal2, {
    email: APPROVED_RECIPIENTS.fresh, role: 'INDIVIDUAL', idempotency_key: ordinaryKey,
  });
  record(runtime, 'ordinary-invite-forbidden', ordinaryDenied.status === 403, ordinaryDenied.status);

  const alreadyKey = randomUUID();
  runtime.invitationIds.add(alreadyKey);
  const already = await worker(runtime, 'POST', `/api/admin/organizations/${orgId}/invitations`, admin.aal2, {
    email: APPROVED_RECIPIENTS.already, role: 'ORG_ADMIN', idempotency_key: alreadyKey,
  });
  record(runtime, 'already-member-conflict', already.status === 409 && isObject(already.body) && already.body.code === 'already_member', already.status);

  const invitationId = randomUUID();
  runtime.invitationIds.add(invitationId);
  const inviteBody = { email: APPROVED_RECIPIENTS.existing, role: 'ORG_ADMIN', idempotency_key: invitationId };
  const concurrent = await Promise.all(Array.from({ length: 4 }, () =>
    worker(runtime, 'POST', `/api/admin/organizations/${orgId}/invitations`, admin.aal2, inviteBody)));
  const { count: invitationCount } = await db.from('invitations').select('id', { count: 'exact', head: true }).eq('id', invitationId);
  record(runtime, 'concurrent-invite-single-row', invitationCount === 1
    && concurrent.every((result) => [200, 201].includes(result.status) && isObject(result.body) && result.body.sent === true)
    && concurrent.some((result) => result.status === 201),
  undefined, concurrent.map((result) => result.status).sort().join(','));
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  const replay = await worker(runtime, 'POST', `/api/admin/organizations/${orgId}/invitations`, admin.aal2, inviteBody);
  record(runtime, 'same-intent-invite-replay', replay.status === 200 && isObject(replay.body)
    && replay.body.replayed === true && replay.body.sent === true, replay.status);
  const mismatch = await worker(runtime, 'POST', `/api/admin/organizations/${orgId}/invitations`, admin.aal2, { ...inviteBody, role: 'INDIVIDUAL' });
  record(runtime, 'mismatched-invite-replay-conflict', mismatch.status === 409, mismatch.status);
  const { data: invitation } = await db.from('invitations').select('token').eq('id', invitationId).single();
  if (!invitation?.token) throw new Error('invitation_token_missing');
  registerSecret(runtime, invitation.token as string);
  const accepted = await worker(runtime, 'POST', '/api/invitations/accept', existing.aal2, { token: invitation.token });
  record(runtime, 'existing-other-org-accept', accepted.status === 200, accepted.status);
  const { data: membership } = await db.from('org_members').select('role').eq('user_id', existing.userId).eq('org_id', orgId).single();
  const { data: profile } = await db.from('profiles').select('org_id,role').eq('id', existing.userId).single();
  record(runtime, 'existing-home-org-preserved', membership?.role === 'admin'
    && profile?.org_id === runtime.homeOrgId && profile?.role === 'INDIVIDUAL');

  const freshId = randomUUID();
  runtime.invitationIds.add(freshId);
  runtime.userEmails.add(APPROVED_RECIPIENTS.fresh);
  const fresh = await worker(runtime, 'POST', `/api/admin/organizations/${orgId}/invitations`, admin.aal2, {
    email: APPROVED_RECIPIENTS.fresh, role: 'INDIVIDUAL', idempotency_key: freshId,
  });
  record(runtime, 'fresh-member-invite-sent', fresh.status === 201 && isObject(fresh.body) && fresh.body.sent === true, fresh.status);
  const { data: freshInvitation } = await db.from('invitations').select('token').eq('id', freshId).single();
  if (!freshInvitation?.token) throw new Error('fresh_invitation_token_missing');
  registerSecret(runtime, freshInvitation.token as string);
  const freshAccept = await worker(runtime, 'POST', '/api/invitations/accept', undefined, {
    token: freshInvitation.token,
    password: runtime.password,
    fullName: 'UAT0422 Synthetic Member',
  });
  record(runtime, 'fresh-member-accept', freshAccept.status === 200 && isObject(freshAccept.body)
    && freshAccept.body.verificationEmailSent === true, freshAccept.status);
  const { data: freshProfile } = await db.from('profiles').select('id,org_id,role').eq('email', APPROVED_RECIPIENTS.fresh).single();
  if (freshProfile?.id) runtime.userIds.add(freshProfile.id as string);
  const { data: freshMembership } = freshProfile?.id
    ? await db.from('org_members').select('role').eq('user_id', freshProfile.id).eq('org_id', orgId).single()
    : { data: null };
  record(runtime, 'fresh-member-role-mapping', freshProfile?.org_id === orgId
    && freshProfile?.role === 'INDIVIDUAL' && freshMembership?.role === 'member');

  const provisionKey = randomUUID();
  const provisionName = `UAT0422 Provision ${provisionKey}`;
  runtime.orgNames.add(provisionName);
  const provisionOrg = await worker(runtime, 'POST', '/api/admin/organizations', admin.aal2, {
    display_name: provisionName,
    legal_name: provisionName,
    anchor_quota: 10,
    credits: 0,
    is_test: true,
    idempotency_key: provisionKey,
  });
  const provisionedOrgId = isObject(provisionOrg.body) && isObject(provisionOrg.body.organization)
    ? provisionOrg.body.organization.org_id : null;
  record(runtime, 'platform-provision-organization', provisionOrg.status === 201 && typeof provisionedOrgId === 'string', provisionOrg.status);
  runtime.orgIds.add(provisionedOrgId as string);
  const provisionReplay = await worker(runtime, 'POST', '/api/admin/organizations', admin.aal2, {
    display_name: provisionName,
    legal_name: provisionName,
    anchor_quota: 10,
    credits: 0,
    is_test: true,
    idempotency_key: provisionKey,
  });
  record(runtime, 'platform-provision-organization-replay', provisionReplay.status === 201
    && isObject(provisionReplay.body) && isObject(provisionReplay.body.organization)
    && provisionReplay.body.organization.org_id === provisionedOrgId, provisionReplay.status);
  const { data: finiteCredits, error: finiteCreditsError } = await db.from('org_credits').select('anchor_quota,cap_enforced')
    .eq('org_id', provisionedOrgId).single();
  const { count: finiteReceipts, error: finiteReceiptsError } = await db.from('admin_org_provisioning_requests')
    .select('idempotency_key', { count: 'exact', head: true }).eq('idempotency_key', provisionKey);
  record(runtime, 'finite-quota-provisioning-semantics', !finiteCreditsError && !finiteReceiptsError
    && finiteCredits?.anchor_quota === 10
    && finiteCredits.cap_enforced === true && finiteReceipts === 1);

  for (const isTest of [true, false]) {
    const nullKey = randomUUID();
    const nullName = `UAT0422 Null Quota ${isTest ? 'Test' : 'Billable'} ${nullKey}`;
    runtime.orgNames.add(nullName);
    const nullBody = {
      display_name: nullName,
      legal_name: nullName,
      anchor_quota: null,
      credits: 0,
      is_test: isTest,
      idempotency_key: nullKey,
    };
    const created = await worker(runtime, 'POST', '/api/admin/organizations', admin.aal2, nullBody);
    const nullOrgId = isObject(created.body) && isObject(created.body.organization)
      ? created.body.organization.org_id : null;
    const createdOrganization = isObject(created.body) && isObject(created.body.organization)
      ? created.body.organization : {};
    record(runtime, `null-quota-${isTest ? 'test' : 'billable'}-provision`, created.status === 201
      && typeof nullOrgId === 'string' && createdOrganization.anchor_quota === null, created.status);
    runtime.orgIds.add(nullOrgId as string);
    const replayed = await worker(runtime, 'POST', '/api/admin/organizations', admin.aal2, nullBody);
    const { data: nullCredits, error: nullCreditsError } = await db.from('org_credits').select('anchor_quota,cap_enforced,is_test')
      .eq('org_id', nullOrgId).single();
    const { count: receiptCount, error: receiptError } = await db.from('admin_org_provisioning_requests')
      .select('idempotency_key', { count: 'exact', head: true }).eq('idempotency_key', nullKey);
    record(runtime, `null-quota-${isTest ? 'test' : 'billable'}-replay-semantics`, replayed.status === 201
      && isObject(replayed.body) && isObject(replayed.body.organization)
      && replayed.body.organization.org_id === nullOrgId
      && replayed.body.organization.anchor_quota === null
      && !nullCreditsError && !receiptError
      && nullCredits?.anchor_quota === null && nullCredits.cap_enforced === false
      && nullCredits.is_test === isTest && receiptCount === 1, replayed.status);
  }
  runtime.userEmails.add(APPROVED_RECIPIENTS.provision);
  const provisionUser = await worker(runtime, 'POST', '/api/admin/users', admin.aal2, {
    email: APPROVED_RECIPIENTS.provision,
    full_name: 'UAT0422 Provisioned Account',
    role: 'ORG_MEMBER',
    org_id: provisionedOrgId,
    org_role: 'member',
    send_invite_email: false,
  });
  const provisionedUserId = isObject(provisionUser.body) && isObject(provisionUser.body.account)
    ? provisionUser.body.account.user_id : null;
  const provisionedAccount = isObject(provisionUser.body) && isObject(provisionUser.body.account)
    ? provisionUser.body.account : {};
  if (typeof provisionedAccount.activation_link === 'string') registerSecret(runtime, provisionedAccount.activation_link);
  record(runtime, 'platform-provision-account', provisionUser.status === 201
    && typeof provisionedUserId === 'string'
    && provisionedAccount.role === 'ORG_MEMBER'
    && provisionedAccount.org_id === provisionedOrgId
    && provisionedAccount.org_role === 'member'
    && provisionedAccount.invite_email_sent === false
    && typeof provisionedAccount.activation_link === 'string', provisionUser.status);
  if (typeof provisionedUserId === 'string') runtime.userIds.add(provisionedUserId);
  const { data: provisionedProfile } = typeof provisionedUserId === 'string'
    ? await db.from('profiles').select('org_id,role').eq('id', provisionedUserId).single()
    : { data: null };
  const { data: provisionedMembership } = typeof provisionedUserId === 'string'
    ? await db.from('org_members').select('role').eq('user_id', provisionedUserId).eq('org_id', provisionedOrgId).single()
    : { data: null };
  record(runtime, 'platform-provision-account-placement', provisionedProfile?.org_id === provisionedOrgId
    && provisionedProfile?.role === 'ORG_MEMBER' && provisionedMembership?.role === 'member');

  const health = await worker(runtime, 'GET', '/api/admin/system-health', admin.aal2);
  const healthBody = isObject(health.body) ? health.body : {};
  record(runtime, 'platform-health-db-and-config', health.status === 200
    && isObject(healthBody.checks) && isObject(healthBody.checks.supabase)
    && healthBody.checks.supabase.status === 'ok'
    && isObject(healthBody.config) && healthBody.config.email === runtime.expectedEmailConfigured, health.status);
  const deniedHealth = await worker(runtime, 'GET', '/api/admin/system-health', ordinary.aal2);
  record(runtime, 'ordinary-platform-health-forbidden', deniedHealth.status === 403, deniedHealth.status);
}

async function verifyWorkerProcess(runtime: Runtime): Promise<void> {
  const requestedAt = Date.now();
  const health = await worker(runtime, 'GET', '/health');
  const receivedAt = Date.now();
  record(runtime, 'public-isolated-worker-health', health.status === 200 && isObject(health.body)
    && health.body.git_sha === runtime.manifest.sourceHead, health.status);
  try {
    runtime.workerUptime = observeWorkerUptime(runtime.workerUptime,
      isObject(health.body) ? health.body.uptime : undefined, requestedAt, receivedAt);
  } catch {
    record(runtime, 'worker-uptime-continuous', false);
  }
  record(runtime, 'worker-uptime-continuous', true);
}

async function runAdmission(runtime: Runtime): Promise<void> {
  const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  record(runtime, 'exact-source-head', currentHead === runtime.manifest.sourceHead);
  await verifyStandingTarget(runtime);
  await verifyWorkerProcess(runtime);
  await verifyHostedAuth(runtime);
  await verifyCatalog(runtime);
  await verifyCleanStart(runtime);

  const homeOrg = await createOrgFixture(runtime, 'Home');
  runtime.homeOrgId = homeOrg;
  runtime.selectedOrgId = await createOrgFixture(runtime, 'Selected');
  const ordinaryEmail = `uat0422-ordinary-${randomUUID()}@staging.invalid.test`;
  const adminEmail = `uat0422-admin-${randomUUID()}@staging.invalid.test`;
  const adminId = await createHuman(runtime, adminEmail);
  const ordinaryId = await createHuman(runtime, ordinaryEmail);
  const existingId = await createHuman(runtime, APPROVED_RECIPIENTS.existing);
  const alreadyId = await createHuman(runtime, APPROVED_RECIPIENTS.already);
  await placeHuman(runtime, adminId, homeOrg, 'ORG_ADMIN', 'admin');
  await placeHuman(runtime, ordinaryId, homeOrg, 'ORG_MEMBER', 'member');
  await placeHuman(runtime, existingId, homeOrg, 'INDIVIDUAL', 'member');
  await placeHuman(runtime, alreadyId, runtime.selectedOrgId, 'INDIVIDUAL', 'member');
  const promoted = await service(runtime).rpc('admin_set_platform_admin', { p_user_id: adminId, p_is_admin: true });
  if (promoted.error) throw new Error('fixture_platform_admin_failed');

  const admin = await enrollHuman(runtime, adminId, adminEmail);
  const ordinary = await enrollHuman(runtime, ordinaryId, ordinaryEmail);
  const existing = await enrollHuman(runtime, existingId, APPROVED_RECIPIENTS.existing);
  runtime.adminSession = admin;
  runtime.existingUserId = existingId;
  await aalBoundary(runtime, admin, 'platform-admin');
  await aalBoundary(runtime, ordinary, 'ordinary');
  await aalBoundary(runtime, existing, 'existing-other-org');
  await invitationAndProvisioning(runtime, admin, ordinary, existing);
}

async function runLongPhase(runtime: Runtime): Promise<void> {
  const endAt = Date.now() + runtime.args.durationMin * 60_000;
  assertWorkerRequestLease(endAt, runtime.manifest.destroyBy);
  const db = service(runtime);
  const admin = runtime.adminSession;
  if (!admin) throw new Error('admin_session_missing');
  while (Date.now() < endAt) {
    await verifyStandingTarget(runtime);
    await verifyWorkerProcess(runtime);
    const cycle = await reauthenticate(runtime, admin);
    const denied = await worker(runtime, 'GET', '/api/admin/system-health', cycle.aal1);
    record(runtime, 'long-aal1-worker-denied', denied.status === 401, denied.status);
    for (const probe of buildLongProbePlan(runtime.selectedOrgId)) {
      const result = await worker(runtime, probe.method, probe.path, cycle.aal2);
      const healthSemantics = probe.path === '/api/admin/system-health'
        ? isObject(result.body) && isObject(result.body.checks) && isObject(result.body.checks.supabase)
          && result.body.checks.supabase.status === 'ok'
          && isObject(result.body.config) && result.body.config.email === runtime.expectedEmailConfigured
        : true;
      record(runtime, `long-${probe.label}`, result.status === 200 && healthSemantics, result.status);
    }
    await verifyWorkerProcess(runtime);
    await verifyHostedAuth(runtime);
    await verifyCatalog(runtime);
    const { data: existingProfile } = await db.from('profiles').select('org_id,role').eq('id', runtime.existingUserId).single();
    const { data: existingMembership } = await db.from('org_members').select('role')
      .eq('user_id', runtime.existingUserId).eq('org_id', runtime.selectedOrgId).single();
    record(runtime, 'long-existing-home-org-invariant', existingProfile?.org_id === runtime.homeOrgId
      && existingProfile?.role === 'INDIVIDUAL' && existingMembership?.role === 'admin');
    checkpoint(runtime, false, false);
    const remaining = endAt - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(runtime.args.intervalSec * 1000, remaining)));
  }
  // Sample at the end too: the preceding loop sample can be one interval old.
  await verifyStandingTarget(runtime);
  await verifyWorkerProcess(runtime);
}

async function cleanup(runtime: Runtime): Promise<boolean> {
  let ok = true;
  try {
    const owned = await managementQuery(runtime, `SELECT 'user' AS kind, id::text AS id
      FROM auth.users WHERE lower(email) IN (${sqlList(runtime.userEmails)})
      UNION ALL SELECT 'org' AS kind, id::text AS id
      FROM public.organizations WHERE display_name IN (${sqlList(runtime.orgNames)})`, true);
    for (const row of owned) {
      if (!isObject(row) || typeof row.id !== 'string') continue;
      if (row.kind === 'user') runtime.userIds.add(row.id);
      if (row.kind === 'org') runtime.orgIds.add(row.id);
    }
  } catch {
    ok = false;
  }
  const users = sqlList(runtime.userIds);
  const orgs = sqlList(runtime.orgIds);
  const invitations = sqlList(runtime.invitationIds);
  try {
    await managementQuery(runtime, `BEGIN;
      SET LOCAL session_replication_role=replica;
      DELETE FROM public.audit_events WHERE actor_id IN (${users}) OR org_id IN (${orgs});
      DELETE FROM public.admin_org_provisioning_requests WHERE actor_id IN (${users}) OR org_id IN (${orgs});
      DELETE FROM public.org_credit_deductions WHERE org_id IN (${orgs});
      COMMIT;`, true);
  } catch {
    ok = false;
  }
  const db = service(runtime, true);
  try {
    const invitationFilters = [postgrestIn('id', runtime.invitationIds), postgrestIn('org_id', runtime.orgIds)].filter(Boolean);
    if (invitationFilters.length > 0) {
      const invitationDelete = await db.from('invitations').delete().or(invitationFilters.join(','));
      if (invitationDelete.error) ok = false;
    }
  } catch {
    ok = false;
  }
  try {
    const membershipFilters = [postgrestIn('user_id', runtime.userIds), postgrestIn('org_id', runtime.orgIds)].filter(Boolean);
    if (membershipFilters.length > 0) {
      const membershipDelete = await db.from('org_members').delete().or(membershipFilters.join(','));
      if (membershipDelete.error) ok = false;
    }
  } catch {
    ok = false;
  }
  for (const userId of runtime.userIds) {
    try {
      const deleted = await db.auth.admin.deleteUser(userId);
      if (deleted.error) ok = false;
    } catch {
      ok = false;
    }
  }
  try {
    if (runtime.orgIds.size > 0) {
      const orgDelete = await db.from('organizations').delete().in('id', [...runtime.orgIds]);
      if (orgDelete.error) ok = false;
    }
  } catch {
    ok = false;
  }
  try {
    const rows = await managementQuery(runtime, `SELECT
      (SELECT count(*) FROM auth.users WHERE id IN (${users}) OR lower(email) IN (${sqlList(runtime.userEmails)}))::int AS users,
      (SELECT count(*) FROM public.profiles WHERE id IN (${users}) OR org_id IN (${orgs}) OR lower(email) IN (${sqlList(runtime.userEmails)}))::int AS profiles,
      (SELECT count(*) FROM public.org_members WHERE user_id IN (${users}) OR org_id IN (${orgs}))::int AS memberships,
      (SELECT count(*) FROM public.invitations WHERE id IN (${invitations}) OR org_id IN (${orgs}) OR lower(email) IN (${sqlList(runtime.userEmails)}))::int AS invitations,
      (SELECT count(*) FROM public.org_credit_deductions WHERE org_id IN (${orgs}))::int AS credit_deductions,
      (SELECT count(*) FROM public.admin_org_provisioning_requests WHERE actor_id IN (${users}) OR org_id IN (${orgs}))::int AS provisioning_requests,
      (SELECT count(*) FROM public.organizations WHERE id IN (${orgs}) OR display_name IN (${sqlList(runtime.orgNames)}))::int AS organizations`, true);
    const counts = isObject(rows[0]) ? rows[0] : {};
    return ok && ['users', 'profiles', 'memberships', 'invitations', 'credit_deductions', 'provisioning_requests', 'organizations']
      .every((key) => counts[key] === 0);
  } catch {
    return false;
  }
}

export interface LocalDriverSmokeOptions {
  supabaseUrl: string;
  anonKey: string;
  serviceKey: string;
  workerUrl: string;
  expectedEmailConfigured: boolean;
  queryLocalDatabase: (query: string) => Promise<unknown[]>;
  resetLocalRateLimit: () => Promise<void>;
}

export async function runLocalDriverSmoke(options: LocalDriverSmokeOptions): Promise<{
  scope: 'local-only';
  checks: CheckResult[];
  cleanedUp: boolean;
}> {
  if (process.env.UAT0422_LOCAL_DRIVER_SMOKE !== '1' || process.env.NODE_ENV !== 'test') {
    throw new Error('Local driver smoke requires the explicit test-only opt-in');
  }
  for (const [name, raw] of [['supabaseUrl', options.supabaseUrl], ['workerUrl', options.workerUrl]] as const) {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      throw new Error(`${name} must be a loopback HTTP URL`);
    }
  }
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const now = Date.now();
  const runtime: Runtime = {
    manifest: {
      schemaVersion: 1,
      rigId: RIG_ID,
      sourceHead,
      supabaseProjectRef: 'local-driver-smoke',
      supabaseUrl: options.supabaseUrl,
      cloudRunService: EXPECTED_SERVICE,
      workerUrl: options.workerUrl,
      createdAt: new Date(now).toISOString(),
      destroyBy: new Date(now + LEASE_MS).toISOString(),
      bootstrapCatalogSha256: EXPECTED_CATALOG_SHA256,
    },
    args: { manifestPath: 'local-simulation', durationMin: 1, intervalSec: 60, execute: true, liveEmail: false },
    anonKey: options.anonKey,
    serviceKey: options.serviceKey,
    managementToken: 'local-simulation',
    checks: [],
    secrets: new Set([options.anonKey, options.serviceKey]),
    userIds: new Set(),
    userEmails: new Set(),
    orgIds: new Set(),
    orgNames: new Set(),
    invitationIds: new Set(),
    startedAt: now,
    password: `Uat0422-${randomBytes(24).toString('base64url')}!`,
    selectedOrgId: '',
    homeOrgId: '',
    existingUserId: '',
    adminSession: null,
    expectedEmailConfigured: options.expectedEmailConfigured,
    workerUptime: null,
    managementQueryOverride: options.queryLocalDatabase,
    hostedAuthSimulated: true,
    rateLimitWaitOverride: async () => options.resetLocalRateLimit(),
  };
  registerSecret(runtime, runtime.password);
  let failure: unknown;
  try {
    await runAdmission(runtime);
  } catch (error) {
    failure = error;
  }
  const cleanedUp = await cleanup(runtime);
  if (failure) throw failure;
  if (!cleanedUp) throw new Error('local_driver_cleanup_failed');
  return { scope: 'local-only', checks: runtime.checks, cleanedUp };
}

function evidence(runtime: Runtime, complete: boolean, cleanedUp: boolean): Evidence {
  return {
    schemaVersion: 1,
    driver: 'uat04-uat22-auth-invite',
    rigId: RIG_ID,
    sourceHead: runtime.manifest.sourceHead,
    admissionMode: runtime.manifest.admissionMode ?? 'isolated',
    runId: runtime.manifest.admissionMode === 'exclusive-standing-mirror' ? runtime.manifest.runId : null,
    manifestSha256: runtime.args.manifestSha256 ?? null,
    supabaseProjectRef: runtime.manifest.supabaseProjectRef,
    cloudRunService: runtime.manifest.cloudRunService,
    workerUrl: runtime.manifest.workerUrl,
    createdAt: runtime.manifest.createdAt,
    destroyBy: runtime.manifest.destroyBy,
    startedAt: new Date(runtime.startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    driverWindowComplete: complete,
    cleanedUp,
    liveEmail: runtime.args.liveEmail,
    approvedRecipients: Object.values(APPROVED_RECIPIENTS),
    checks: runtime.checks,
    allChecksPassed: complete && cleanedUp && runtime.checks.length > 0 && runtime.checks.every((check) => check.passed),
    workerUptime: runtime.workerUptime,
    releaseQualification: 'not_assessed',
    prerequisitesNotProvenByDriver: [
      '1280px and 375px browser checkpoints require Playwright against the admitted frontend origin',
      'private exports require the authorized worker export/signed-URL positive control',
      'Resend test delivery proves provider acceptance; captured local tests remain the trusted email-content oracle',
      'system-health bitcoin.connected is configuration-derived and does not prove live chain connectivity',
      'Cloud Run revision identity, measured worker uptime floor, wall-clock floor, browser evidence, and residual release gates are graded outside this driver',
    ],
  };
}

function checkpoint(runtime: Runtime, complete: boolean, cleanedUp: boolean): void {
  if (!runtime.args.evidenceOut) return;
  const safe = redactEvidence(evidence(runtime, complete, cleanedUp), [...runtime.secrets]);
  writeEvidenceFile(runtime.args.evidenceOut, safe, { quiet: !complete });
}

async function main(): Promise<void> {
  const args = parseUatArgs(process.argv.slice(2));
  const manifestRaw = readFileSync(resolve(args.manifestPath), 'utf8');
  const manifest = validateManifestDocument(manifestRaw, args.manifestSha256);
  if (Date.now() + args.durationMin * 60_000 > Date.parse(manifest.destroyBy)) {
    throw new Error('Requested soak duration exceeds the admitted 72-hour lease');
  }
  if (!args.execute) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      driver: 'uat04-uat22-auth-invite',
      rigId: manifest.rigId,
      sourceHead: manifest.sourceHead,
      cloudRunService: manifest.cloudRunService,
      destroyBy: manifest.destroyBy,
      liveEmail: false,
      networkRequests: 0,
      writes: 0,
      longPlan: buildLongProbePlan('SELECTED_ORG_ID'),
    }, null, 2));
    return;
  }

  const runtime: Runtime = {
    manifest,
    args,
    anonKey: '',
    serviceKey: '',
    managementToken: '',
    checks: [],
    secrets: new Set(),
    userIds: new Set(),
    userEmails: new Set(),
    orgIds: new Set(),
    orgNames: new Set(),
    invitationIds: new Set(),
    startedAt: Date.now(),
    password: `Uat0422-${randomBytes(24).toString('base64url')}!`,
    selectedOrgId: '',
    homeOrgId: '',
    existingUserId: '',
    adminSession: null,
    expectedEmailConfigured: true,
    workerUptime: null,
  };
  runtime.anonKey = registerSecret(runtime, env('STAGING_SUPABASE_ANON_KEY'));
  runtime.serviceKey = registerSecret(runtime, env('STAGING_SUPABASE_SERVICE_ROLE_KEY'));
  runtime.managementToken = registerSecret(runtime, env('STAGING_SUPABASE_ACCESS_TOKEN'));
  registerSecret(runtime, runtime.password);

  let complete = false;
  let cleanedUp = false;
  try {
    await runAdmission(runtime);
    checkpoint(runtime, false, false);
    await runLongPhase(runtime);
    complete = true;
  } finally {
    cleanedUp = await cleanup(runtime);
    checkpoint(runtime, complete, cleanedUp);
  }
  if (!complete || !cleanedUp || runtime.checks.some((check) => !check.passed)) process.exitCode = 1;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    const message = error instanceof Error && /^check_failed:[a-z0-9-]+$/i.test(error.message)
      ? error.message
      : 'driver_failed';
    console.error(message);
    process.exitCode = 1;
  });
}
