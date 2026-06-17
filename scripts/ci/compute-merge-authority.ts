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
 * codifies per the drafted diff in the "S0-E4 — Mergify / Stacked-PR +
 * Tiered-Merge Playbook" Google Doc (Drive: ARKOVA PI-1-S0):
 * https://docs.google.com/document/d/1iontJPUkhLQkQyZG4PETGuPj3kf23Kgn-1kDxqukfr8/edit
 */

import { appendFileSync } from 'node:fs';
import { requiredTierFor, type Tier } from './check-staging-evidence.ts';
import { changedFiles, isMainModule } from './lib/ciContext.js';

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

  // A real PR always changes at least one file. An empty set here almost always
  // means `git diff` failed (shallow checkout / unfetched base), not a genuine
  // no-op — so fail closed to needs-carson rather than reporting council via the
  // T0 default (pre-mortem P4 / review #3). The pure function keeps empty→T0 for
  // unit-test clarity; this CLI policy is the safety net around it.
  if (files.length === 0) {
    console.log('## Tiered-merge authority (S0-4.3)');
    console.log('- Changed files: 0 (could not determine — failing closed)');
    console.log('- Merge authority: needs-carson');
    console.log(
      '::notice title=Merge gate::Could not determine the changeset (empty git diff — ' +
        'shallow checkout or unfetched base). Failing closed to needs-carson.',
    );
    if (process.env.GITHUB_OUTPUT) {
      try {
        appendFileSync(process.env.GITHUB_OUTPUT, 'merge_authority=needs-carson\ntier=unknown\n');
      } catch {
        /* best-effort */
      }
    }
    return;
  }

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

if (isMainModule(import.meta.url, process.argv[1])) main();
