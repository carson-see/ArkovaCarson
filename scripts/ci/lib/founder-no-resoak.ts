/** September 19 founder decision: drain the reviewed backlog without re-soaking.
 * Authority comes from the GitHub-resolved BASE commit, never PR-authored data.
 * This exception proves authorization, not completed observation or deployment.
 */
import { execFileSync } from 'node:child_process';

export const NO_RESOAK_DECISION_PATH = 'scripts/ci/snapshots/founder-no-resoak-2026-09-19.json';
const DECISION_ID = 'founder-no-resoak-2026-09-19';
const SHA = /^[a-f0-9]{40}$/;

interface DecisionInput {
  repository?: string;
  body: string;
  files: string[];
  headSha?: string;
  prNumber?: number;
  nowMs?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function loadNoResoakDecision(
  baseSha: string | undefined,
  readGit: (args: string[]) => string = (args) => execFileSync(
    process.env.GIT_BIN ?? '/usr/bin/git', args,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ),
): unknown {
  if (!baseSha || !SHA.test(baseSha)) return null;
  try {
    return JSON.parse(readGit(['show', `${baseSha}:${NO_RESOAK_DECISION_PATH}`]));
  } catch {
    return null;
  }
}

export function evaluateNoResoakDecision(
  raw: unknown, input: DecisionInput,
): { accepted: boolean; note?: string } {
  const reject = { accepted: false };
  const decision = record(raw);
  if (!decision || decision.id !== DECISION_ID
    || decision.repository !== 'carson-see/ArkovaCarson'
    || input.repository !== 'carson-see/ArkovaCarson'
    || decision.approved_by !== 'carson-see' || !nonempty(decision.authority)
    || !nonempty(decision.starts_at) || !nonempty(decision.expires_at)
    || !Array.isArray(decision.prs) || !input.headSha || !SHA.test(input.headSha)
    || !Number.isSafeInteger(input.prNumber)
    || input.files.includes(NO_RESOAK_DECISION_PATH)
    || !/^Founder no-resoak decision: founder-no-resoak-2026-09-19\s*$/m.test(input.body)) return reject;
  const start = Date.parse(decision.starts_at);
  const end = Date.parse(decision.expires_at);
  const now = input.nowMs ?? Date.now();
  if (![start, end, now].every(Number.isFinite) || start >= end || now < start || now >= end) return reject;
  const matches = decision.prs.map(record).filter((entry) => entry?.number === input.prNumber);
  if (matches.length !== 1) return reject;
  const entry = matches[0]!;
  if (entry.head_sha !== input.headSha || !Array.isArray(entry.existing_evidence)
    || entry.existing_evidence.length === 0 || !entry.existing_evidence.every(nonempty)
    || !nonempty(entry.residual_risk)) return reject;
  return {
    accepted: true,
    note: `FOUNDER NO-RESOAK EXCEPTION ${DECISION_ID}: PR #${input.prNumber} at ${input.headSha}. `
      + 'No new soak completion is asserted. Existing observations are retained; elapsed-time, '
      + 'continuity and changed-head re-soak requirements are waived by the founder for this reviewed head. '
      + `Residual risk: ${entry.residual_risk} All other CI, migration and deployment checks remain required.`,
  };
}
