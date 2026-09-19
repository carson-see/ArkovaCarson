import { describe, expect, it } from 'vitest';
import { evaluateNoResoakDecision, loadNoResoakDecision, NO_RESOAK_DECISION_PATH } from './lib/founder-no-resoak';
import { check } from './check-staging-evidence';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const now = Date.parse('2026-09-19T13:00:00Z');
const decision = {
  id: 'founder-no-resoak-2026-09-19',
  repository: 'carson-see/ArkovaCarson',
  approved_by: 'carson-see',
  authority: 'Explicit founder instruction in task 01a0b9a3-e51d-7283-b8eb-d9562be64c43',
  starts_at: '2026-09-19T12:00:00Z',
  expires_at: '2026-09-26T12:00:00Z',
  prs: [{ number: 2841, head_sha: head, existing_evidence: ['historical receipt'], residual_risk: 'No new observation window; current delta reviewed separately.' }],
};
const body = 'Tier: T2\n## Staging Soak Evidence\nFounder no-resoak decision: founder-no-resoak-2026-09-19';
const input = { repository: 'carson-see/ArkovaCarson', body, files: ['services/worker/src/api/example.ts'], headSha: head, prNumber: 2841, nowMs: now };

describe('explicit September 19 founder no-resoak decision', () => {
  it('accepts only the listed exact head and states that no new soak is proved', () => {
    const result = evaluateNoResoakDecision(decision, input);
    expect(result.accepted).toBe(true);
    expect(result.note).toContain('No new soak completion is asserted');
  });
  it.each([
    { headSha: 'c'.repeat(40) }, { prNumber: 9999 }, { headSha: undefined },
    { body: 'Tier: T2' }, { nowMs: Date.parse(decision.expires_at) },
    { nowMs: Date.parse(decision.starts_at) - 1 }, { nowMs: Number.NaN },
    { repository: 'other/repo' }, { repository: undefined },
  ])('rejects changed head, unlisted PR, missing opt-in or invalid clock: %j', (delta) => {
    expect(evaluateNoResoakDecision(decision, { ...input, ...delta }).accepted).toBe(false);
  });
  it.each([null, {}, { ...decision, approved_by: 'someone-else' },
    { ...decision, expires_at: 'invalid' }, { ...decision, repository: 'other/repo' },
    { ...decision, prs: [{ ...decision.prs[0], existing_evidence: [] }] },
    { ...decision, prs: [{ ...decision.prs[0], residual_risk: '' }] },
  ])('rejects absent or incomplete authority: %j', (value) => {
    expect(evaluateNoResoakDecision(value, input).accepted).toBe(false);
  });
  it('rejects PR modifications to the authority snapshot', () => {
    expect(evaluateNoResoakDecision(decision, { ...input, files: [NO_RESOAK_DECISION_PATH] }).accepted).toBe(false);
  });
  it('loads authority only from the verified base commit, never the working tree', () => {
    const calls: string[][] = [];
    const loaded = loadNoResoakDecision(base, (args) => { calls.push(args); return JSON.stringify(decision); });
    expect(loaded).toEqual(decision);
    expect(calls).toEqual([['show', `${base}:${NO_RESOAK_DECISION_PATH}`]]);
    expect(loadNoResoakDecision('--bad-ref', () => { throw new Error('must not run'); })).toBeNull();
    expect(loadNoResoakDecision(base, () => { throw new Error('missing'); })).toBeNull();
    expect(loadNoResoakDecision(base, () => 'not json')).toBeNull();
  });
  it('integrates the explicit exception without accepting unlisted changes', () => {
    expect(check({ ...input, noResoakDecision: decision }).ok).toBe(true);
    expect(check({ ...input, noResoakDecision: decision, headSha: 'd'.repeat(40) }).ok).toBe(false);
  });
  it('still rejects an under-declared risk tier', () => {
    expect(check({ ...input, body: body.replace('T2', 'T1'), noResoakDecision: decision }).ok).toBe(false);
  });
});
