import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  projectAdmissionV2ToRunDeclaration,
  requireAdmissionBoundRunDeclaration,
} from './batch-drain-admission-adapter';

const ADMISSION_RAW = readFileSync(
  join(process.cwd(), 'scripts/staging/fixtures/rig-b1-admission-v2.json'),
  'utf8',
);

type JsonRecord = Record<string, unknown>;

function admissionWith(mutator: (value: JsonRecord) => void): string {
  const value = JSON.parse(ADMISSION_RAW) as JsonRecord;
  mutator(value);
  return JSON.stringify(value);
}

function ceremonyValue(): JsonRecord {
  return {
    declarationId: 'decl-rig-b1-admission-v2',
    soakStartedAt: '2026-07-13T12:00:00.000Z',
    soakEndedAt: '2026-07-15T12:31:00.000Z',
    recoveries: [],
    windows: [{
      scenarioId: 'admission-v2-eligible',
      kind: 'eligible-10000',
      armedTrigger: 'org-scheduler',
      expectedInitialPending: 1,
      expectedFinalPending: 0,
      passes: [{
        batchId: 'batch-admission-v2',
        armedTrigger: 'org-scheduler',
        schedulerExecutionId: 'scheduler-admission-v2',
        faultWindow: {
          id: 'fault-admission-v2',
          startsAt: '2026-07-13T12:00:00.000Z',
          endsAt: '2026-07-13T12:05:00.000Z',
        },
        claims: [{ fingerprint: '1'.repeat(64), orgId: 'org-admission-v2' }],
      }],
    }],
  };
}

function ceremonyRaw(mutator?: (value: JsonRecord) => void): string {
  const value = ceremonyValue();
  mutator?.(value);
  return JSON.stringify(value);
}

