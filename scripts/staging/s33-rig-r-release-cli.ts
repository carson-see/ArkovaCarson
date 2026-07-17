#!/usr/bin/env -S npx tsx
/** Live CLI for the exact post-Wave-3 RIG-R release soak. */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';
import {
  createS33RigRReleaseProductionAdapter,
  runS33RigRReleaseProduction,
  validateS33RigRReleaseAdmission,
} from './s33-rig-r-release-production-adapter';

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.length === 0) throw new Error(`RIG-R live release requires --${flag}.`);
  return value;
}

export function formatS33RigRError(error: unknown): string {
  const seen = new Set<object>();
  const lines: string[] = [];
  const visit = (value: unknown, path: string, depth: number): void => {
    const prefix = `${'  '.repeat(depth)}${path}: `;
    if (!(value instanceof Error)) {
      lines.push(`${prefix}${String(value)}`);
      return;
    }
    if (seen.has(value)) {
      lines.push(`${prefix}[circular ${value.name}]`);
      return;
    }
    seen.add(value);
    lines.push(`${prefix}${value.name}: ${value.message}`);
    if (value instanceof AggregateError) {
      value.errors.forEach((nested, index) => visit(nested, `errors[${index}]`, depth + 1));
    }
    if (value.cause !== undefined) visit(value.cause, 'cause', depth + 1);
  };
  visit(error, 'root', 0);
  return lines.join('\n');
}

export async function runS33RigRReleaseCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      admission: { type: 'string' },
      'provision-approval': { type: 'string' },
      'cto-confirmation': { type: 'string' },
      execute: { type: 'boolean', default: false },
    },
  });
  const admissionPath = required(values.admission, 'admission');
  const approvalPath = required(values['provision-approval'], 'provision-approval');
  const ctoConfirmation = required(values['cto-confirmation'], 'cto-confirmation');
  if (!values.execute
    || env.ARKOVA_LIVE_RIG_R_RELEASE_EXECUTION !== ctoConfirmation) {
    throw new Error(
      'RIG-R live release requires --execute and ARKOVA_LIVE_RIG_R_RELEASE_EXECUTION equal to the exact CTO approval/run/lease confirmation.',
    );
  }
  const [admissionRaw, approvalRaw] = await Promise.all([
    readFile(admissionPath, 'utf8'),
    readFile(approvalPath, 'utf8'),
  ]);
  const admission = validateS33RigRReleaseAdmission(
    parseJsonRejectingDuplicateKeys(admissionRaw, 'RIG-R admission'),
  );
  const adapter = createS33RigRReleaseProductionAdapter();
  const result = await runS33RigRReleaseProduction(
    admission,
    approvalRaw,
    ctoConfirmation,
    adapter,
  );
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    receiptId: result.receipt.receiptId,
    candidateHeadSha: result.receipt.candidateHeadSha,
    candidateTreeSha: result.receipt.candidateTreeSha,
    imageDigest: result.receipt.imageDigest,
    startedAt: result.receipt.startedAt,
    completedAt: result.harness.completedAt,
  })}\n`);
}

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runS33RigRReleaseCli().catch((error: unknown) => {
    console.error(`::error::RIG-R release failed:\n${formatS33RigRError(error)}`);
    process.exitCode = 1;
  });
}
