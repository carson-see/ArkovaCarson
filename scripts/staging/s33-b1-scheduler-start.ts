#!/usr/bin/env -S npx tsx
/** Operator CLI for the one exact CTO-authorized S3.3 RIG-B1 Scheduler start. */

import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { runS33B1SchedulerStartDriver } from './s33-b1-scheduler-start-driver';
import { createB1SchedulerStartProductionAdapter } from './s33-b1-scheduler-start-production-adapter';
import { runS33B1SoakSupervisor } from './s33-b1-soak-supervisor';
import { createB1SoakSupervisorProductionAdapter } from './s33-b1-soak-supervisor-production-adapter';

const MAX_INPUT_BYTES = 1024 * 1024;
type StartResult = Awaited<ReturnType<typeof runS33B1SchedulerStartDriver>>;
type SoakResult = Awaited<ReturnType<typeof runS33B1SoakSupervisor>>;

interface B1SchedulerStartCliDependencies {
  readonly readBoundedText: (path: string) => Promise<string>;
  readonly executeStart: (
    admissionRaw: string,
    preclockRaw: string,
    startAuthorityRaw: string,
    ctoConfirmation: string,
  ) => Promise<StartResult>;
  readonly supervise: (context: Readonly<{
    admissionRaw: string;
    provisionApprovalArtifactPath: string;
    receipt: StartResult['receipt'];
  }>, signal: AbortSignal) => Promise<SoakResult>;
}

function required(value: string | undefined, option: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`RIG-B1 Scheduler start requires --${option}.`);
  }
  return value;
}

async function readBoundedRegularFile(path: string): Promise<string> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_INPUT_BYTES) {
      throw new Error(`RIG-B1 start input ${path} must be a non-empty bounded regular file.`);
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function executeCli(
  argv: readonly string[],
  dependencies: B1SchedulerStartCliDependencies,
  signal: AbortSignal,
): Promise<SoakResult> {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      admission: { type: 'string' },
      preclock: { type: 'string' },
      'start-authority': { type: 'string' },
      'provision-approval-artifact': { type: 'string' },
      'cto-confirmation': { type: 'string' },
    },
  });
  const admissionPath = required(values.admission, 'admission');
  const preclockPath = required(values.preclock, 'preclock');
  const startAuthorityPath = required(values['start-authority'], 'start-authority');
  const provisionApprovalPath = required(
    values['provision-approval-artifact'],
    'provision-approval-artifact',
  );
  const ctoConfirmation = required(values['cto-confirmation'], 'cto-confirmation');
  const [admissionRaw, preclockRaw, startAuthorityRaw] = await Promise.all([
    dependencies.readBoundedText(admissionPath),
    dependencies.readBoundedText(preclockPath),
    dependencies.readBoundedText(startAuthorityPath),
    dependencies.readBoundedText(provisionApprovalPath),
  ]);
  const started = await dependencies.executeStart(
    admissionRaw,
    preclockRaw,
    startAuthorityRaw,
    ctoConfirmation,
  );
  return dependencies.supervise({
    admissionRaw,
    provisionApprovalArtifactPath: provisionApprovalPath,
    receipt: started.receipt,
  }, signal);
}

export async function runS33B1SchedulerStartCli(argv: readonly string[]): Promise<SoakResult> {
  const controller = new AbortController();
  const abortForSignal = (name: 'SIGINT' | 'SIGTERM') => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(`RIG-B1 foreground supervisor received ${name}.`));
    }
  };
  const onSigint = () => abortForSignal('SIGINT');
  const onSigterm = () => abortForSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    const port = createB1SchedulerStartProductionAdapter();
    return await executeCli(argv, {
      readBoundedText: readBoundedRegularFile,
      executeStart: (admission, preclock, startAuthority, confirmation) =>
        runS33B1SchedulerStartDriver(admission, preclock, startAuthority, confirmation, port),
      supervise: (context, signal) => runS33B1SoakSupervisor(
        context,
        createB1SoakSupervisorProductionAdapter(context),
        signal,
      ),
    }, controller.signal);
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

/** Test-only seam; production never accepts caller-supplied trust or cloud adapters. */
export function runS33B1SchedulerStartCliForTest(
  argv: readonly string[],
  dependencies: B1SchedulerStartCliDependencies,
  signal: AbortSignal = new AbortController().signal,
): Promise<SoakResult> {
  if (process.env.NODE_ENV !== 'test') throw new Error('Injected B1 Scheduler CLI dependencies are test-only.');
  return executeCli(argv, dependencies, signal);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runS33B1SchedulerStartCli(process.argv.slice(2)).then((result) => {
    // This is deliberately the only success output. The foreground supervisor
    // returns only after evidence closure, containment, and teardown.
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`ERROR: RIG-B1 Scheduler start failed: ${error instanceof Error ? error.message : 'unknown failure'}\n`);
    process.exitCode = 1;
  });
}
