#!/usr/bin/env tsx
/**
 * NVI verify-sources CLI.
 *
 * Runs every applicable validator over every source in the FCRA / HIPAA /
 * FERPA source registries, then writes the combined verification status
 * to scripts/intelligence-dataset/verification-status.json.
 *
 * Usage:
 *   npx tsx scripts/intelligence-dataset/validators/verify-sources.ts
 *     [--regulation fcra|hipaa|ferpa|all]
 *     [--live]             # enable live HTTP HEAD checks
 *     [--out <path>]       # override registry path
 *     [--print-failures]   # stdout-dump per-source failure notes
 *     [--strict]           # exit non-zero if any hardFail or orphan
 *
 * The --strict flag is the knob CI uses (see NVI-18). Local runs without
 * --strict always succeed so developers can inspect progress.
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { IntelligenceSource } from '../types';
import { verifySources } from './index';
import {
  defaultRegistryPath,
  emptyRegistry,
  loadRegistry,
  saveRegistry,
  upsertVerifications,
} from './verification-registry';
import { FCRA_SOURCES } from '../sources/fcra-sources';
import { HIPAA_SOURCES } from '../sources/hipaa-sources';
import { FERPA_SOURCES } from '../sources/ferpa-sources';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Args {
  regulation: 'fcra' | 'hipaa' | 'ferpa' | 'all';
  live: boolean;
  out: string | null;
  printFailures: boolean;
  strict: boolean;
}

function parseArgs(argv: string[]): Args {
  const regIdx = argv.indexOf('--regulation');
  const outIdx = argv.indexOf('--out');
  const regulation = (regIdx >= 0 ? argv[regIdx + 1] : 'all') as Args['regulation'];
  const out = outIdx >= 0 ? argv[outIdx + 1] : null;
  return {
    regulation,
    live: argv.includes('--live'),
    out,
    printFailures: argv.includes('--print-failures'),
    strict: argv.includes('--strict'),
  };
}

function sourcesFor(reg: Args['regulation']): IntelligenceSource[] {
  switch (reg) {
    case 'fcra': return FCRA_SOURCES;
    case 'hipaa': return HIPAA_SOURCES;
    case 'ferpa': return FERPA_SOURCES;
    case 'all': return [...FCRA_SOURCES, ...HIPAA_SOURCES, ...FERPA_SOURCES];
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sources = sourcesFor(args.regulation);
  const registryPath = args.out
    ? resolve(process.cwd(), args.out)
    : defaultRegistryPath(resolve(__dirname, '..'));

  console.log(`\n🔎 NVI verify-sources`);
  console.log(`   regulation:    ${args.regulation}`);
  console.log(`   sources:       ${sources.length}`);
  console.log(`   live fetch:    ${args.live ? 'ON' : 'off'}`);
  console.log(`   registry:      ${registryPath}`);
  console.log(`   strict CI:     ${args.strict ? 'ON (exit non-zero on fail)' : 'off'}`);

  const now = new Date().toISOString();
  const verifications = await verifySources(sources, { live: args.live, now });

  const passed = verifications.filter((v) => v.overallPassed).length;
  const hardFails = verifications.filter((v) => v.overallHardFail);
  const orphans = verifications.filter((v) => v.orphaned);

  console.log(`\n📊 Results:`);
  console.log(`   passed:     ${passed}/${verifications.length}`);
  console.log(`   hardFails:  ${hardFails.length}`);
  console.log(`   orphans:    ${orphans.length}`);

  if (args.printFailures) {
    if (hardFails.length > 0) {
      console.log(`\n❌ Hard failures:`);
      for (const v of hardFails) {
        for (const r of v.results.filter((x) => !x.passed && x.hardFail)) {
          console.log(`   - ${v.sourceId} [${r.validator}]: ${r.notes}`);
        }
      }
    }
    if (orphans.length > 0) {
      console.log(`\n🚪 Orphans (no validator applicable):`);
      for (const v of orphans) console.log(`   - ${v.sourceId}`);
    }
  }

  // Merge with any existing registry so we don't wipe out sources from other regs.
  let reg = emptyRegistry();
  try {
    reg = loadRegistry(registryPath);
  } catch {
    // Starting fresh.
  }
  reg = upsertVerifications(reg, verifications, now);
  saveRegistry(registryPath, reg);
  console.log(`\n✅ Wrote registry with ${Object.keys(reg.sources).length} source entries.`);

  if (args.strict && (hardFails.length > 0 || orphans.length > 0)) {
    console.error(`\n💥 Strict mode: ${hardFails.length} hardFail + ${orphans.length} orphan — exiting 1`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
