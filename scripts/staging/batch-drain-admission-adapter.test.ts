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

const TEAM2_RIG_B1_SCHEDULER_SPECS = [
  ['batch-anchors', '/jobs/batch-anchors'],
  ['check-confirmations', '/jobs/check-confirmations'],
  ['populate-confirmation-proofs', '/jobs/populate-confirmation-proofs'],
  ['org-queue-scheduler', '/jobs/org-queue-scheduler'],
  ['batch-anchors-forced-flush', '/jobs/batch-anchors?force=true'],
  ['recover-broadcasts', '/jobs/recover-broadcasts'],
] as const;

const TEAM2_RIG_B1_CRITICAL_CONFIG = {
  node_env: 'production',
  enable_ai_fraud: 'false',
  enable_ai_reports: 'false',
  frontend_url: 'https://app.arkova.ai',
  use_mocks: 'false',
  enable_prod_network_anchoring: 'true',
  bitcoin_network: 'signet',
  bitcoin_utxo_provider: 'getblock',
  kms_provider: 'gcp',
  gemini_tuned_model: '',
  gemini_v6_prompt: '',
  gemini_tuned_response_schema: '<unset>',
} as const;

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
    const admission = JSON.parse(ADMISSION_RAW) as JsonRecord;
    expect(admission.source_head_image_ref).toBe(
      `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:${'a'.repeat(40)}`,
    );
    expect(admission.source_head_image_digest).toBe(admission.deployed_image_digest);
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
    ['malformed source-head image ref', (value: JsonRecord) => {
      value.source_head_image_ref = `repo@sha256:${'b'.repeat(64)}`;
    }],
    ['malformed source-head image digest', (value: JsonRecord) => {
      value.source_head_image_digest = 'b'.repeat(64);
    }],
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
    'source_head_image_ref',
    'source_head_image_digest',
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
    ['source-head image digest', (value: JsonRecord) => {
      value.source_head_image_digest = `sha256:${'d'.repeat(64)}`;
    }],
    ['source-head image repository', (value: JsonRecord) => {
      value.source_head_image_ref = `us-central1-docker.pkg.dev/forged/project/worker:${'a'.repeat(40)}`;
    }],
    ['source-head image tag', (value: JsonRecord) => {
      value.source_head_image_ref = `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:${'d'.repeat(40)}`;
    }],
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
    ['Scheduler applicability', (value: JsonRecord) => { (value.scheduler as JsonRecord).applicable = false; }],
    ['paused proof', (value: JsonRecord) => { (value.scheduler as JsonRecord).paused_through_clean_mirror = false; }],
    ['resume state', (value: JsonRecord) => { (value.scheduler as JsonRecord).state = 'PAUSED'; }],
  ])('rejects invalid %s admission gate', (_label, mutate) => {
    expect(() => projectAdmissionV2ToRunDeclaration(admissionWith(mutate), ceremonyRaw())).toThrow(
      /2880|2910|signet|paused|resumed|admission v2.*schema|rejected/i,
    );
  });

  it.each(TEAM2_RIG_B1_SCHEDULER_SPECS)(
    'requires the exact Scheduler pair %s -> %s',
    (suffix, requiredPath) => {
      const raw = admissionWith((value) => {
        const scheduler = value.scheduler as JsonRecord;
        scheduler.jobs = (scheduler.jobs as JsonRecord[]).filter((job) => (
          job.name !== `arkova-worker-s33-rig-b1-staging-${suffix}`
          || job.path !== requiredPath
        ));
      });
      expect(() => projectAdmissionV2ToRunDeclaration(raw, ceremonyRaw())).toThrow(/exact.*Scheduler|contract/i);
    },
  );

  it.each(TEAM2_RIG_B1_SCHEDULER_SPECS.map((_spec, index) => index))(
    'rejects arbitrary Scheduler name at exact pair index %s',
    (index) => {
      const raw = admissionWith((value) => {
        const jobs = (value.scheduler as JsonRecord).jobs as JsonRecord[];
        jobs[index]!.name = `arkova-worker-s33-rig-b1-staging-forged-${index}`;
      });
      expect(() => projectAdmissionV2ToRunDeclaration(raw, ceremonyRaw())).toThrow(/exact.*Scheduler|contract/i);
    },
  );

  it.each(TEAM2_RIG_B1_SCHEDULER_SPECS.map((_spec, index) => index))(
    'rejects a path swapped away from exact Scheduler pair index %s',
    (index) => {
      const raw = admissionWith((value) => {
        const jobs = (value.scheduler as JsonRecord).jobs as JsonRecord[];
        const otherIndex = (index + 1) % jobs.length;
        const currentPath = jobs[index]!.path;
        jobs[index]!.path = jobs[otherIndex]!.path;
        jobs[otherIndex]!.path = currentPath;
      });
      expect(() => projectAdmissionV2ToRunDeclaration(raw, ceremonyRaw())).toThrow(/exact.*Scheduler|contract/i);
    },
  );

  it('rejects extra Scheduler jobs and accepts the complete exact set in any array order', () => {
    const extra = admissionWith((value) => {
      const jobs = (value.scheduler as JsonRecord).jobs as JsonRecord[];
      jobs.push({
        name: 'arkova-worker-s33-rig-b1-staging-arbitrary-extra',
        path: '/jobs/arbitrary-extra',
      });
    });
    expect(() => projectAdmissionV2ToRunDeclaration(extra, ceremonyRaw())).toThrow(/exact.*Scheduler|contract/i);
    const reordered = admissionWith((value) => {
      const jobs = (value.scheduler as JsonRecord).jobs as JsonRecord[];
      jobs.reverse();
    });
    expect(() => projectAdmissionV2ToRunDeclaration(reordered, ceremonyRaw())).not.toThrow();
  });

  it.each([
    'PAUSED',
    'non-firing hold schedule; create then immediate pause + PAUSED verification (manual)',
    'non-firing hold schedule; create then immediate pause + PAUSED-ish verification',
  ])('requires Team2 exact Scheduler creation guard, rejecting %s', (creationGuard) => {
    const raw = admissionWith((value) => {
      (value.scheduler as JsonRecord).creation_guard = creationGuard;
    });
    expect(() => projectAdmissionV2ToRunDeclaration(raw, ceremonyRaw())).toThrow(/creation_guard|Scheduler.*schema|contract/i);
  });

  it.each(Object.entries({
    node_env: 'development',
    enable_ai_fraud: 'true',
    enable_ai_reports: 'true',
    frontend_url: 'https://forged.example.test',
    use_mocks: 'true',
    enable_prod_network_anchoring: 'false',
    bitcoin_network: 'mainnet',
    bitcoin_utxo_provider: 'arbitrary-provider',
    kms_provider: 'local',
    gemini_tuned_model: 'projects/forged/locations/us-central1/endpoints/1',
    gemini_v6_prompt: 'true',
    gemini_tuned_response_schema: '{}',
  }))('rejects contradictory RIG-B1 critical_config.%s=%s', (field, contradictoryValue) => {
    const raw = admissionWith((value) => {
      (value.critical_config as JsonRecord)[field] = contradictoryValue;
    });
    expect(() => projectAdmissionV2ToRunDeclaration(raw, ceremonyRaw())).toThrow(/critical_config|live-chain|contract/i);
  });

  it('fixture carries Team2 complete exact RIG-B1 scheduler and critical config contracts', () => {
    const admission = JSON.parse(ADMISSION_RAW) as JsonRecord;
    const service = admission.cloud_run_service as string;
    expect((admission.scheduler as JsonRecord).jobs).toEqual(
      TEAM2_RIG_B1_SCHEDULER_SPECS.map(([suffix, path]) => ({ name: `${service}-${suffix}`, path })),
    );
    expect(admission.critical_config).toEqual(TEAM2_RIG_B1_CRITICAL_CONFIG);
  });

  it('rejects duplicate/cross-service Scheduler specs and non-PAUSED creation proof', () => {
    const duplicateName = admissionWith((value) => {
      const jobs = (value.scheduler as JsonRecord).jobs as JsonRecord[];
      jobs[1]!.name = jobs[0]!.name;
    });
    expect(() => projectAdmissionV2ToRunDeclaration(duplicateName, ceremonyRaw())).toThrow(/Scheduler.*duplicate/i);
    const duplicatePath = admissionWith((value) => {
      const jobs = (value.scheduler as JsonRecord).jobs as JsonRecord[];
      jobs[1]!.path = jobs[0]!.path;
    });
    expect(() => projectAdmissionV2ToRunDeclaration(duplicatePath, ceremonyRaw())).toThrow(/Scheduler.*duplicate/i);
    const crossService = admissionWith((value) => {
      const jobs = (value.scheduler as JsonRecord).jobs as JsonRecord[];
      jobs[0]!.name = 'unrelated-service-batch-anchors';
    });
    expect(() => projectAdmissionV2ToRunDeclaration(crossService, ceremonyRaw())).toThrow(/Scheduler.*service/i);
    const missingPaused = admissionWith((value) => {
      (value.scheduler as JsonRecord).creation_guard = 'created without a hold';
    });
    expect(() => projectAdmissionV2ToRunDeclaration(missingPaused, ceremonyRaw())).toThrow(
      /PAUSED.*verification|creation_guard/i,
    );
  });

  it('rejects caller identity rebinding and ceremony duration below the admission wall requirement', () => {
    expect(() => projectAdmissionV2ToRunDeclaration(ADMISSION_RAW, ceremonyRaw((value) => {
      value.gitHeadSha = 'd'.repeat(40);
    }))).toThrow(/ceremony.*schema|unrecognized|unknown/i);
    expect(() => projectAdmissionV2ToRunDeclaration(ADMISSION_RAW, ceremonyRaw((value) => {
      value.soakEndedAt = '2026-07-15T12:29:00.000Z';
    }))).toThrow(/admission.*wall|2910/i);
  });

  it('rejects non-UTC chronology and project refs outside the reviewed lowercase-only contract', () => {
    expect(() => projectAdmissionV2ToRunDeclaration(admissionWith((value) => {
      value.generated_at = '2026-07-13T11:59:00';
    }), ceremonyRaw())).toThrow(/RFC3339|timestamp|schema/i);
    expect(() => projectAdmissionV2ToRunDeclaration(ADMISSION_RAW, ceremonyRaw((value) => {
      value.soakStartedAt = '2026-07-13T12:00:00';
    }))).toThrow(/RFC3339|timestamp|schema/i);
    expect(() => projectAdmissionV2ToRunDeclaration(admissionWith((value) => {
      value.supabase_project_ref = 'abcdefghij1lmnopqrst';
    }), ceremonyRaw())).toThrow(/project|schema|rejected/i);
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
