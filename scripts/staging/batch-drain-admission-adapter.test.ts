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
const STAGING_AGENTS_RAW = readFileSync(
  join(process.cwd(), 'scripts/staging/agents.md'),
  'utf8',
);

const DECLARED_SOURCE_HEAD = 'a'.repeat(40);
const APPROVED_IMAGE_REPOSITORY =
  'us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker';
const APPROVED_SUPABASE_ORG_ID = 'byhkazrpmivhcsuqjtva';
const SOURCE_HEAD_IMAGE_REF =
  `${APPROVED_IMAGE_REPOSITORY}:${DECLARED_SOURCE_HEAD}`;
const SOURCE_HEAD_IMAGE_DIGEST = `sha256:${'b'.repeat(64)}`;
const STEP4_HEADING =
  '## Provision Step-4 Scheduler repair (PR #1492, L2-S2a-FIX, 2026-07-10)';
const ADMISSION_V2_HEADING =
  '## Isolated-rig admission v2 hardening (Lane 2 S3.3 readiness, 2026-07-13)';
const ADMISSION_ROLLBACK_HEADING =
  '## Admission rollback and identity pins (Team 2 review remediation, 2026-07-13)';
const BATCH_DRAIN_HEADING =
  '## Real batch-drain behavioral harness (#1417, 2026-07-07, Lane-1 chain)';
const TEAM1_ADMISSION_PROVENANCE_RULE =
  '- Team1 accepts Team2 admission v2 only for Supabase organization `byhkazrpmivhcsuqjtva`, with `source_head_image_ref` pinned to the exact full-SHA tag in `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker` and `source_head_image_digest` equal to both input and deployed image digests. The input and deployed image refs must also be digest pins in that exact approved repository. The committed RIG-B1 fixture mirrors that producer packet; missing, malformed, cross-project, cross-repository, stale-head, or digest-mismatched provenance fails closed.\n';

function markdownSection(raw: string, heading: string): string {
  const start = raw.indexOf(heading);
  if (start < 0) throw new Error(`Missing agents.md heading: ${heading}`);
  const next = raw.indexOf('\n## ', start + heading.length);
  return raw.slice(start, next < 0 ? undefined : next + 1);
}

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function occurrenceCount(raw: string, exact: string): number {
  return raw.split(exact).length - 1;
}

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

