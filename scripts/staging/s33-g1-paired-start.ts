#!/usr/bin/env -S npx tsx
/** Operator CLI for the exact CTO-authorized S3.3 RIG-G1 paired start. */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';
import { runS33G1PairedStartDriver, type S33G1PairedStartResult } from './s33-g1-paired-start-driver';
import { createS33G1ProductionPairedStartAdapter } from './s33-g1-paired-start-production-adapter';

interface S33G1PairedStartCliDependencies {
  readonly readText: (path: string) => Promise<string>;
  readonly execute: (
    admission: unknown,
    rawSignedApproval: string,
    ctoConfirmation: string,
  ) => Promise<S33G1PairedStartResult>;
}

function parseRequired(value: string | undefined, option: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`RIG-G1 paired start requires --${option}.`);
  }
  return value;
}

async function executeCli(
  argv: readonly string[],
  dependencies: S33G1PairedStartCliDependencies,
): Promise<S33G1PairedStartResult> {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      admission: { type: 'string' },
      approval: { type: 'string' },
      'cto-confirmation': { type: 'string' },
    },
  });
  const admissionPath = parseRequired(values.admission, 'admission');
  const approvalPath = parseRequired(values.approval, 'approval');
  const ctoConfirmation = parseRequired(values['cto-confirmation'], 'cto-confirmation');
  const [rawAdmission, rawSignedApproval] = await Promise.all([
    dependencies.readText(admissionPath),
    dependencies.readText(approvalPath),
  ]);
  if (rawSignedApproval.trim().length === 0) throw new Error('RIG-G1 signed approval envelope is empty.');
  const admission = parseJsonRejectingDuplicateKeys(rawAdmission, 'RIG-G1 paired-start admission');
  return dependencies.execute(admission, rawSignedApproval, ctoConfirmation);
}

export async function runS33G1PairedStartCli(argv: readonly string[]): Promise<S33G1PairedStartResult> {
  const port = createS33G1ProductionPairedStartAdapter();
  return executeCli(argv, {
    readText: (path) => readFile(path, 'utf8'),
    execute: (admission, approval, confirmation) =>
      runS33G1PairedStartDriver(admission, approval, confirmation, port),
  });
}

/** Test-only seam; no production caller may replace signed authority execution. */
export function runS33G1PairedStartCliForTest(
  argv: readonly string[],
  dependencies: S33G1PairedStartCliDependencies,
): Promise<S33G1PairedStartResult> {
  if (process.env.NODE_ENV !== 'test') throw new Error('Injected G1 paired-start CLI dependencies are test-only.');
  return executeCli(argv, dependencies);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runS33G1PairedStartCli(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    console.error(`::error::RIG-G1 paired start failed: ${error instanceof Error ? error.message : 'unknown failure'}`);
    process.exitCode = 1;
  });
}