describe('admission v2 to run-declaration identity adapter', () => {
  it('strictly projects every run identity from Team2 admission v2 only', () => {
    const bound = projectAdmissionV2ToRunDeclaration(ADMISSION_RAW, ceremonyRaw());
    const declaration = requireAdmissionBoundRunDeclaration(bound);
    expect(bound.admissionSha256).toBe(createHash('sha256').update(ADMISSION_RAW).digest('hex'));
    expect(declaration).toMatchObject({
      schemaVersion: 1,
      declarationId: 'decl-rig-b1-admission-v2',
      gitBaseSha: '0'.repeat(40),
      gitHeadSha: 'a'.repeat(40),
      imageDigest: `sha256:${'b'.repeat(64)}`,
      rigId: 'RIG-B1',
      gcpProjectId: 'arkova1',
      projectRef: 'abcdefghijklmnopqrst',
      soakId: 'soak-rig-b1-r3',
      leaseId: 'lease-rig-b1-r3',
      cleanMirrorAttestationId: `sha256:${'e'.repeat(64)}`,
      workerService: 'arkova-worker-s33-rig-b1-staging',
      workerRevision: 'arkova-worker-s33-rig-b1-staging-00001',
      region: 'us-central1',
    });
  });

  it('rejects duplicate top-level and nested admission keys before semantic parsing', () => {
    const duplicateSchema = ADMISSION_RAW.replace(
      '"schema_version": 2,',
      '"schema_version": 2, "schema_version": 2,',
    );
    expect(() => projectAdmissionV2ToRunDeclaration(duplicateSchema, ceremonyRaw())).toThrow(
      /duplicate.*schema_version/i,
    );
    const duplicateNetwork = ADMISSION_RAW.replace(
      '"bitcoin_network": "signet",',
      '"bitcoin_network": "signet", "bitcoin_network": "mainnet",',
    );
    expect(() => projectAdmissionV2ToRunDeclaration(duplicateNetwork, ceremonyRaw())).toThrow(
      /duplicate.*bitcoin_network/i,
    );
    const duplicatePath = ADMISSION_RAW.replace(
      '"path": "/jobs/recover-broadcasts"',
      '"path": "/jobs/recover-broadcasts", "path": "/jobs/manual-rebind"',
    );
    expect(() => projectAdmissionV2ToRunDeclaration(duplicatePath, ceremonyRaw())).toThrow(/duplicate.*path/i);
  });

  it.each([
    ['wrong schema', (value: JsonRecord) => { value.schema_version = 1; }],
    ['extra top-level field', (value: JsonRecord) => { value.manual_identity = 'forged'; }],
    ['wrong rig', (value: JsonRecord) => { value.rig_id = 'RIG-G1'; }],
    ['wrong tier', (value: JsonRecord) => { value.tier = 'T2'; }],
  ])('rejects %s in the strict admission schema', (_label, mutate) => {
    expect(() => projectAdmissionV2ToRunDeclaration(admissionWith(mutate), ceremonyRaw())).toThrow(
      /admission v2.*schema|rejected/i,
    );
  });

  it.each([
    'rig_id',
    'gcp_project_id',
    'region',
    'lease_id',
    'clean_mirror_attestation_id',
    'sha',
    'base_sha',
    'deployed_image_digest',
    'supabase_project_ref',
    'soak_id',
    'cloud_run_service',
    'deployed_revision',
    'required_uptime_min',
    'required_wall_min',
  ])('requires admission identity field %s', (field) => {
    expect(() => projectAdmissionV2ToRunDeclaration(admissionWith((value) => {
      delete value[field];
    }), ceremonyRaw())).toThrow(/admission v2.*schema|rejected/i);
  });

  it.each([
    ['critical_config.bitcoin_network', (value: JsonRecord) => {
      delete (value.critical_config as JsonRecord).bitcoin_network;
    }],
    ['scheduler.jobs[].name', (value: JsonRecord) => {
      delete (((value.scheduler as JsonRecord).jobs as JsonRecord[])[0]!).name;
    }],
    ['scheduler.paused_through_clean_mirror', (value: JsonRecord) => {
      delete (value.scheduler as JsonRecord).paused_through_clean_mirror;
    }],
    ['clean_mirror.attestation_id', (value: JsonRecord) => {
      delete (value.clean_mirror as JsonRecord).attestation_id;
    }],
    ['extra critical_config field', (value: JsonRecord) => {
      (value.critical_config as JsonRecord).manual_network_override = 'mainnet';
    }],
    ['extra scheduler field', (value: JsonRecord) => {
      (value.scheduler as JsonRecord).manual_resume = true;
    }],
  ])('strictly rejects missing or extra nested field %s', (_label, mutate) => {
    expect(() => projectAdmissionV2ToRunDeclaration(admissionWith(mutate), ceremonyRaw())).toThrow(
      /admission v2.*schema|rejected/i,
    );
  });

  it.each([
    ['declared head', (value: JsonRecord) => { value.declared_source_head = 'd'.repeat(40); }],
    ['deployed head', (value: JsonRecord) => { value.deployed_source_head = 'd'.repeat(40); }],
    ['input image digest', (value: JsonRecord) => { value.image_digest = `sha256:${'d'.repeat(64)}`; }],
    ['deployed image ref', (value: JsonRecord) => { value.deployed_image_ref = `repo@sha256:${'d'.repeat(64)}`; }],
    ['nested attestation', (value: JsonRecord) => {
      (value.clean_mirror as JsonRecord).attestation_id = `sha256:${'d'.repeat(64)}`;
    }],
    ['dirty mirror', (value: JsonRecord) => { value.preflight_result = 'environment_type=fixture_seeded'; }],
  ])('rejects contradictory %s identity', (_label, mutate) => {
    expect(() => projectAdmissionV2ToRunDeclaration(admissionWith(mutate), ceremonyRaw())).toThrow(
      /contradict|identity|clean_mirror|digest|head|attestation/i,
    );
  });

  it.each([
    ['uptime', (value: JsonRecord) => { value.required_uptime_min = 2_879; }],
    ['duration alias', (value: JsonRecord) => { value.duration_min = 2_879; }],
    ['wall floor', (value: JsonRecord) => { value.required_wall_min = 2_909; }],
    ['network', (value: JsonRecord) => { (value.critical_config as JsonRecord).bitcoin_network = 'mainnet'; }],
    ['paused proof', (value: JsonRecord) => { (value.scheduler as JsonRecord).paused_through_clean_mirror = false; }],
    ['resume state', (value: JsonRecord) => { (value.scheduler as JsonRecord).state = 'PAUSED'; }],
  ])('rejects invalid %s admission gate', (_label, mutate) => {
    expect(() => projectAdmissionV2ToRunDeclaration(admissionWith(mutate), ceremonyRaw())).toThrow(
      /2880|2910|signet|paused|resumed|admission v2.*schema|rejected/i,
    );
  });

  it.each([
    '/jobs/batch-anchors?force=true',
    '/jobs/recover-broadcasts',
    '/jobs/org-queue-scheduler',
  ])('requires the exact Scheduler spec %s', (requiredPath) => {
    const raw = admissionWith((value) => {
      const scheduler = value.scheduler as JsonRecord;
      scheduler.jobs = (scheduler.jobs as JsonRecord[]).filter((job) => job.path !== requiredPath);
    });
    expect(() => projectAdmissionV2ToRunDeclaration(raw, ceremonyRaw())).toThrow(/required Scheduler path/i);
  });

  it('rejects duplicate/cross-service Scheduler specs and non-PAUSED creation proof', () => {
    const duplicateName = admissionWith((value) => {
      const jobs = (value.scheduler as JsonRecord).jobs as JsonRecord[];
      jobs[1]!.name = jobs[0]!.name;
    });
    expect(() => projectAdmissionV2ToRunDeclaration(duplicateName, ceremonyRaw())).toThrow(/Scheduler.*duplicate/i);
    const crossService = admissionWith((value) => {
      const jobs = (value.scheduler as JsonRecord).jobs as JsonRecord[];
      jobs[0]!.name = 'unrelated-service-batch-anchors';
    });
    expect(() => projectAdmissionV2ToRunDeclaration(crossService, ceremonyRaw())).toThrow(/Scheduler.*service/i);
    const missingPaused = admissionWith((value) => {
      (value.scheduler as JsonRecord).creation_guard = 'created without a hold';
    });
    expect(() => projectAdmissionV2ToRunDeclaration(missingPaused, ceremonyRaw())).toThrow(/PAUSED.*proof/i);
  });

  it('rejects caller identity rebinding and ceremony duration below the admission wall requirement', () => {
    expect(() => projectAdmissionV2ToRunDeclaration(ADMISSION_RAW, ceremonyRaw((value) => {
      value.gitHeadSha = 'd'.repeat(40);
    }))).toThrow(/ceremony.*schema|unrecognized|unknown/i);
    expect(() => projectAdmissionV2ToRunDeclaration(ADMISSION_RAW, ceremonyRaw((value) => {
      value.soakEndedAt = '2026-07-15T12:29:00.000Z';
    }))).toThrow(/admission.*wall|2910/i);
  });

  it('rejects object clones, getters, proxies, and ceremony duplicate keys', () => {
    expect(() => projectAdmissionV2ToRunDeclaration(JSON.parse(ADMISSION_RAW), ceremonyRaw())).toThrow(
      /primitive string/i,
    );
    expect(() => projectAdmissionV2ToRunDeclaration(
      new Proxy(new String(ADMISSION_RAW), {}) as unknown,
      ceremonyRaw(),
    )).toThrow(/primitive string/i);
    expect(() => projectAdmissionV2ToRunDeclaration(
      Object.defineProperty({}, 'schema_version', { get: () => 2 }),
      ceremonyRaw(),
    )).toThrow(/primitive string/i);
    const duplicateCeremony = ceremonyRaw().replace(
      '"declarationId":"decl-rig-b1-admission-v2",',
      '"declarationId":"decl-rig-b1-admission-v2","declarationId":"forged",',
    );
    expect(() => projectAdmissionV2ToRunDeclaration(ADMISSION_RAW, duplicateCeremony)).toThrow(
      /duplicate.*declarationId/i,
    );
  });

  it('deep-freezes the branded result and rejects clones/manual provenance handles', () => {
    const bound = projectAdmissionV2ToRunDeclaration(ADMISSION_RAW, ceremonyRaw());
    const declaration = requireAdmissionBoundRunDeclaration(bound);
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(declaration)).toBe(true);
    expect(Object.isFrozen(declaration.windows)).toBe(true);
    expect(Object.isFrozen(declaration.windows[0]!.passes[0]!.claims)).toBe(true);
    expect(() => { declaration.gitHeadSha = 'd'.repeat(40); }).toThrow(TypeError);
    expect(() => { declaration.windows[0]!.passes[0]!.claims.push({
      fingerprint: '2'.repeat(64), orgId: 'forged-org',
    }); }).toThrow(TypeError);
    expect(() => requireAdmissionBoundRunDeclaration(structuredClone(bound))).toThrow(/provenance|adapter/i);
    expect(() => requireAdmissionBoundRunDeclaration({ admissionSha256: bound.admissionSha256 })).toThrow(
      /provenance|adapter/i,
    );
    expect(() => requireAdmissionBoundRunDeclaration(new Proxy(bound, {}))).toThrow(/provenance|adapter/i);
  });
});
