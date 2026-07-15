#!/usr/bin/env tsx
/** Offline CLI for S3.3 Wave-3 unsigned requests and detached signatures. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStrictJsonDocument } from '../../services/worker/src/ai/eval/s33-batch-acceptance.js';
import {
  assembleS33DetachedAcceptanceEnvelopeV2,
  emitS33DetachedSigningRequestV2,
  verifyS33DetachedAcceptanceEnvelopeV2,
  type S33DetachedAcceptanceEnvelopeV2,
  type S33DetachedSigningRequestV2,
} from '../../services/worker/src/ai/eval/s33-wave3-detached-signing-v2.js';
import type {
  S33Wave2AcceptanceBindings,
  S33Wave2AcceptancePayloadInput,
} from '../../services/worker/src/ai/eval/s33-wave2-acceptance-envelope.js';
import { writeS33Wave2Evidence } from './s33-wave2-batch-acceptance.js';

type Command = 'emit-request' | 'assemble' | 'verify';
type CliResult = S33DetachedSigningRequestV2 | S33DetachedAcceptanceEnvelopeV2;

const COMMAND_FLAGS: Readonly<Record<Command, readonly string[]>> = Object.freeze({
  'emit-request': Object.freeze(['--payload-input', '--output']),
  assemble: Object.freeze(['--signing-request', '--signature', '--output']),
  verify: Object.freeze(['--acceptance-envelope', '--bindings', '--output']),
});

function usage(): never {
  throw new Error([
    'Usage:',
    '  s33-wave3-detached-signing-v2.ts emit-request --payload-input FILE --output FILE',
    '  s33-wave3-detached-signing-v2.ts assemble --signing-request FILE --signature FILE --output FILE',
    '  s33-wave3-detached-signing-v2.ts verify --acceptance-envelope FILE --bindings FILE --output FILE',
    'The CLI accepts no private-key or environment trust-root input.',
  ].join('\n'));
}

function parseArguments(argv: readonly string[]): Readonly<{
  command: Command;
  options: ReadonlyMap<string, string>;
}> {
  const command = argv[0] as Command | undefined;
  if (!command || !Object.hasOwn(COMMAND_FLAGS, command)) usage();
  const options = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--') || options.has(flag)) usage();
    options.set(flag, value);
  }
  const allowed = COMMAND_FLAGS[command];
  if (options.size !== allowed.length || allowed.some((flag) => !options.has(flag))
    || [...options.keys()].some((flag) => !allowed.includes(flag))) {
    usage();
  }
  return { command, options };
}

function required(options: ReadonlyMap<string, string>, flag: string): string {
  const value = options.get(flag);
  if (!value) usage();
  return value;
}

function readStrictJson(path: string, label: string): unknown {
  return parseStrictJsonDocument(readFileSync(resolve(path)), label).parsed;
}

function detachedSignature(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('S3.3 detached signature file must be an object');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'signatureBase64Url')
    || typeof record.signatureBase64Url !== 'string') {
    throw new Error('S3.3 detached signature file must contain only signatureBase64Url');
  }
  return record.signatureBase64Url;
}

export function runS33DetachedSigningCli(argv: readonly string[]): CliResult {
  const { command, options } = parseArguments(argv);
  const output = required(options, '--output');
  let result: CliResult;
  if (command === 'emit-request') {
    const input = readStrictJson(
      required(options, '--payload-input'),
      'S3.3 detached unsigned payload input',
    ) as S33Wave2AcceptancePayloadInput;
    result = emitS33DetachedSigningRequestV2(input);
  } else if (command === 'assemble') {
    const request = readStrictJson(
      required(options, '--signing-request'),
      'S3.3 detached signing request',
    );
    const signature = detachedSignature(readStrictJson(
      required(options, '--signature'),
      'S3.3 detached signature',
    ));
    result = assembleS33DetachedAcceptanceEnvelopeV2(request, signature);
  } else {
    const envelope = readStrictJson(
      required(options, '--acceptance-envelope'),
      'S3.3 detached acceptance envelope',
    );
    const bindings = readStrictJson(
      required(options, '--bindings'),
      'S3.3 detached caller bindings',
    ) as S33Wave2AcceptanceBindings;
    result = verifyS33DetachedAcceptanceEnvelopeV2(envelope, bindings);
  }
  writeS33Wave2Evidence(output, result);
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = runS33DetachedSigningCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({
      ok: true,
      artifactType: result.artifactType,
      digest: 'requestDigestSha256' in result
        ? result.requestDigestSha256
        : result.artifactDigestSha256,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
