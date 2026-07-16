import { describe, expect, it } from 'vitest';

import { B1_SCHEDULER_START_CONTRACT } from './s33-b1-scheduler-start-driver';
import {
  createB1SchedulerStartProductionAdapterForTest,
  type B1CommandRunner,
  type B1SchedulerProductionDependencies,
} from './s33-b1-scheduler-start-production-adapter';

interface TestBinding {
  readonly role: string;
  readonly members: readonly string[];
  readonly condition?: Readonly<{
    title: string;
    description?: string;
    expression: string;
  }>;
}

interface TestPolicy {
  readonly version?: number;
  readonly etag: string;
  readonly bindings: readonly TestBinding[];
}

interface IamHarnessOptions {
  readonly failWrite?: boolean;
  readonly ignoreWrite?: boolean;
  readonly mutateReadback?: (policy: TestPolicy) => TestPolicy;
}

const NOW = '2026-07-16T18:00:00.000Z';
const LEASE_EXPIRES = '2026-07-16T18:05:00.000Z';
const AUTHORITY_EXPIRES = '2026-07-16T18:10:00.000Z';
const APPROVAL_ID = 'approval-b1-001';
const MEMBER = `serviceAccount:${B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount}`;

function clonePolicy(policy: TestPolicy): TestPolicy {
  return structuredClone(policy);
}

function iamHarness(initial: TestPolicy, options: IamHarnessOptions = {}) {
  let policy = clonePolicy(initial);
  let writtenRaw = '';
  let writes = 0;
  const persisted: TestPolicy[] = [];
  const command: B1CommandRunner = {
    async run(_binary, args) {
      if (args[0] === 'run' && args[1] === 'services' && args[2] === 'get-iam-policy') {
        const observed = writes > 0 && options.mutateReadback !== undefined
          ? options.mutateReadback(clonePolicy(policy))
          : policy;
        return { status: 'ok', stdout: JSON.stringify(observed) };
      }
      if (args[0] === 'run' && args[1] === 'services' && args[2] === 'set-iam-policy') {
        if (options.failWrite === true) return { status: 'error', stdout: '' };
        writes += 1;
        const written = JSON.parse(writtenRaw) as TestPolicy;
        persisted.push(clonePolicy(written));
        if (options.ignoreWrite !== true) policy = clonePolicy(written);
        return { status: 'ok', stdout: JSON.stringify(policy) };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
  };
  const dependencies: B1SchedulerProductionDependencies = {
    command,
    now: () => new Date(NOW),
    makeTempDir: async () => '/tmp/arkova-b1-iam-test',
    writePrivateFile: async (_path, raw) => { writtenRaw = raw; },
    removeTempDir: async () => undefined,
    fetchHealth: async () => ({ status: 200, body: '{}' }),
  };
  return {
    port: createB1SchedulerStartProductionAdapterForTest(dependencies),
    persisted,
    writes: () => writes,
    policy: () => clonePolicy(policy),
  };
}

function emptyPolicy(): TestPolicy {
  return { version: 3, etag: 'etag-1', bindings: [] };
}

describe('RIG-B1 conditional Run Invoker lease', () => {
  it('installs one exact singleton binding and preserves the etag guard', async () => {
    const harness = iamHarness(emptyPolicy());
    await harness.port.installInvocationLease({
      approvalId: APPROVAL_ID,
      expiresAt: LEASE_EXPIRES,
      authorityExpiresAt: AUTHORITY_EXPIRES,
    });

    expect(harness.writes()).toBe(1);
    expect(harness.persisted[0]?.etag).toBe('etag-1');
    expect(harness.policy().bindings).toEqual([expect.objectContaining({
      role: 'roles/run.invoker',
      members: [MEMBER],
      condition: expect.objectContaining({
        expression: `request.time < timestamp("${LEASE_EXPIRES}")`,
      }),
    })]);
  });

  it('rejects a post-install readback with any additional scheduler Run Invoker membership', async () => {
    const harness = iamHarness(emptyPolicy(), {
      mutateReadback: (policy) => ({
        ...policy,
        bindings: [...policy.bindings, { role: 'roles/run.invoker', members: [MEMBER] }],
      }),
    });
    await expect(harness.port.installInvocationLease({
      approvalId: APPROVAL_ID,
      expiresAt: LEASE_EXPIRES,
      authorityExpiresAt: AUTHORITY_EXPIRES,
    })).rejects.toThrow(/only exact binding/i);
  });

  it('refuses to replace an existing stale or unconditional scheduler binding', async () => {
    const harness = iamHarness({
      version: 3,
      etag: 'etag-stale',
      bindings: [{ role: 'roles/run.invoker', members: [MEMBER] }],
    });
    await expect(harness.port.installInvocationLease({
      approvalId: APPROVAL_ID,
      expiresAt: LEASE_EXPIRES,
      authorityExpiresAt: AUTHORITY_EXPIRES,
    })).rejects.toThrow(/non-controller Run Invoker/i);
    expect(harness.writes()).toBe(0);
  });

  it('writes a shared binding whose array length is unchanged and retains only other members', async () => {
    const other = 'serviceAccount:other@example.iam.gserviceaccount.com';
    const harness = iamHarness({
      version: 3,
      etag: 'etag-shared',
      bindings: [{
        role: 'roles/run.invoker',
        members: [MEMBER, other],
        condition: {
          title: 'stale-controller-binding',
          expression: 'request.time < timestamp("2026-07-16T18:02:00.000Z")',
        },
      }],
    });
    await harness.port.removeInvocationLease(APPROVAL_ID);

    expect(harness.writes()).toBe(1);
    expect(harness.persisted[0]?.bindings).toEqual([expect.objectContaining({ members: [other] })]);
  });

  it('fails closed when the etag-guarded IAM update fails', async () => {
    const harness = iamHarness(emptyPolicy(), { failWrite: true });
    await expect(harness.port.installInvocationLease({
      approvalId: APPROVAL_ID,
      expiresAt: LEASE_EXPIRES,
      authorityExpiresAt: AUTHORITY_EXPIRES,
    })).rejects.toThrow(/etag-guarded/i);
  });

  it('rejects removal success unless the scheduler principal has zero Run Invoker memberships', async () => {
    const harness = iamHarness({
      version: 3,
      etag: 'etag-residual',
      bindings: [{ role: 'roles/run.invoker', members: [MEMBER] }],
    }, { ignoreWrite: true });
    await expect(harness.port.removeInvocationLease(APPROVAL_ID)).rejects.toThrow(/retains Run Invoker/i);
  });
});