function exactTeam2AdmissionWith(mutator?: (value: JsonRecord) => void): string {
  return admissionWith((value) => {
    value.source_head_image_ref = SOURCE_HEAD_IMAGE_REF;
    value.source_head_image_digest = SOURCE_HEAD_IMAGE_DIGEST;
    value.supabase_org_id = APPROVED_SUPABASE_ORG_ID;
    mutator?.(value);
  });
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
  it('accepts the exact Team2 source-head image packet contract', () => {
    const raw = ADMISSION_RAW;
    expect(() => projectAdmissionV2ToRunDeclaration(raw, ceremonyRaw())).not.toThrow();
    expect(JSON.parse(raw)).toMatchObject({
      declared_source_head: DECLARED_SOURCE_HEAD,
      source_head_image_ref: SOURCE_HEAD_IMAGE_REF,
      source_head_image_digest: SOURCE_HEAD_IMAGE_DIGEST,
      image_digest: SOURCE_HEAD_IMAGE_DIGEST,
      deployed_image_digest: SOURCE_HEAD_IMAGE_DIGEST,
      supabase_org_id: APPROVED_SUPABASE_ORG_ID,
    });
  });

  it('requires the exact approved Team2 Supabase organization identity', () => {
    expect(() => projectAdmissionV2ToRunDeclaration(exactTeam2AdmissionWith((value) => {
      delete value.supabase_org_id;
    }), ceremonyRaw())).toThrow(/admission v2.*schema|rejected|Supabase.*org/i);
    expect(() => projectAdmissionV2ToRunDeclaration(exactTeam2AdmissionWith((value) => {
      value.supabase_org_id = 'foreignorganization';
    }), ceremonyRaw())).toThrow(/admission v2.*schema|rejected|Supabase.*org/i);
  });

  it.each([
    'source_head_image_ref',
    'source_head_image_digest',
  ])('requires Team2 source-head image field %s', (field) => {
    expect(() => projectAdmissionV2ToRunDeclaration(exactTeam2AdmissionWith((value) => {
      delete value[field];
    }), ceremonyRaw())).toThrow(/admission v2.*schema|rejected/i);
  });

  it.each([
    ['malformed source-head tag', (value: JsonRecord) => { value.source_head_image_ref = 'repo:not-a-full-sha'; }],
    ['digest-form source-head ref', (value: JsonRecord) => {
      value.source_head_image_ref = `repo@sha256:${'b'.repeat(64)}`;
    }],
    ['malformed source-head digest', (value: JsonRecord) => { value.source_head_image_digest = 'b'.repeat(64); }],
    ['source-head tag mismatch', (value: JsonRecord) => {
      value.source_head_image_ref = `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:${'d'.repeat(40)}`;
    }],
    ['source-head repository mismatch', (value: JsonRecord) => {
      value.source_head_image_ref = `us-central1-docker.pkg.dev/arkova1/other/arkova-worker:${DECLARED_SOURCE_HEAD}`;
    }],
    ['internally consistent foreign source/image repository', (value: JsonRecord) => {
      const foreignRepository = 'us-central1-docker.pkg.dev/foreign/other/arkova-worker';
      value.image = `${foreignRepository}@${SOURCE_HEAD_IMAGE_DIGEST}`;
      value.source_head_image_ref = `${foreignRepository}:${DECLARED_SOURCE_HEAD}`;
    }],
    ['foreign deployed image repository', (value: JsonRecord) => {
      value.deployed_image_ref = `us-central1-docker.pkg.dev/foreign/other/arkova-worker@${SOURCE_HEAD_IMAGE_DIGEST}`;
    }],
    ['source-head digest mismatch', (value: JsonRecord) => {
      value.source_head_image_digest = `sha256:${'d'.repeat(64)}`;
    }],
  ])('rejects %s', (_label, mutate) => {
    expect(() => projectAdmissionV2ToRunDeclaration(exactTeam2AdmissionWith(mutate), ceremonyRaw())).toThrow(
      /admission v2.*schema|rejected|source.head|image|digest|contradict/i,
    );
  });

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

describe('scripts/staging/agents.md Team1 + Team2 union contract', () => {
  it('retains every required heading exactly once and in lane-safe order', () => {
    const headings = STAGING_AGENTS_RAW.match(/^## .+$/gm) ?? [];
    expect(headings).toEqual([
      '## What lives here',
      '## Required env',
      '## Optional env',
      '## Seed tier matrix',
      '## Staging-only helper RPCs',
      '## Load harness modes',
      '## Workflow',
      '## S0-E4 isolated-rig automation (2026-06-17, story S0-4.1)',
      '## What this folder does NOT do',
      '## Provision Step-4 Scheduler repair (PR #1492, L2-S2a-FIX, 2026-07-10)',
      '## Isolated-rig admission v2 hardening (Lane 2 S3.3 readiness, 2026-07-13)',
      '## Admission rollback and identity pins (Team 2 review remediation, 2026-07-13)',
      '## Real batch-drain behavioral harness (#1417, 2026-07-07, Lane-1 chain)',
    ]);
    expect(new Set(headings).size).toBe(13);
  });

  it('preserves each authoritative Team2 section body exactly once', () => {
    const step4 = markdownSection(STAGING_AGENTS_RAW, STEP4_HEADING);
    const admissionV2 = markdownSection(STAGING_AGENTS_RAW, ADMISSION_V2_HEADING);
    const admissionRollback = markdownSection(STAGING_AGENTS_RAW, ADMISSION_ROLLBACK_HEADING);

    expect(sha256(step4)).toBe('f59687e0347c18d812aab0d5c34710b1b62579e4d4ad4f7f9168144ac37e7b73');
    expect(sha256(admissionV2)).toBe('b043efd46cf96c08423dccfabfef564fca7b964ed8a8ade723f6454e6d1453de');
    expect(sha256(admissionRollback)).toBe('7b833be979de8b493535800df5393e57ece6541523ed9e5eeaaeadd8766dc5c3');
    for (const [heading, section] of [
      [STEP4_HEADING, step4],
      [ADMISSION_V2_HEADING, admissionV2],
      [ADMISSION_ROLLBACK_HEADING, admissionRollback],
    ]) {
      expect(occurrenceCount(STAGING_AGENTS_RAW, heading)).toBe(1);
      expect(occurrenceCount(STAGING_AGENTS_RAW, section)).toBe(1);
    }
    expect(step4).toContain('SCHEDULER_JOB_SPECS');
    expect(step4).toContain('binding each job name independently to its exact request path');
    expect(admissionRollback).toContain('complete pause pass before a separate complete verification pass');
    expect(admissionRollback).toContain('pins RIG-B1 to Supabase org `byhkazrpmivhcsuqjtva`');
    expect(admissionRollback).toContain(
      'accepts images only from `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker`',
    );
    expect(STAGING_AGENTS_RAW).not.toContain('`SCHEDULER_JOBS` list');
    expect(STAGING_AGENTS_RAW).not.toContain('## Admission rollback and identity pins\n');
  });

  it('preserves exact Team1 f61 rules plus the one admission provenance rule', () => {
    const prefix = STAGING_AGENTS_RAW.slice(0, STAGING_AGENTS_RAW.indexOf(STEP4_HEADING));
    const batchDrain = markdownSection(STAGING_AGENTS_RAW, BATCH_DRAIN_HEADING);
    const provenanceOccurrences = occurrenceCount(batchDrain, TEAM1_ADMISSION_PROVENANCE_RULE);
    const f61BatchDrain = batchDrain.replace(TEAM1_ADMISSION_PROVENANCE_RULE, '');

    expect(sha256(prefix)).toBe('43343b72951ad7c5ecd756d9b0d1ce80818223479afadc57930eeb296f598202');
    expect(sha256(f61BatchDrain)).toBe('4128e8e460051d5d4a8677296d841d491ded72ba6e8e3c5652d17eefa04b7d49');
    expect(provenanceOccurrences).toBe(1);
    expect(batchDrain).toContain('S3.3 R3 acceptance extensions are split deliberately');
    expect(batchDrain).toContain('Team 1 review hardening keeps every chronology field');
    expect(batchDrain).toContain('batch-drain-admission-adapter.ts` is the only Team1 bridge');
  });
});
