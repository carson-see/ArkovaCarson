import { describe, expect, it } from 'vitest';
import { check, requiredTierFor } from './check-staging-evidence.js';

// ───────────────────────────────────────────────────────────────────────────
// Evidence-gate integrity fixes (SCRUM-3481 / 3509 / 3533 / 3542 / 3549).
//
// Five independent ways the gate could be talked out of gating:
//   1. bolded field labels smuggled the CLOSING `**` into the captured value,
//      which switched every whole-value-anchored placeholder guard off;
//   2. `Approved by:` could name the PR author (or literally "me");
//   3. `packages/sdk` — the published TypeScript SDK — was absent from the SDK
//      PATH_RULE, so an SDK-only PR classified T0 and needed no evidence;
//   4. `head_binding: "roster"` was reachable from the NORMAL approved path,
//      not just deferred mode, so an approved manifest asserting real soak
//      coverage could merge an arbitrary post-soak head;
//   5. `rcPrBaseCovered` fell through to a bare `ancestry(prBase, current)`,
//      which every commit reachable from main satisfies.
//
// Lives in its own file rather than at the end of the 4.6k-line
// check-staging-evidence.test.ts so the five fixes stay legible as one set.
// ───────────────────────────────────────────────────────────────────────────

const HEAD = '1234567890abcdef1234567890abcdef12345678';
const BASE = 'abcdef1234567890abcdef1234567890abcdef12';
const T2_FILES = ['services/worker/src/api/v1/anchors.ts'];

