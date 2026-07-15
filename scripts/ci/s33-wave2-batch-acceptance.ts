#!/usr/bin/env tsx
/** Offline CI entrypoint for trusted-main S3.3 Wave-2 corpus acceptance. */

import { constants, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acceptS33Wave2BatchCandidate,
  consumeMergedS33Wave2Batches,
  loadS33Wave2CandidateSnapshot,
  preflightS33Wave2BatchCandidate,
  type S33Wave2ReviewEvidence,
} from '../../services/worker/src/ai/eval/s33-wave2-batch-acceptance.js';
import { buildS33Wave2BaseCorpusRegistry } from '../../services/worker/src/ai/eval/s33-wave2-corpus-registry.js';
import { parseStrictJsonDocument } from '../../services/worker/src/ai/eval/s33-batch-acceptance.js';

type Command = 'consume-main' | 'preflight' | 'accept';

function usage(): never {
  throw new Error([
    'Usage:',
    '  s33-wave2-batch-acceptance.ts consume-main --trusted-main-root ROOT --trusted-main-head SHA --output FILE',
    '  s33-wave2-batch-acceptance.ts preflight --trusted-main-root ROOT --trusted-main-head SHA --candidate-repository ROOT --candidate-head SHA --output FILE',
    '  s33-wave2-batch-acceptance.ts accept --trusted-main-root ROOT --trusted-main-head SHA --candidate-repository ROOT --candidate-head SHA --review-evidence FILE --output FILE',
  ].join('\n'));
}

function parseArguments(argv: readonly string[]): Readonly<{ command: Command; options: ReadonlyMap<string, string> }> {
  const command = argv[0] as Command | undefined;
  if (!command || !['consume-main', 'preflight', 'accept'].includes(command)) usage();
  const options = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--') || options.has(flag)) usage();
    options.set(flag, value);
  }
  return { command, options };
}

function required(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) usage();
  return value;
}

/** Create evidence once, without following a target symlink or replacing an existing artifact. */
export function writeS33Wave2Evidence(outputPath: string, value: unknown): void {
  const absolute = isAbsolute(outputPath) ? outputPath : resolve(outputPath);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const realParent = realpathSync(dirname(absolute));
  const target = resolve(realParent, absolute.slice(dirname(absolute).length + 1));
  const fd = openSync(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`, undefined, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function runS33Wave2AcceptanceCli(argv: readonly string[]): unknown {
  const { command, options } = parseArguments(argv);
  const trustedMainRoot = realpathSync(required(options, '--trusted-main-root'));
  const trustedMainHead = required(options, '--trusted-main-head');
  const output = required(options, '--output');
  const baseRegistry = buildS33Wave2BaseCorpusRegistry({
    repositoryRoot: trustedMainRoot,
    verificationHeadSha: trustedMainHead,
  });
  const registry = consumeMergedS33Wave2Batches({
    trustedMainRepositoryRoot: trustedMainRoot,
    registry: baseRegistry,
  });
  if (command === 'consume-main') {
    writeS33Wave2Evidence(output, registry);
    return registry;
  }

  const candidateRepositoryRoot = realpathSync(required(options, '--candidate-repository'));
  const candidateHeadSha = required(options, '--candidate-head');
  const snapshot = loadS33Wave2CandidateSnapshot({
    trustedMainWorkerRoot: resolve(trustedMainRoot, 'services', 'worker'),
    candidateRepositoryRoot,
    candidateBaseSha: trustedMainHead,
    candidateHeadSha,
    registry,
  });
  const preflight = preflightS33Wave2BatchCandidate(registry, snapshot);
  if (command === 'preflight') {
    writeS33Wave2Evidence(output, preflight);
    return preflight;
  }

  const reviewPath = required(options, '--review-evidence');
  const review = parseStrictJsonDocument(
    readFileSync(reviewPath),
    'Wave-2 exact-head review evidence',
  ).parsed as unknown as S33Wave2ReviewEvidence;
  const acceptance = acceptS33Wave2BatchCandidate({
    registry,
    snapshot,
    review,
    acceptedEntryIds: preflight.manifest.entries.map(({ id }) => id),
  });
  writeS33Wave2Evidence(output, acceptance);
  return acceptance;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = runS33Wave2AcceptanceCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({
      ok: true,
      artifactType: (result as { artifactType?: unknown }).artifactType,
      digest: (result as { artifactDigestSha256?: unknown; registryDigestSha256?: unknown }).artifactDigestSha256
        ?? (result as { registryDigestSha256?: unknown }).registryDigestSha256,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
