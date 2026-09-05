import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Contract tests for `.claude/hooks/check-prod-migration-apply.sh`.
 *
 * The hook closes the gap CLAUDE.md §1.2 calls "knowingly unenforceable": the
 * Supabase MCP apply path had no PreToolUse matcher at all, which is what let
 * 0401/0402 (08-11), 0418/0419 (08-27) and 0425 (08-30) each red the whole PR
 * board. It is not "never apply before merge" — migrate-before-merge is a
 * required flow — it is the narrower same-motion rule the exemptions file
 * repeats: the apply and its exemption land together.
 *
 * These live under scripts/ so vitest's `scripts/**\/*.test.ts` glob picks them
 * up; `.claude/**` is not in any include glob, so a test placed next to the hook
 * would never run. A gate is only real if it is wired.
 */
const HOOK = '.claude/hooks/check-prod-migration-apply.sh';
const PROD = 'vzwyaatejekddvltxyye';

function invoke(
  payload: unknown,
  env: Record<string, string> = {},
): { decision: string; reason: string } {
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const out = (r.stdout ?? '').trim();
  if (!out) return { decision: 'allow', reason: '' };
  const parsed = JSON.parse(out);
  return {
    decision: parsed.hookSpecificOutput?.permissionDecision ?? 'allow',
    reason: parsed.hookSpecificOutput?.permissionDecisionReason ?? '',
  };
}

const apply = (project_id: string, name: string) => ({
  tool_name: 'mcp__1ae86eb5-9b90-481b-9355-7535904e24f3__apply_migration',
  tool_input: { project_id, name, query: 'SELECT 1;' },
});

describe('check-prod-migration-apply.sh — scope', () => {
  it('ignores tools that are not apply_migration', () => {
    expect(invoke({ tool_name: 'Bash', tool_input: { command: 'ls' } }).decision).toBe('allow');
  });

  it('ignores a staging / isolated rig, even for an unreconciled migration', () => {
    expect(invoke(apply('someIsolatedRigRef', '9999_brand_new')).decision).toBe('allow');
  });

  it('tolerates a malformed payload without blocking unrelated work', () => {
    const r = spawnSync('bash', [HOOK], { input: 'not json', encoding: 'utf8' });
    expect(r.status).toBe(0);
  });
});

describe('check-prod-migration-apply.sh — prod applies', () => {
  it('ALLOWS a prod apply whose source is already on origin/main', () => {
    // 0419 merged via #2355; its .sql is on main.
    expect(invoke(apply(PROD, '0419_sec_replay_v_slow_queries_relation_revoke')).decision).toBe(
      'allow',
    );
  });

  it('ALLOWS a prod apply whose prefix is already exempted — the same-motion rule satisfied', () => {
    const exempt = JSON.parse(
      readFileSync('scripts/ci/snapshots/ledger-numeric-exemptions.json', 'utf8'),
    ).exemptPrefixes as string[];
    // Guard the fixture: if the snapshot is empty this test would pass vacuously.
    expect(exempt.length).toBeGreaterThan(0);
    expect(invoke(apply(PROD, `${exempt[0]}_whatever_it_was`)).decision).toBe('allow');
  });

  it('DENIES the exact 0425 shape — prefix neither on main nor exempted', () => {
    const r = invoke(apply(PROD, '9999_applied_out_of_band'));
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('would create an orphan ledger row');
    expect(r.reason).toContain('SAME MOTION');
    expect(r.reason).toContain('ledger-numeric-exemptions.json');
  });

  it('DENIES a free-text migration name — that is how a row dodges §0 rule 10', () => {
    const r = invoke(apply(PROD, 'microsoft_graph_webhook_nonces'));
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('non-numeric migration name');
  });

  it('honors the explicit operator override', () => {
    expect(
      invoke(apply(PROD, '9999_applied_out_of_band'), {
        ARKOVA_ALLOW_UNRECONCILED_PROD_APPLY: '1',
      }).decision,
    ).toBe('allow');
  });

  it('names the remedy and the incident history in the denial, not just "blocked"', () => {
    const r = invoke(apply(PROD, '9999_applied_out_of_band'));
    for (const marker of ['0401/0402', '0418/0419', '0425', 'Mergify queue gate']) {
      expect(r.reason).toContain(marker);
    }
  });
});

describe('check-prod-migration-apply.sh — wiring (a gate is only real if it is wired)', () => {
  const settings = JSON.parse(readFileSync('.claude/settings.json', 'utf8'));

  it('is registered as a PreToolUse hook on a matcher that covers MCP apply_migration', () => {
    const pre = (settings.hooks?.PreToolUse ?? []) as Array<{
      matcher?: string;
      hooks?: Array<{ command?: string }>;
    }>;
    const rule = pre.find((r) =>
      (r.hooks ?? []).some((h) => (h.command ?? '').includes('check-prod-migration-apply.sh')),
    );
    expect(rule, 'hook is not referenced from .claude/settings.json').toBeDefined();
    // The matcher must actually match a real MCP tool name.
    const toolName = 'mcp__1ae86eb5-9b90-481b-9355-7535904e24f3__apply_migration';
    expect(new RegExp(rule!.matcher ?? '').test(toolName)).toBe(true);
  });

  it('pins PROD_REF to the same project ref migration-drift.yml audits', () => {
    const hook = readFileSync(HOOK, 'utf8');
    const wf = readFileSync('.github/workflows/migration-drift.yml', 'utf8');
    const hookRef = /ARKOVA_PROD_SUPABASE_REF:-([a-z0-9]+)/.exec(hook)?.[1];
    const wfRef = /SUPABASE_PROJECT_REF \|\| '([a-z0-9]+)'/.exec(wf)?.[1];
    expect(hookRef).toBeTruthy();
    expect(wfRef).toBeTruthy();
    expect(hookRef).toBe(wfRef);
  });
});