const T2_FIELDS: Array<[string, string]> = [
  ['Tier:', 'T2'],
  ['Staging branch:', 'arkova-staging'],
  ['Worker revision:', 'arkova-worker-staging-00012-abc'],
  ['PR head SHA:', HEAD],
  ['Changed behavior:', 'fixture changed behavior under test'],
  ['Targeted evidence:', 'targeted fixture evidence exercised the changed behavior path'],
  [
    'Load/concurrency evidence:',
    'tests/load fixture exercised the changed behavior under high-concurrency users',
  ],
  ['Base SHA:', BASE],
  ['Staging project ref:', 'ujtlwnoqfhtitcmsnrpq'],
  ['Cloud Run service/tag URL:', 'https://pr-123---arkova-worker-staging.example.run.app'],
  ['Image digest:', 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'],
  ['Evidence scope:', 'merge-grade shared staging'],
  ['Preflight timestamp:', '2026-05-04 13:55 UTC'],
  ['Preflight result:', 'environment_type=clean_mirror'],
  ['Soak start:', '2026-05-04 14:00 UTC'],
  ['Soak end:', '2026-05-05 02:00 UTC'],
  ['E2E result:', '312/312 green'],
  ['Migration applied:', 'none'],
  ['Rollback rehearsed:', 'yes — applied + rolled back + re-applied'],
  ['Staging deploy log id:', '142'],
];

/** A complete, passing T2 evidence block; `bold` wraps the named labels in `**`. */
function t2Body(opts: { bold?: string[]; values?: Record<string, string> } = {}): string {
  const bold = new Set(opts.bold ?? []);
  const lines = T2_FIELDS.map(([label, value]) => {
    const v = opts.values?.[label] ?? value;
    return bold.has(label) ? `- **${label}** ${v}` : `- ${label} ${v}`;
  });
  return `## Staging Soak Evidence\n${lines.join('\n')}\n`;
}

const runT2 = (body: string, extra: Record<string, unknown> = {}) => check({
  body,
  files: T2_FILES,
  headSha: HEAD,
  baseSha: BASE,
  ...extra,
});

/**
 * A T2 body with a dirty preflight plus the `### Residual-risk note` that makes
 * a dirty preflight expressible. `approverLine` is written verbatim so a test
 * can bold, wrap or placeholder the `Approved by:` field.
 */
const residualRiskBody = (approverLine: string) => `${t2Body({
  values: { 'Preflight result:': 'environment_type=dirty' },
})}
### Residual-risk note
- Contamination type: leftover fixture rows from the previous soak
- Affected rows: 412 rows in staging.job_queue
- Impact on this PR: none — this PR does not read job_queue
- Reason not cleaned: the rig rebuild is queued behind an active soak
- ${approverLine}
`;

// ── DI-552 / SCRUM-3481 — markdown emphasis must not disable the guards ──
describe('markdown emphasis is stripped before the placeholder guards run', () => {
  it('control: the unbolded reference body passes', () => {
    const r = runT2(t2Body());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('control: bolding every label of an otherwise valid body still passes', () => {
    const r = runT2(t2Body({ bold: T2_FIELDS.map(([label]) => label) }));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('rejects a bolded label whose value is the TBD placeholder', () => {
    const r = runT2(t2Body({
      bold: ['Staging branch:'],
      values: { 'Staging branch:': 'TBD' },
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Staging branch:.*placeholder/i);
  });

  it('rejects a bolded deploy-artifact label whose value is N/A', () => {
    const r = runT2(t2Body({
      bold: ['Worker revision:'],
      values: { 'Worker revision:': 'N/A' },
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Worker revision:/i);
  });

  it('rejects a bolded label with no value at all (the `**` is not evidence)', () => {
    const r = runT2(t2Body({
      bold: ['Staging project ref:'],
      values: { 'Staging project ref:': '' },
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Staging project ref:.*empty value/i);
  });

  it('rejects a backtick-wrapped placeholder value', () => {
    const r = runT2(t2Body({ values: { 'Staging branch:': '`TBD`' } }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Staging branch:.*placeholder/i);
  });

  it('rejects an italic-wrapped placeholder value', () => {
    const r = runT2(t2Body({ values: { 'Staging branch:': '_pending_' } }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Staging branch:.*placeholder/i);
  });

  it('leaves a legitimate trailing underscore in a value intact', () => {
    const r = runT2(t2Body({ values: { 'Staging branch:': 'arkova_staging_' } }));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('rejects a bolded VALUE (as opposed to a bolded label)', () => {
    const r = runT2(t2Body({ values: { 'Staging branch:': '**TBD**' } }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Staging branch:.*placeholder/i);
  });

  it('rejects nested emphasis around a placeholder', () => {
    const r = runT2(t2Body({ values: { 'Staging branch:': '_**`TBD`**_' } }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Staging branch:.*placeholder/i);
  });

  it('treats a value that is nothing but emphasis markers as empty', () => {
    const r = runT2(t2Body({ values: { 'Staging branch:': '***' } }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Staging branch:.*empty value/i);
  });

  it('still rejects an all-underscore value (a one-sided run is never paired away)', () => {
    const r = runT2(t2Body({ values: { 'Staging branch:': '___' } }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Staging branch:.*placeholder/i);
  });

  it('handles a bolded label behind a checked task checkbox', () => {
    const body = t2Body().replace(
      '- Staging branch: arkova-staging',
      '- [x] **Staging branch:** TBD',
    );
    const r = runT2(body);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Staging branch:.*placeholder/i);
  });

  it('does not degrade on a pathological marker run (linear stripper)', () => {
    // Under a `/[*`]+$/`-style regex this value is quadratic; under the index
    // scanner it is linear. Correctness assertion only — the failure mode of a
    // quadratic implementation here is the suite timing out, not a wrong answer.
    const pathological = `${'*'.repeat(20000)}TBD${'*'.repeat(20000)}`;
    const r = runT2(t2Body({ values: { 'Staging branch:': pathological } }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Staging branch:.*placeholder/i);
  });

  it('rejects a bolded `Approved by:` placeholder inside a residual-risk note', () => {
    const r = runT2(residualRiskBody('**Approved by:** TBD'));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Approved by/i);
    expect(r.errors.join(' ')).toMatch(/must name a real approver/i);
  });

  it('control: the same note with a real bolded approver passes', () => {
    const r = runT2(residualRiskBody('**Approved by:** @some-reviewer'));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

// ── DI-552 / SCRUM-3481 — `Approved by:` must not resolve to the PR author ──
describe('residual-risk approver must be a non-author identity', () => {
  const noteBody = (approver: string) => residualRiskBody(`Approved by: ${approver}`);

  it('control: the note itself is otherwise accepted', () => {
    const r = runT2(noteBody('@some-reviewer'), { prAuthor: 'carson-see' });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('rejects an approver that is the PR author handle (@login)', () => {
    const r = runT2(noteBody('@carson-see'), { prAuthor: 'carson-see' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/self-approv/i);
  });

  it('rejects an approver that is the PR author handle (bare login)', () => {
    const r = runT2(noteBody('carson-see'), { prAuthor: 'carson-see' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/self-approv/i);
  });

  it('rejects an approver that is a self-reference word', () => {
    for (const approver of ['me', 'myself', 'self', 'the author', 'PR author']) {
      const r = runT2(noteBody(approver), { prAuthor: 'carson-see' });
      expect(r.ok, approver).toBe(false);
      expect(r.errors.join(' ')).toMatch(/self-approv/i);
    }
  });

  it('does not fire on a display name that merely shares a word with the author login', () => {
    const r = runT2(noteBody('Carson (founder / release owner) 2026-08-23'), {
      prAuthor: 'carson-see',
    });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('still rejects self-reference words when no PR author is known', () => {
    const r = runT2(noteBody('me'));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/self-approv/i);
  });
});

// ── DI-586 / SCRUM-3509 — packages/sdk is a public SDK contract surface ──
describe('PATH_RULES cover the published TypeScript SDK', () => {
  it('classifies packages/sdk source as T2', () => {
    expect(requiredTierFor(['packages/sdk/src/client.ts']).tier).toBe('T2');
  });

  it('classifies packages/sdk type declarations as T2', () => {
    expect(requiredTierFor(['packages/sdk/src/types.ts']).tier).toBe('T2');
  });

  it('keeps the existing SDK surfaces at T2', () => {
    expect(requiredTierFor(['packages/arkova-py/arkova/client.py']).tier).toBe('T2');
    expect(requiredTierFor(['packages/embed/src/widget.ts']).tier).toBe('T2');
    expect(requiredTierFor(['sdks/mcp-server/src/index.ts']).tier).toBe('T2');
  });

  it('keeps a packages/sdk manifest + lockfile bump at T0 (peripheral carve-out)', () => {
    expect(
      requiredTierFor(['packages/sdk/package.json', 'packages/sdk/package-lock.json']).tier,
    ).toBe('T0');
  });

  it('does NOT reclassify the zero-prod-runtime verifier packages (SCRUM-2341)', () => {
    expect(requiredTierFor(['packages/verifier/src/index.ts']).tier).toBe('T0');
    expect(requiredTierFor(['packages/verifier-cli/src/cli.ts']).tier).toBe('T0');
  });
});

// ── RC-manifest integrity (DI-594 / DI-595 / DI-596) ──
describe('RC manifest integrity', () => {
  const RC_PATH = 'docs/staging/rc-manifests/rc-2026-08-integrity.json';
  const TRAIN_LAUNCH = '1111111111111111111111111111111111111111';
  const PRE_LAUNCH = '0000000000000000000000000000000000000000';
  const CURRENT_BASE = '2222222222222222222222222222222222222222';
  const MID_BASE = '3333333333333333333333333333333333333333';
  const rcBody = `## Staging Soak Evidence
- Tier: T2
- RC manifest path: ${RC_PATH}
`;

  const includedPr = (overrides: Record<string, unknown> = {}) => ({
    number: 1737,
    head_sha: HEAD,
    base_sha: TRAIN_LAUNCH,
    risk_tier: 'T2',
    owner: 'L2',
    ci_summary: 'required checks green',
    rollback_note: 'revert PR',
    migration_files: [],
    ...overrides,
  });

  const manifest = (overrides: Record<string, unknown> = {}) => ({
    schema_version: 1,
    rc_id: 'RC-2026-08-integrity',
    created_at: '2026-07-28T14:57:46Z',
    created_by: 'RM agent',
    release_owner: 'Carson',
    approval_status: 'approved',
    approval_actor: 'Carson',
    approval_time: '2026-08-01T13:15:00Z',
    train_launch_sha: TRAIN_LAUNCH,
    target_main_sha: TRAIN_LAUNCH,
    allowed_base_shas: [TRAIN_LAUNCH],
    covered_main_shas: [TRAIN_LAUNCH],
    included_prs: [includedPr()],
    environment: {
      evidence_scope: 'merge-grade isolated staging',
      staging_api_base: 'https://integrity---arkova-soak.example.run.app',
      staging_url: 'https://integrity---arkova-soak.example.run.app',
      revision: 'arkova-worker-integrity-00004-qgj',
      deploy_tag: 'integrity',
      image_digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      supabase_project_ref: 'ujtlwnoqfhtitcmsnrpq',
      deploy_log_id: '30703316623',
      preflight_result: 'environment_type=clean_mirror',
    },
    soak: {
      start: '2026-07-28T19:43:55Z',
      end: '2026-07-31T19:43:55Z',
      duration_hours: 72,
      harness_version: 'arkova-soak-loadgen',
      result: 'PASS',
      evidence_links: ['https://github.com/carson-see/ArkovaCarson/actions/runs/1'],
      expires_at: '2026-08-15T19:43:55Z',
    },
    ...overrides,
  });

  const exception = () => ({
    id: 'founder-ruling-2026-08-01-no-interim-soaks',
    recorded_at: '2026-08-01T14:20:00Z',
    approver: 'Carson (founder / release owner)',
    expires_at: '2026-08-16T00:00:00Z',
    applies_to: [1737],
    text: 'No interim soaks; pen-test then week-long consolidated soak.',
  });

  // TRAIN_LAUNCH → MID_BASE → CURRENT_BASE is the only forward chain;
  // PRE_LAUNCH sits before the train launched.
  const order = [PRE_LAUNCH, TRAIN_LAUNCH, MID_BASE, CURRENT_BASE];
  const ancestryProvider = (ancestor: string, descendant: string): boolean | null => {
    const a = order.indexOf(ancestor.toLowerCase());
    const d = order.indexOf(descendant.toLowerCase());
    if (a === -1 || d === -1) return null;
    return a <= d;
  };

  const runRc = (
    rc: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => check({
    body: rcBody,
    files: T2_FILES,
    headSha: HEAD,
    baseSha: CURRENT_BASE,
    prNumber: 1737,
    nowMs: Date.parse('2026-08-01T18:00:00Z'),
    ancestryProvider,
    rcManifestLoader: () => JSON.stringify(rc),
    ...extra,
  });

  it('control: a clean approved manifest passes', () => {
    const r = runRc(manifest());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  // ── DI-594 / SCRUM-3533: roster head binding is gone ──
  it('rejects head_binding.mode="roster" on the normal approved path', () => {
    const r = runRc(manifest({
      head_binding: { mode: 'roster', exception_id: exception().id },
      exceptions: [exception()],
      included_prs: [includedPr({ head_sha: '9999999999999999999999999999999999999999' })],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/head_binding\.mode/i);
    expect(r.errors.join(' ')).toMatch(/roster/i);
    expect(r.notes.join(' ')).not.toMatch(/RECORDED HUMAN EXCEPTION/i);
  });

  it('rejects head_binding.mode="roster" in deferred-consolidated-soak mode too', () => {
    const r = runRc(
      manifest({
        soak_mode: 'deferred_consolidated_soak',
        approval_status: 'pending',
        head_binding: { mode: 'roster', exception_id: exception().id },
        exceptions: [exception()],
        included_prs: [includedPr({ head_sha: '9999999999999999999999999999999999999999' })],
      }),
      { deployWorkerPaused: true },
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/head_binding\.mode/i);
  });

  it('still accepts the explicit default head_binding.mode="exact"', () => {
    const r = runRc(manifest({ head_binding: { mode: 'exact' } }));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  // ── DI-595 / SCRUM-3542: a PR may not supply the manifest that authorizes it ──
  it('rejects a PR that also changes the RC manifest it cites', () => {
    const r = runRc(manifest(), { files: [...T2_FILES, RC_PATH] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/cannot both cite and modify/i);
  });

  // A manifest-ONLY PR stays T0 and never reaches the guard, deliberately:
  // it carries no prod-affecting change, so there is nothing for the manifest
  // to authorize and no evidence for it to produce. Making `docs/staging/
  // rc-manifests/` a soak-tier path instead would demand staging evidence for
  // every `docs(rc):` restamp and livelock the release train. Reviewer
  // independence for that PR is CODEOWNERS' job, not this script's.
  it('leaves a manifest-only PR at T0 (nothing to authorize, nothing to soak)', () => {
    expect(requiredTierFor([RC_PATH]).tier).toBe('T0');
    const r = runRc(manifest(), { files: [RC_PATH] });
    expect(r.ok).toBe(true);
    expect(r.notes.join(' ')).toMatch(/T0 CI-only/i);
  });

  it('leaves a PR that touches a DIFFERENT manifest alone', () => {
    const r = runRc(manifest(), {
      files: [...T2_FILES, 'docs/staging/rc-manifests/rc-some-other-train.json'],
    });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  // ── DI-596 / SCRUM-3549: per-entry base ancestry needs a lower bound ──
  it('rejects an entry whose base SHA predates the train launch', () => {
    const r = runRc(manifest({ included_prs: [includedPr({ base_sha: PRE_LAUNCH })] }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/base SHA/i);
  });

  it('accepts an entry whose base sits between the train launch and the current base', () => {
    const r = runRc(manifest({ included_prs: [includedPr({ base_sha: MID_BASE })] }));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('fails closed when the ancestry oracle cannot answer', () => {
    const r = runRc(
      manifest({ included_prs: [includedPr({ base_sha: MID_BASE })] }),
      { ancestryProvider: () => null },
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/base SHA/i);
  });
});
