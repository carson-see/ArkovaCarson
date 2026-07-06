#!/usr/bin/env node
/**
 * arkova-verify — standalone reference verifier CLI v0.1.
 *
 *   arkova-verify proof.json [--rpc <independent-node>] [options]
 *
 * Validates an Arkova proof packet with ZERO Arkova network calls:
 *   1. recompute the published root from the fingerprint + inclusion path
 *   2. confirm that root is committed in the network receipt, fetched from an
 *      INDEPENDENT node (Esplora/Blockstream, never Arkova)
 *   3. confirm the receipt is in a real block via a header from that node
 *   4. optionally verify the issuer signature against a published key
 *
 * Exit code 0 = VERIFIED, 1 = NOT VERIFIED, 2 = usage / input error.
 */

import { readFileSync } from 'node:fs';
import { createEsploraFetch } from '@arkova/verifier';
import { verifyProof } from './verify.js';
import { renderReport } from './lib/report.js';
import { assertIndependentEndpoint, DEFAULT_ESPLORA } from './lib/independent-endpoint.js';
import type { IndependentNode, ProofPacket, PublishedKeys, SignedProofBundle } from './types.js';

interface CliArgs {
  proofPath?: string;
  rpc: string;
  offline: boolean;
  keyPath?: string;
  json: boolean;
  help: boolean;
}

const HELP = `arkova-verify — Arkova reference verifier v0.1 (zero Arkova network calls)

Usage:
  arkova-verify <proof.json> [--rpc <url>] [--key <keys.json>] [--offline] [--json]

Arguments:
  <proof.json>          Path to an Arkova proof package (plain or signed bundle).

Options:
  --rpc <url>           Independent Esplora node for on-chain confirmation.
                        Default: ${DEFAULT_ESPLORA}. Must NOT be an Arkova host.
  --key <keys.json>     Path to a published-key file (docs.arkova.ai/keys.json
                        shape, or a raw PEM) to verify the issuer signature.
  --offline             Skip the on-chain confirmation (recompute-only). Honest:
                        the report states the on-chain step was not run.
  --json                Emit the machine-readable report as JSON.
  -h, --help            Show this help.

The verifier never contacts Arkova. The on-chain fact is confirmed against the
independent node you choose. The issuer signature, when checked, only proves
Arkova issued the package — it never substitutes for the recomputation.`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { rpc: DEFAULT_ESPLORA, offline: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--offline') args.offline = true;
    else if (a === '--json') args.json = true;
    else if (a === '--rpc') args.rpc = req(argv, ++i, '--rpc');
    else if (a === '--key') args.keyPath = req(argv, ++i, '--key');
    else if (a.startsWith('--rpc=')) args.rpc = a.slice('--rpc='.length);
    else if (a.startsWith('--key=')) args.keyPath = a.slice('--key='.length);
    else if (a.startsWith('-')) throw new UsageError(`Unknown option: ${a}`);
    else if (!args.proofPath) args.proofPath = a;
    else throw new UsageError(`Unexpected argument: ${a}`);
  }
  return args;
}

function req(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v == null) throw new UsageError(`${flag} requires a value`);
  return v;
}

class UsageError extends Error {}

/** Accept either a plain ProofPacket or a signed bundle wrapping one. */
function loadProof(path: string): { packet: ProofPacket; signedBundle?: SignedProofBundle } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new UsageError(`Could not read/parse proof file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed && typeof parsed === 'object' && 'payload' in parsed && 'signature' in parsed) {
    const bundle = parsed as SignedProofBundle;
    return { packet: bundle.payload as ProofPacket, signedBundle: bundle };
  }
  return { packet: parsed as ProofPacket };
}

/**
 * Load published key material from a keys.json file or a raw PEM.
 *  - keys.json with `keys[]` → a PublishedKeys SET: the bundle's signing_key_id
 *    is resolved against `keys[].kid` and an unresolvable id fails closed.
 *  - `{ pem }` or a raw PEM file → a single legacy key (no id resolution).
 */
function loadPublishedKeyMaterial(path: string): {
  publicKeyPem?: string;
  publishedKeys?: PublishedKeys;
} {
  const raw = readFileSync(path, 'utf8').trim();
  // Prefer JSON (keys.json shape) — a raw PEM is not valid JSON so this is a
  // clean discriminator. A bare PEM file falls through to the raw branch.
  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw) as {
        pem?: unknown;
        keys?: Array<{ kid?: unknown; alg?: unknown; pem?: unknown }>;
      };
      if (Array.isArray(obj.keys) && obj.keys.length > 0 && obj.keys.every((k) => typeof k?.pem === 'string')) {
        return {
          publishedKeys: {
            keys: obj.keys.map((k) => ({
              kid: typeof k.kid === 'string' ? k.kid : undefined,
              alg: typeof k.alg === 'string' ? k.alg : undefined,
              pem: k.pem as string,
            })),
          },
        };
      }
      if (typeof obj.pem === 'string') return { publicKeyPem: obj.pem };
    } catch {
      /* fall through to raw-PEM handling */
    }
    throw new UsageError(`Could not find a public key PEM in ${path}`);
  }
  if (raw.includes('BEGIN PUBLIC KEY')) return { publicKeyPem: raw };
  throw new UsageError(`Could not find a public key PEM in ${path}`);
}

export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${HELP}\n`);
    return 2;
  }

  if (args.help || !args.proofPath) {
    process.stdout.write(`${HELP}\n`);
    return args.help ? 0 : 2;
  }

  let packet: ProofPacket;
  let signedBundle: SignedProofBundle | undefined;
  let publicKeyPem: string | undefined;
  let publishedKeys: PublishedKeys | undefined;
  try {
    ({ packet, signedBundle } = loadProof(args.proofPath));
    if (args.keyPath) ({ publicKeyPem, publishedKeys } = loadPublishedKeyMaterial(args.keyPath));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  let chain: IndependentNode | undefined;
  if (!args.offline) {
    try {
      // Refuse an Arkova endpoint up front; the on-chain confirmation itself is
      // delegated to @arkova/verifier's createEsploraFetch + confirmInclusion.
      const url = assertIndependentEndpoint(args.rpc);
      chain = { label: url.hostname, fetch: createEsploraFetch(args.rpc) };
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }

  const report = await verifyProof(packet, { chain, signedBundle, publicKeyPem, publishedKeys });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReport(report)}\n`);
  }
  return report.ok ? 0 : 1;
}

// Only auto-run when invoked as a script (not when imported by tests).
const invokedDirectly =
  process.argv[1] != null && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`Unexpected error: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(2);
    },
  );
}
