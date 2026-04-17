/**
 * NVI validators — entry point.
 *
 * Exposes a single `verifySources()` function that runs every applicable
 * validator over every source and returns a flat list of results. The
 * verification registry (verification-registry.ts) persists these to
 * `verification-status.json` so CI can block on staleness.
 */

import type { IntelligenceSource } from '../types';
import type { Validator, ValidateOpts, VerificationResult } from './types';
import { statuteQuoteValidator } from './statute-quote-validator';
import { caseLawValidator } from './case-law-validator';
import { agencyBulletinValidator } from './agency-bulletin-validator';
import { stateStatuteValidator } from './state-statute-validator';

export const ALL_VALIDATORS: Validator[] = [
  statuteQuoteValidator,
  caseLawValidator,
  agencyBulletinValidator,
  stateStatuteValidator,
];

export interface SourceVerification {
  sourceId: string;
  results: VerificationResult[];
  /** True iff at least one validator was applicable and every applicable one passed. */
  overallPassed: boolean;
  /** True iff any applicable validator returned hardFail. */
  overallHardFail: boolean;
  /** True iff NO validator claimed this source — it needs human routing. */
  orphaned: boolean;
}

export async function verifySource(
  source: IntelligenceSource,
  opts?: ValidateOpts,
): Promise<SourceVerification> {
  const results: VerificationResult[] = [];
  let anyApplicable = false;

  for (const v of ALL_VALIDATORS) {
    const app = v.isApplicable(source);
    if (!app.applicable) continue;
    anyApplicable = true;
    const result = await v.validate(source, opts);
    results.push(result);
  }

  const overallHardFail = results.some((r) => !r.passed && r.hardFail);
  const overallPassed = anyApplicable && results.every((r) => r.passed);
  return {
    sourceId: source.id,
    results,
    overallPassed,
    overallHardFail,
    orphaned: !anyApplicable,
  };
}

export async function verifySources(
  sources: IntelligenceSource[],
  opts?: ValidateOpts,
): Promise<SourceVerification[]> {
  const out: SourceVerification[] = [];
  for (const s of sources) out.push(await verifySource(s, opts));
  return out;
}

export { statuteQuoteValidator } from './statute-quote-validator';
export { caseLawValidator } from './case-law-validator';
export { agencyBulletinValidator } from './agency-bulletin-validator';
export { stateStatuteValidator } from './state-statute-validator';
export type { Validator, VerificationResult, ValidateOpts, Applicability } from './types';
