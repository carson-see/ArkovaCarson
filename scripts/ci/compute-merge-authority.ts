#!/usr/bin/env -S npx tsx
/**
 * S0-4.3 — Tiered-merge authority computation.
 *
 * Carson holds sole merge authority for T2/T3 surfaces (migrations, RLS/schema,
 * chain/treasury, credits/billing, anchor lifecycle, security, public
 * API/contract, CLAUDE.md). A merge council (Tech Lead + RTE + Release Manager)
 * holds delegated T0/T1 merge. This computes the authority for a changeset by
 * REUSING the single battle-tested path→tier detector (`requiredTierFor` in
 * check-staging-evidence.ts) — no second detector to drift.
 *
 * Fail-closed: any error or unknown surface resolves to `needs-carson`.
 *
 * This is advisory/annotation tooling (it emits a GitHub Actions output +
 * notice). The enforcing control is branch protection + Mergify, which Carson
 * codifies per the drafted diff in
 * docs/runbooks/mergify-stacked-pr-playbook.md.
 */

import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { requiredTierFor, type Tier } from './check-staging-evidence.ts';
import { changedFiles } from './lib/ciContext.js';

export type MergeAuthority = 'council' | 'needs-carson';

export interface MergeAuthorityResult {
  authority: MergeAuthority;
  tier: Tier;
  reason: string;
}

export function mergeAuthorityFor(files: string[]): MergeAuthorityResult {
  try {
    const { tier, reason } = requiredTierFor(files);
    const authority: MergeAuthority = tier === 'T0' || tier === 'T1' ? 'council' : 'needs-carson';
    return { authority, tier, reason };
  } catch (err) {
    // Fail closed (pre-mortem P4): never silently grant council merge.
    return {
      authority: 'needs-carson',
      tier: 'T3',
      reason: `fail-closed: tier detection threw (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

function main(): void {
  const files = changedFiles();
  const { authority, tier, reason } = mergeAuthorityFor(files);

  console.log('## Tiered-merge authority (S0-4.3)');
  console.log(`- Changed files: ${files.length}`);
  console.log(`- Required tier: ${tier} (${reason})`);
  console.log(`- Merge authority: ${authority}`);

  // GitHub Actions output for downstream labeling / branch-protection wiring.
  if (process.env.GITHUB_OUTPUT) {
    try {
      appendFileSync(process.env.GITHUB_OUTPUT, `merge_authority=${authority}\ntier=${tier}\n`);
    } catch {
      /* non-fatal: output wiring is best-effort */
    }
  }

  if (authority === 'needs-carson') {
    console.log(
      `::notice title=Merge gate::This changeset is ${tier} and requires Carson's merge approval ` +
        '(CLAUDE.md §0 rule 1 / tiered-merge). The council may not merge it.',
    );
  } else {
    console.log(`::notice title=Merge gate::${tier} — council-mergeable per tiered-merge.`);
  }
  // Advisory: always exit 0. Enforcement is branch protection + Mergify.
}

const isDirectInvocation = (() => {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  return resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
})();

if (isDirectInvocation) main();
